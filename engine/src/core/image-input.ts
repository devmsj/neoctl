import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

// Input validation has no application-level byte/pixel ceiling. Tool-specific limits
// stay with their existing callers. Never transcode here: identities and cache bytes stay stable.
const verified = new Map<string, string>();
export function validateImageInput(data: string): { data: string; mimeType: string; size: number } {
  const raw = data.trim();
  const encoded = raw.replace(/^data:[^;,]+;base64,/iu, "").replace(/\s+/gu, "");
  if (!encoded || encoded.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) throw new Error("Invalid image base64");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64").replace(/=+$/u, "") !== encoded.replace(/=+$/u, "")) throw new Error("Invalid image base64");
  return { data: encoded, mimeType: validateImageBytes(bytes), size: bytes.length };
}

export function validateImageBytes(bytes: Buffer): string {
  const hash = createHash("sha256").update(bytes).digest("hex");
  const cached = verified.get(hash);
  if (cached) return cached;
  const mime = inspect(bytes);
  if (verified.size >= 256) verified.delete(verified.keys().next().value!);
  verified.set(hash, mime);
  return mime;
}
function invalid(reason: string): never { throw new Error(`Invalid image: ${reason}`); }
function inspect(b: Buffer): string {
  if (b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    if (b.length < 33 || b.readUInt32BE(8) !== 13 || b.toString("ascii",12,16) !== "IHDR") invalid("PNG header");
    const w=b.readUInt32BE(16), h=b.readUInt32BE(20), depth=b[24]!, color=b[25]!, interlace=b[28]!;
    const depths: Record<number, number[]>={0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]};
    if (!w || !h || !depths[color]?.includes(depth) || b[26] || b[27] || interlace>1) invalid("PNG dimensions/encoding");
    let p=8, ended=false; const chunks:Buffer[]=[];
    while(p+12<=b.length){
      const n=b.readUInt32BE(p), type=b.toString("ascii",p+4,p+8);
      if(p+12+n>b.length) invalid("truncated PNG chunk");
      if(crc32(b.subarray(p+4,p+8+n))!==b.readUInt32BE(p+8+n)) invalid("PNG checksum");
      if(type==="IDAT") chunks.push(b.subarray(p+8,p+8+n));
      if(type==="IEND"){ if(n)invalid("PNG end chunk"); ended=true; break; }
      p+=12+n;
    }
    if(!ended || !chunks.length)invalid("PNG image data/end missing");
    const channels=({0:1,2:3,3:1,4:2,6:4} as Record<number,number>)[color]!;
    const passes=interlace ? [[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]] : [[0,0,1,1]];
    const rows=passes.map(([x,y,dx,dy])=>({w:Math.max(0,Math.ceil((w-x!)/dx!)),h:Math.max(0,Math.ceil((h-y!)/dy!))})).filter(v=>v.w&&v.h);
    const expected=rows.reduce((n,r)=>n+(1+Math.ceil(r.w*channels*depth/8))*r.h,0);
    const raw=inflateSync(Buffer.concat(chunks), {maxOutputLength:expected+1});
    if(raw.length!==expected)invalid("PNG decoded length");
    let cursor=0; for(const r of rows){const stride=1+Math.ceil(r.w*channels*depth/8); for(let y=0;y<r.h;y++,cursor+=stride) if(raw[cursor]!>4)invalid("PNG scanline filter");}
    return "image/png";
  }
  if(b[0]===255 && b[1]===216){
    let p=2, frame=false, scan=false, end=false;
    while(p<b.length){
      if(b[p++]!==255)invalid("JPEG marker");
      while(b[p]===255)p++;
      const marker=b[p++];
      if(marker===217){end=true;break;}
      if(marker===1 || (marker!>=208&&marker!<=215))continue;
      if(p+2>b.length)invalid("truncated JPEG");
      const n=b.readUInt16BE(p); if(n<2||p+n>b.length)invalid("JPEG segment");
      if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker!)){
        if(n<8 || !b.readUInt16BE(p+3)||!b.readUInt16BE(p+5))invalid("JPEG frame"); frame=true;
      }
      p+=n;
      if(marker===218){scan=true; while(p<b.length){if(b[p]!==255){p++;continue;} if(b[p+1]===0 || (b[p+1]!>=208&&b[p+1]!<=215)){p+=2;continue;} break;}}
    }
    if(!frame||!scan||!end)invalid("JPEG frame/scan/end missing");
    return "image/jpeg";
  }
  if(b.toString("ascii",0,4)==="RIFF" && b.toString("ascii",8,12)==="WEBP"){
    if(b.length<20 || b.readUInt32LE(4)+8!==b.length)invalid("WebP container length");
    let p=12, pixels=false;
    while(p+8<=b.length){const type=b.toString("ascii",p,p+4), n=b.readUInt32LE(p+4); if(p+8+n>b.length)invalid("truncated WebP chunk");
      if(type==="VP8 "){if(n<10||!b.subarray(p+11,p+14).equals(Buffer.from([157,1,42]))||!(b.readUInt16LE(p+14)&16383)||!(b.readUInt16LE(p+16)&16383))invalid("WebP frame"); pixels=true;}
      if(type==="VP8L"){if(n<5||b[p+8]!==47)invalid("WebP lossless frame");pixels=true;}
      if(type==="ANMF"){if(n<24)invalid("WebP animation frame");pixels=true;}
      p+=8+n+(n%2);
    }
    if(!pixels || p!==b.length)invalid("WebP image data missing");return "image/webp";
  }
  if(["GIF87a","GIF89a"].includes(b.toString("ascii",0,6))){
    if(b.length<14 || !b.readUInt16LE(6)||!b.readUInt16LE(8))invalid("GIF header");
    let p=13+((b[10]!&128)?3*(2**((b[10]!&7)+1)):0), frames=0;
    const subblocks=()=>{while(p<b.length){const n=b[p++]!;if(!n)return;if(p+n>b.length)invalid("truncated GIF data");p+=n;}invalid("GIF terminator missing");};
    while(p<b.length){const tag=b[p++]; if(tag===59){if(!frames)invalid("GIF has no frames");return "image/gif";} if(tag===33){p++;subblocks();continue;} if(tag!==44||p+9>b.length)invalid("GIF frame"); if(!b.readUInt16LE(p+4)||!b.readUInt16LE(p+6))invalid("GIF dimensions"); const flags=b[p+8]!;p+=9+((flags&128)?3*(2**((flags&7)+1)):0); if(b[p]!<2||b[p]!>8)invalid("GIF LZW encoding");p++;subblocks();frames++;}
    invalid("GIF end missing");
  }
  invalid("unsupported or unrecognized content; use PNG, JPEG, WebP or GIF (convert BMP/SVG before model input)");
}
const crcTable=Array.from({length:256},(_,n)=>{let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
function crc32(b:Buffer):number{let c=0xffffffff;for(const v of b)c=crcTable[(c^v)&255]!^(c>>>8);return(c^0xffffffff)>>>0;}

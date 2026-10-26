import { deflateSync } from "node:zlib";
// Demo images use a real model-compatible raster, not SVG disguised as model pixels.
export function demoImage(number: number): Buffer {
  const width=960, height=540, raw=Buffer.alloc((width*3+1)*height);
  const accent=number%2?[221,116,174]:[115,203,213];
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const offset=y*(width*3+1)+1+x*3;
    const mountain=y>350+80*Math.sin(x/120+number), glow=Math.max(0,1-Math.hypot(x-760,y-120)/190)*.25;
    for(let c=0;c<3;c++)raw[offset+c]=Math.round(mountain?accent[c]!:[37,44,56][c]!*(1-glow)+accent[c]!*glow);
  }
  const crc=(b:Buffer)=>{let c=0xffffffff;for(const v of b){c^=v;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;}return(c^0xffffffff)>>>0;};
  const chunk=(name:string,data:Buffer)=>{const out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);out.write(name,4);data.copy(out,8);out.writeUInt32BE(crc(out.subarray(4,-4)),out.length-4);return out;};
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}

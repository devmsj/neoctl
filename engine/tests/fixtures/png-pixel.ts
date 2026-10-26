import { deflateSync } from "node:zlib";
export function pngPixel(value=0): Buffer {
  const crc=(b:Buffer)=>{let c=0xffffffff;for(const v of b){c^=v;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;}return(c^0xffffffff)>>>0;};
  const chunk=(type:string,data:Buffer)=>{const out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);out.write(type,4);data.copy(out,8);out.writeUInt32BE(crc(out.subarray(4,-4)),out.length-4);return out;};
  const hdr=Buffer.alloc(13);hdr.writeUInt32BE(1);hdr.writeUInt32BE(1,4);hdr[8]=8;hdr[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',hdr),chunk('IDAT',deflateSync(Buffer.from([0,value,20,30,255]))),chunk('IEND',Buffer.alloc(0))]);
}

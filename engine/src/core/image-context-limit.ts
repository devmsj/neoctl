import { validateImageInput } from "./image-input.js";

export const MAX_CONTEXT_IMAGE_DIMENSION = 3000;

/** Inspect validated image bytes, not the filename or caller-supplied MIME. */
export function imageContextWarning(data: string): string | undefined {
  const image = validateImageInput(data);
  const b = Buffer.from(image.data, "base64");
  let width = 0, height = 0;
  if (image.mimeType === "image/png") {
    width = b.readUInt32BE(16); height = b.readUInt32BE(20);
  } else if (image.mimeType === "image/gif") {
    width = b.readUInt16LE(6); height = b.readUInt16LE(8);
  } else if (image.mimeType === "image/jpeg") {
    let p = 2;
    while (p < b.length) {
      if (b[p++] !== 255) break;
      while (b[p] === 255) p++;
      const marker = b[p++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker! >= 208 && marker! <= 215)) continue;
      const length = b.readUInt16BE(p);
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker!)) {
        height = b.readUInt16BE(p + 3); width = b.readUInt16BE(p + 5); break;
      }
      p += length;
    }
  } else if (image.mimeType === "image/webp") {
    for (let p = 12; p + 8 <= b.length;) {
      const type = b.toString("ascii", p, p + 4), length = b.readUInt32LE(p + 4);
      if (type === "VP8X" && length >= 10) {
        width = b.readUIntLE(p + 12, 3) + 1; height = b.readUIntLE(p + 15, 3) + 1; break;
      }
      if (type === "VP8 " && length >= 10) {
        width = b.readUInt16LE(p + 14) & 16383; height = b.readUInt16LE(p + 16) & 16383; break;
      }
      if (type === "VP8L" && length >= 5) {
        const bits = b.readUInt32LE(p + 9);
        width = (bits & 16383) + 1; height = ((bits >>> 14) & 16383) + 1; break;
      }
      p += 8 + length + (length % 2);
    }
  }
  if (!width || !height) return "Warning: image dimensions could not be determined; pixels were not added to context. Convert to a supported image with verifiable dimensions before image_inspect.";
  if (width <= MAX_CONTEXT_IMAGE_DIMENSION && height <= MAX_CONTEXT_IMAGE_DIMENSION) return undefined;
  return `Warning: image dimensions ${width}×${height} exceed the ${MAX_CONTEXT_IMAGE_DIMENSION}-pixel limit on either edge; pixels were not added to context. Resize or split the image so each image has both width and height <= ${MAX_CONTEXT_IMAGE_DIMENSION}, then use image_inspect on the processed file(s).`;
}

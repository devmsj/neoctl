import { inflateSync } from "node:zlib";
import type { ImageWarning } from "./image-capabilities.js";

export interface ImageByteMetadata {
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
  /** Encoded alpha channel (PNG color type / WebP alpha flag); independent of pixel opacity. PNG tRNS is not a separate alpha channel. */
  hasAlphaChannel: boolean;
  /** True only when transparent pixels are confirmed; undefined means not decoded. */
  hasTransparentPixels?: boolean;
}

export function decodeImageBase64(value: string): Buffer {
  const base64 = value.replace(/^data:[^;,]+;base64,/u, "").replace(/\s+/gu, "");
  if (!base64 || base64.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(base64)) throw new Error("Image payload is not valid base64");
  if (base64.length > Math.ceil(50 * 1024 * 1024 / 3) * 4) throw new Error("Image exceeds the 50 MiB limit");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.toString("base64").replace(/=+$/u, "") !== base64.replace(/=+$/u, "")) throw new Error("Image payload is not canonical base64");
  if (bytes.length > 50 * 1024 * 1024) throw new Error("Image exceeds the 50 MiB limit");
  return bytes;
}

/** Inspect binary headers rather than trusting requested or returned MIME/size. */
export function inspectImageBytes(bytes: Buffer): ImageByteMetadata {
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    if (bytes.toString("ascii", 12, 16) !== "IHDR" || bytes.readUInt32BE(8) !== 13 || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28]! > 1) throw new Error("Invalid PNG IHDR");
    const allowedDepths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
    if (!allowedDepths[bytes[25]!]?.includes(bytes[24]!)) throw new Error("Invalid PNG color type or bit depth");
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    assertDimensions(width, height);
    let offset = 8, ended = false, transparency: Buffer | undefined;
    const idat: Buffer[] = [];
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset), type = bytes.toString("ascii", offset + 4, offset + 8);
      if (offset + 12 + length > bytes.length) throw new Error("Truncated PNG chunk");
      if (type === "IDAT") idat.push(bytes.subarray(offset + 8, offset + 8 + length));
      if (type === "tRNS") transparency = bytes.subarray(offset + 8, offset + 8 + length);
      if (type === "IEND") { ended = true; break; }
      offset += 12 + length;
    }
    if (!ended || !idat.length) throw new Error("PNG is missing image data or IEND");
    const color = bytes[25]!, depth = bytes[24]!, interlace = bytes[28]!;
    let hasTransparentPixels: boolean | undefined;
    if (![4, 6].includes(color) && !transparency) hasTransparentPixels = false;
    if (depth === 8 && interlace === 0) {
      const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[color];
      if (channels) {
        const stride = width * channels, expected = (stride + 1) * height;
        if (expected > 128 * 1024 * 1024) throw new Error("PNG decoded data exceeds verification limit");
        const raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expected + 1 });
        if (raw.length !== expected) throw new Error("PNG decoded data length is inconsistent with dimensions");
        let prev = Buffer.alloc(stride), row = Buffer.alloc(stride), found = false;
        for (let y = 0; y < height; y++) {
          const start = y * (stride + 1), filter = raw[start]!;
          if (filter > 4) throw new Error("Invalid PNG scanline filter");
          for (let x = 0; x < stride; x++) {
            const a = x >= channels ? row[x - channels]! : 0, b = prev[x]!, c = x >= channels ? prev[x - channels]! : 0;
            const prediction = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? Math.floor((a + b) / 2) : paeth(a, b, c);
            row[x] = (raw[start + 1 + x]! + prediction) & 255;
          }
          for (let x = 0; x < width; x++) {
            const p = x * channels;
            if ((color === 4 || color === 6) && row[p + channels - 1]! < 255) found = true;
            if (color === 3 && transparency && (transparency[row[p]!] ?? 255) < 255) found = true;
            if (color === 0 && transparency?.length === 2 && row[p] === transparency.readUInt16BE(0)) found = true;
            if (color === 2 && transparency?.length === 6 && row[p] === transparency.readUInt16BE(0) && row[p + 1] === transparency.readUInt16BE(2) && row[p + 2] === transparency.readUInt16BE(4)) found = true;
          }
          [prev, row] = [row, prev];
        }
        hasTransparentPixels = found;
      }
    }
    return { mimeType: "image/png", width, height, hasAlphaChannel: color === 4 || color === 6, hasTransparentPixels };
  }
  if (bytes.length > 4 && bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 4 < bytes.length) {
      if (bytes[offset++] !== 255) throw new Error("Invalid JPEG marker");
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++]!;
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) throw new Error("Truncated JPEG segment");
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
        if (length < 8) throw new Error("Invalid JPEG frame");
        const height = bytes.readUInt16BE(offset + 3), width = bytes.readUInt16BE(offset + 5);
        assertDimensions(width, height);
        if (bytes.lastIndexOf(Buffer.from([255, 217])) < offset) throw new Error("JPEG is missing end marker");
        return { mimeType: "image/jpeg", width, height, hasAlphaChannel: false, hasTransparentPixels: false };
      }
      offset += length;
    }
    throw new Error("JPEG is missing dimensions");
  }
  if (bytes.length >= 30 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    if (bytes.readUInt32LE(4) + 8 > bytes.length) throw new Error("Truncated WebP");
    const kind = bytes.toString("ascii", 12, 16);
    let width: number, height: number, alpha = false;
    if (kind === "VP8X") {
      width = bytes.readUIntLE(24, 3) + 1; height = bytes.readUIntLE(27, 3) + 1; alpha = Boolean(bytes[20]! & 16);
    } else if (kind === "VP8L" && bytes[20] === 47) {
      const bits = bytes.readUInt32LE(21); width = (bits & 16383) + 1; height = ((bits >>> 14) & 16383) + 1; alpha = Boolean(bits & (1 << 28));
    } else if (kind === "VP8 " && bytes.subarray(23, 26).equals(Buffer.from([157, 1, 42]))) {
      width = bytes.readUInt16LE(26) & 16383; height = bytes.readUInt16LE(28) & 16383;
    } else throw new Error("Unsupported WebP bitstream");
    assertDimensions(width, height);
    return { mimeType: "image/webp", width, height, hasAlphaChannel: alpha, hasTransparentPixels: alpha ? undefined : false };
  }
  throw new Error("Image bytes must contain a recognizable PNG, JPEG or WebP (not HTML, JSON, GIF or SVG)");
}

function assertDimensions(width: number, height: number): void {
  if (!width || !height || width * height > 40_000_000) throw new Error("Image dimensions are invalid or exceed the 40 megapixel verification limit");
}
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function outputWarnings(input: Record<string, unknown>, response: Record<string, unknown>, images: ImageByteMetadata[]): ImageWarning[] {
  const warnings: ImageWarning[] = [];
  const mismatch = (code: string, field: string, requested: unknown, actual: unknown, message: string) => warnings.push({ code, field, requested, actual, message, remedy: "Use the actual output values when reporting results. Do not claim the requested setting was honored. Inspect the image or use a verified upstream if exact compliance is required." });
  if (images.length !== input.n) mismatch("COUNT_MISMATCH", "n", input.n, images.length, "The upstream returned a different number of usable images.");
  for (const [field, apiField] of [["model", "model"], ["quality", "quality"], ["background", "background"]]) {
    const actual = response[apiField!];
    if (actual !== undefined && actual !== null && input[field!] !== "auto" && actual !== input[field!]) {
      mismatch("UPSTREAM_" + field!.toUpperCase() + "_MISMATCH", field!, input[field!], actual, `The upstream reported a different ${field}. For quality this is a metadata discrepancy, not proof of internal compute reduction; mapping or dynamic behavior may differ.`);
      if (field === "quality") warnings[warnings.length - 1]!.remedy = "Report requested and upstream-reported tiers separately. Do not infer an internal downgrade, budget ceiling, or documented dynamic mapping from this discrepancy alone.";
    }
  }
  if ((typeof response.model !== "string" || !response.model.trim())) warnings.push({ code: "MODEL_UNVERIFIED", field: "model", requested: input.model, message: "The response does not identify its model. The requested routing ID is known, but the actual upstream model cannot be independently confirmed." });
  if ((typeof response.quality !== "string" || !response.quality.trim()) && input.quality !== "auto") warnings.push({ code: "QUALITY_UNVERIFIED", field: "quality", requested: input.quality, message: "The response does not report a quality tier; request acceptance alone does not verify that the tier was applied." });
  images.forEach((image, i) => {
    const size = `${image.width}x${image.height}`, format = image.mimeType.slice(6);
    if (input.size !== "auto" && input.size !== size) mismatch("SIZE_MISMATCH", `images[${i}].size`, input.size, size, "Decoded dimensions differ from the requested size. The image was not silently resized locally.");
    if (format !== input.outputFormat) mismatch("FORMAT_MISMATCH", `images[${i}].outputFormat`, input.outputFormat, format, "Actual image format differs from the request. MIME type and file extension follow the actual bytes.");
    if (response.size !== undefined && response.size !== size) mismatch("METADATA_SIZE_MISMATCH", `images[${i}].size`, response.size, size, "Upstream size metadata disagrees with the image bytes.");
    if (response.output_format !== undefined && response.output_format !== format) mismatch("METADATA_FORMAT_MISMATCH", `images[${i}].outputFormat`, response.output_format, format, "Upstream format metadata disagrees with the image bytes.");
    if (input.background === "transparent" && image.hasTransparentPixels === false) mismatch("TRANSPARENCY_MISMATCH", `images[${i}].background`, "transparent", "opaque", "No transparent pixels were found; a painted checkerboard is not transparency.");
    if (input.background === "opaque" && image.hasTransparentPixels === true) mismatch("TRANSPARENCY_MISMATCH", `images[${i}].background`, "opaque", "transparent", "Transparent pixels were found despite an opaque request.");
    if (input.background === "transparent" && image.hasTransparentPixels === undefined) warnings.push({ code: "TRANSPARENCY_UNVERIFIED", field: `images[${i}].background`, message: "The format may support alpha, but transparent pixels have not been decoded/verified. Do not promise a transparent asset without checking it." });
  });
  return warnings;
}

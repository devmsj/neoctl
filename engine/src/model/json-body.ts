import { randomUUID } from "node:crypto";
import { openAsBlob } from "node:fs";
import type { PayloadRefs } from "../core/image-payload-refs.js";

const SPLICE_MIN_LENGTH = 64 * 1024;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/u;

/**
 * Byte-identical to `JSON.stringify(value)` encoded as UTF-8, but returned as a Blob. Large base64
 * strings (image payloads) are spliced in as separate parts, so a request never materializes one giant
 * JSON string (V8 stores it two-byte as soon as any non-Latin-1 text is present) plus a second encoded
 * copy. Markers from `refs` are replaced by lazily read file-backed Blobs of verified stored base64
 * payloads, so those bytes are streamed from disk during upload and never enter the heap. Base64 needs
 * no JSON escaping, so both splices are exact. fetch streams Blob bodies with a known Content-Length.
 */
export async function jsonBody(value: unknown, refs?: PayloadRefs): Promise<Blob> {
  const spliced: string[] = [];
  const marker = `neo-json-splice-${randomUUID()}-`;
  const skeleton = JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "string" && item.length >= SPLICE_MIN_LENGTH && BASE64.test(item)) {
      spliced.push(item);
      return `${marker}${spliced.length - 1}`;
    }
    return item;
  });
  if (skeleton === undefined) throw new TypeError("Request body is not JSON-serializable");
  const fileRefs = refs?.files.length ? refs : undefined;
  if (!spliced.length && !fileRefs) return new Blob([skeleton]);
  const alternatives = [`"${marker}(\\d+)"`, ...(fileRefs ? [`${fileRefs.prefix}(\\d+)`] : [])];
  const parts: (string | Blob)[] = [];
  let cursor = 0;
  for (const match of skeleton.matchAll(new RegExp(alternatives.join("|"), "gu"))) {
    parts.push(skeleton.slice(cursor, match.index));
    if (match[1] !== undefined) parts.push("\"", spliced[Number(match[1])]!, "\"");
    else parts.push(await storedPayloadBlob(fileRefs!.files[Number(match[2])]!));
    cursor = match.index! + match[0].length;
  }
  parts.push(skeleton.slice(cursor));
  return new Blob(parts);
}

async function storedPayloadBlob(file: { path: string; size: number }): Promise<Blob> {
  const blob = await openAsBlob(file.path);
  if (blob.size !== file.size) throw new Error(`Stored image payload changed before sending: ${file.path}`);
  return blob;
}

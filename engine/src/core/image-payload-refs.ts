import { randomUUID } from "node:crypto";

/**
 * Collects verified stored image files referenced by one outgoing request. While a request is being
 * mapped inside withPayloadRefs(), stored canonical image payloads are emitted as unique markers instead
 * of being read into memory; jsonBody() later replaces each marker with a lazily read file-backed Blob.
 */
export class PayloadRefs {
  readonly prefix = `neo-payload-ref-${randomUUID()}-`;
  readonly files: { path: string; size: number }[] = [];

  marker(path: string, size: number): string {
    this.files.push({ path, size });
    return `${this.prefix}${this.files.length - 1}`;
  }
}

let active: PayloadRefs | undefined;

/** Runs a synchronous request mapper with file references enabled. The result must go to jsonBody(value, refs). */
export function withPayloadRefs<T>(refs: PayloadRefs, build: () => T): T {
  const previous = active;
  active = refs;
  try {
    return build();
  } finally {
    active = previous;
  }
}

export function activePayloadRefs(): PayloadRefs | undefined {
  return active;
}

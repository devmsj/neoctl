export interface SSEEvent {
  event?: string;
  data: unknown;
}

export async function* decodeSSE(
  stream: ReadableStream<Uint8Array>,
  idleTimeoutMs = 120000,
): AsyncGenerator<SSEEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const result = await readWithIdleTimeout(reader, idleTimeoutMs);
    if (result.done) break;
    buffer += decoder.decode(result.value, { stream: true });

    while (true) {
      const index = firstFrameBoundary(buffer);
      if (index < 0) break;
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(buffer[index] === "\r" ? index + 4 : index + 2);
      const event = parseFrame(frame);
      if (!event) continue;
      if (event.data === "[DONE]") return;
      yield event;
    }
  }

  const tail = buffer.trim();
  if (tail) {
    const event = parseFrame(tail);
    if (event && event.data !== "[DONE]") yield event;
  }
}

function firstFrameBoundary(buffer: string): number {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf < 0) return crlf;
  if (crlf < 0) return lf;
  return Math.min(lf, crlf);
}

function parseFrame(frame: string): SSEEvent | undefined {
  let eventName: string | undefined;
  const dataLines: string[] = [];

  for (const rawLine of frame.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) eventName = line.slice("event:".length).trim();
    if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trimStart());
  }

  if (dataLines.length === 0) return undefined;
  const rawData = dataLines.join("\n");
  if (rawData === "[DONE]") return { event: eventName, data: rawData };
  try {
    return { event: eventName, data: JSON.parse(rawData) };
  } catch {
    return { event: eventName, data: rawData };
  }
}

async function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`SSE stream idle for ${idleTimeoutMs}ms`)), idleTimeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

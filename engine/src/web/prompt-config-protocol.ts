import type { IncomingMessage, ServerResponse } from "node:http";
import { MAX_SYSTEM_PROMPT_BYTES, PromptConfigError, PromptConfigStore } from "../context/prompt-config.js";

/** Global endpoint: deliberately independent of session routing and client-selected paths. */
export async function handlePromptConfigRequest(req: IncomingMessage, res: ServerResponse, store = new PromptConfigStore()): Promise<void> {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const send = (status: number, body: unknown) => { res.statusCode = status; res.end(JSON.stringify(body)); };
  try {
    const url = new URL(req.url ?? "/api/prompt-config", "http://localhost");
    if (["path", "filePath", "homeDir", "version"].some((key) => url.searchParams.has(key))) {
      throw new PromptConfigError("PROMPT_CONFIG_INVALID", "Prompt configuration paths and versions cannot be selected by clients.", 400);
    }
    if (req.method === "GET") { send(200, await store.read()); return; }
    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      send(405, { errorCode: "PROMPT_CONFIG_METHOD_NOT_ALLOWED", error: "Use GET or POST." });
      return;
    }
    const body = await readPromptBody(req);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => key !== "content" && key !== "revision")) {
      throw new PromptConfigError("PROMPT_CONFIG_INVALID", "Expected only content and revision fields.", 400);
    }
    const { content, revision } = body as Record<string, unknown>;
    send(200, { ok: true, ...await store.save(content, revision) });
  } catch (error) {
    if (error instanceof PromptConfigError) send(error.status, { errorCode: error.errorCode, error: error.message });
    else send(500, { errorCode: "PROMPT_CONFIG_STORAGE_ERROR", error: "Unable to read or save the system prompt configuration." });
  }
}

async function readPromptBody(req: IncomingMessage): Promise<unknown> {
  // JSON may encode each ASCII character as six bytes (\\uXXXX).
  const limit = MAX_SYSTEM_PROMPT_BYTES * 6 + 1024;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size <= limit) chunks.push(buffer);
    else chunks.length = 0; // Drain the request without retaining an unbounded payload.
  }
  if (size > limit) throw new PromptConfigError("PROMPT_CONFIG_TOO_LARGE", "Prompt configuration request is too large.", 413);
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new PromptConfigError("PROMPT_CONFIG_INVALID", "Request body must be valid JSON.", 400); }
}

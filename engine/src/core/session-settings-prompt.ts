import { createHash } from "node:crypto";
import type { RuntimeContext } from "../context/context-manager.js";
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY, splitSystemPromptPrefix } from "../context/prompts.js";

export const MAX_SESSION_PROMPT_CHARS = 256 * 1024;

/** Durable desired state. A queued change resumes as active after a process interruption. */
export interface SessionPromptState {
  content: string | null;
  revision: string;
}

export interface SessionPromptSnapshot {
  content: string;
  override: boolean;
  revision: string;
}

export type SessionPromptUpdate = { content: string; revision: string; reset?: never }
  | { reset: true; revision: string; content?: never };

export interface SessionPromptUpdateResult extends SessionPromptSnapshot {
  ok: true;
  deferred: boolean;
}

export class SessionPromptError extends Error {
  constructor(message: string, readonly statusCode: 400 | 409) {
    super(message);
    this.name = "SessionPromptError";
  }
}

export function parseSessionPromptUpdate(value: unknown): SessionPromptUpdate {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SessionPromptError("session prompt update must be an object", 400);
  }
  const body = value as Record<string, unknown>;
  if (typeof body.revision !== "string" || !body.revision.trim() || body.revision.length > 256) {
    throw new SessionPromptError("a valid session prompt revision is required", 400);
  }
  if (Object.keys(body).some((key) => !["content", "reset", "revision"].includes(key))) {
    throw new SessionPromptError("unknown session prompt update field", 400);
  }
  if (body.reset === true && !Object.hasOwn(body, "content")) return { reset: true, revision: body.revision };
  if (Object.hasOwn(body, "reset") || typeof body.content !== "string") {
    throw new SessionPromptError("provide either content or reset:true", 400);
  }
  validateSessionPromptContent(body.content);
  return { content: body.content, revision: body.revision };
}

export function validateSessionPromptContent(content: string): void {
  if (!content.trim()) throw new SessionPromptError("session prompt content must not be empty", 400);
  if (content.length > MAX_SESSION_PROMPT_CHARS) {
    throw new SessionPromptError(`session prompt exceeds ${MAX_SESSION_PROMPT_CHARS} characters`, 400);
  }
  if (content.includes(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)) {
    throw new SessionPromptError("session prompt must not include the internal dynamic boundary", 400);
  }
}

/** Same stable/dynamic concatenation the provider sees, without its internal cache marker. */
export function sessionPromptText(systemPrompt: string): string {
  const { stablePrefix, dynamicSuffix } = splitSystemPromptPrefix(systemPrompt);
  return [stablePrefix, dynamicSuffix].filter(Boolean).join("\n\n");
}

export function createSessionPromptSnapshot(sessionKey: string, state: SessionPromptState | undefined, baseline: string): SessionPromptSnapshot {
  const content = state?.content ?? sessionPromptText(baseline);
  const override = state?.content != null;
  const revision = createHash("sha256").update(JSON.stringify([sessionKey, state?.revision ?? "default", override, content])).digest("hex");
  return { content, override, revision };
}

export function applySessionPrompt(context: RuntimeContext, content: string | null): RuntimeContext {
  if (content === null) return context;
  return {
    ...context,
    systemPrompt: content,
    promptSections: [{ name: "Session Prompt Override", content, cacheStable: true }],
  };
}

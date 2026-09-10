import { createHash } from "node:crypto";
import type { RuntimeContext } from "../context/context-manager.js";
import { buildEffectiveSystemPrompt, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, splitSystemPromptPrefix } from "../context/prompts.js";

export const MAX_SESSION_PROMPT_CHARS = 256 * 1024;
export type SessionPromptMode = "inherit" | "append" | "replace_base" | "legacy_full_override";

/** Missing mode in old transcripts means full replacement, never an implicit migration. */
export interface SessionPromptState {
  content: string | null;
  revision: string;
  mode?: SessionPromptMode;
}
export interface SessionPromptSnapshot {
  content: string;
  override: boolean;
  mode: SessionPromptMode;
  revision: string;
  effectiveContent: string;
  effectiveRevision: string;
}
export type SessionPromptUpdate = { content: string; revision: string; mode?: Exclude<SessionPromptMode, "inherit">; reset?: never }
  | { reset: true; revision: string; content?: never; mode?: never };
export interface SessionPromptUpdateResult extends SessionPromptSnapshot { ok: true; deferred: boolean }
export class SessionPromptError extends Error {
  constructor(message: string, readonly statusCode: 400 | 409) {
    super(message);
    this.name = "SessionPromptError";
  }
}
export function sessionPromptMode(state: SessionPromptState | undefined | null): SessionPromptMode {
  return state?.content == null ? "inherit" : state.mode ?? "legacy_full_override";
}
export function validateSessionPromptState(state: SessionPromptState): void {
  if (state.mode !== undefined && !["inherit", "append", "replace_base", "legacy_full_override"].includes(state.mode)) {
    throw new SessionPromptError("invalid session prompt mode", 400);
  }
  if ((state.mode === "inherit" && state.content !== null) || (state.mode && state.mode !== "inherit" && state.content === null)) {
    throw new SessionPromptError("session prompt mode does not match content", 400);
  }
  if (state.content !== null) validateSessionPromptContent(state.content);
}
export function parseSessionPromptUpdate(value: unknown): SessionPromptUpdate {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SessionPromptError("session prompt update must be an object", 400);
  const body = value as Record<string, unknown>;
  if (typeof body.revision !== "string" || !body.revision.trim() || body.revision.length > 256) throw new SessionPromptError("a valid session prompt revision is required", 400);
  if (Object.keys(body).some((key) => !["content", "reset", "revision", "mode"].includes(key))) throw new SessionPromptError("unknown session prompt update field", 400);
  if (body.reset === true && !Object.hasOwn(body, "content") && !Object.hasOwn(body, "mode")) return { reset: true, revision: body.revision };
  if (Object.hasOwn(body, "reset") || typeof body.content !== "string") throw new SessionPromptError("provide either content or reset:true", 400);
  if (body.mode !== undefined && !["append", "replace_base", "legacy_full_override"].includes(body.mode as string)) throw new SessionPromptError("invalid session prompt mode", 400);
  validateSessionPromptContent(body.content);
  return { content: body.content, revision: body.revision, mode: body.mode as Exclude<SessionPromptMode, "inherit"> | undefined };
}
export function validateSessionPromptContent(content: string): void {
  if (!content.trim()) throw new SessionPromptError("session prompt content must not be empty", 400);
  if (content.length > MAX_SESSION_PROMPT_CHARS) throw new SessionPromptError(`session prompt exceeds ${MAX_SESSION_PROMPT_CHARS} characters`, 400);
  if (content.includes(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)) throw new SessionPromptError("session prompt must not include the internal dynamic boundary", 400);
}
export function sessionPromptText(systemPrompt: string): string {
  const { stablePrefix, dynamicSuffix } = splitSystemPromptPrefix(systemPrompt);
  return [stablePrefix, dynamicSuffix].filter(Boolean).join("\n\n");
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function createSessionPromptSnapshot(sessionKey: string, state: SessionPromptState | undefined, baseline: RuntimeContext): SessionPromptSnapshot {
  const content = state?.content ?? "";
  const mode = sessionPromptMode(state);
  const effectiveContent = sessionPromptText(applySessionPrompt(baseline, state).systemPrompt);
  return {
    content, mode, override: mode !== "inherit",
    // Editing configuration is independent of global/tool/plugin preview changes.
    revision: hash([sessionKey, state?.revision ?? "default", mode, content]),
    effectiveContent, effectiveRevision: hash(effectiveContent),
  };
}
export function applySessionPrompt(context: RuntimeContext, state: SessionPromptState | undefined | null): RuntimeContext {
  const mode = sessionPromptMode(state);
  if (mode === "inherit") return context;
  const content = state!.content!;
  if (mode === "legacy_full_override") return {
    ...context, systemPrompt: content,
    promptSections: [{ name: "Session Prompt Override", content, cacheStable: true }],
  };
  // Only the explicitly tagged global baseline can be replaced. Runtime/plugin/app sections survive.
  const baseline = context.promptSections.length ? context.promptSections : [{ name: "System Prompt", content: context.systemPrompt, source: "global" as const }];
  const promptSections = [
    ...baseline.filter((section) => mode !== "replace_base" || section.source !== "global"),
    { name: "Session Instructions", content, cacheStable: true, source: "session" as const },
  ];
  return { ...context, promptSections, systemPrompt: buildEffectiveSystemPrompt(promptSections) };
}

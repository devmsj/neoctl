import type { QueryEngine } from "../core/query-engine.js";
import { parseSessionPromptUpdate, type SessionPromptSnapshot, type SessionPromptUpdateResult } from "../core/session-settings-prompt.js";

export { MAX_SESSION_PROMPT_CHARS, SessionPromptError, parseSessionPromptUpdate } from "../core/session-settings-prompt.js";
export type { SessionPromptSnapshot, SessionPromptUpdate, SessionPromptUpdateResult } from "../core/session-settings-prompt.js";

/** GET /api/session-prompt. No provider call or global configuration write. */
export function readSessionPrompt(engine: QueryEngine): Promise<SessionPromptSnapshot> {
  return engine.getSessionPrompt();
}

/** POST /api/session-prompt. Map SessionPromptError.statusCode to HTTP 400/409. */
export function updateSessionPrompt(engine: QueryEngine, body: unknown): Promise<SessionPromptUpdateResult> {
  return engine.updateSessionPrompt(parseSessionPromptUpdate(body));
}

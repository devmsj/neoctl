import {ToolInputStream} from '../model/tool-input-stream.js';
// Presentation-only projection. Never executes partial arguments or adds them to model history.
export interface ToolActivity {
  phase: 'generating' | 'queued' | 'running' | 'completed' | 'failed' | 'interrupted';
  input: Record<string, unknown>;
  truncated?: boolean;
}
export const ACTIVITY_ARGUMENT_LIMIT = 80_000;

/** Bounded projection of already-complete validated input, also used by history restore. */
export function partialToolInput(raw:string):Record<string,unknown> {
  const decoder=new ToolInputStream();decoder.append(raw);return decoder.snapshot();
}

export function toolActivity(input: unknown, phase: ToolActivity['phase']): ToolActivity {
  let raw: string;
  try { raw = JSON.stringify(input ?? {}) ?? '{}'; } catch { raw = '{}'; }
  return { phase, input: partialToolInput(raw.slice(0, ACTIVITY_ARGUMENT_LIMIT)), truncated: raw.length > ACTIVITY_ARGUMENT_LIMIT || undefined };
}

import { findModelMetadata, reasoningEffortsForModel } from "./context-window.js";
import type { ReasoningConfig, ReasoningEffort } from "./model-gateway.js";

export function requiresAnthropicThinking(model: string | undefined): boolean {
  return /claude-(?:opus-5-5|sonnet-5-5|fable-5|mythos-5|mythos-preview)/i.test(model ?? "");
}

/** Only inherited settings are adapted. Explicit choices remain subject to validation. */
export function inheritedModelReasoning(current: ReasoningConfig | null | undefined, model: string | undefined): ReasoningConfig | null | undefined {
  if (current === null) return requiresAnthropicThinking(model) ? undefined : null;
  if (!current) return current;
  if (current.effort && !reasoningEffortsForModel(model)?.includes(current.effort)) return undefined;
  if (model && findModelMetadata(model)?.provider === "anthropic" && current.summary) {
    return current.effort ? { effort: current.effort } : undefined;
  }
  return current;
}

export function resolveModelReasoningUpdate(
  value: ReasoningEffort | "off" | "default" | undefined,
  current: ReasoningConfig | null | undefined,
  model: string | undefined,
  modelChanged: boolean,
): { reasoning: ReasoningConfig | null | undefined; update: boolean } {
  if (value === "off") return { reasoning: null, update: true };
  if (value === "default") return { reasoning: undefined, update: true };
  if (value !== undefined) return { reasoning: { effort: value }, update: true };
  const reasoning = modelChanged ? inheritedModelReasoning(current, model) : current;
  return { reasoning, update: reasoning !== current };
}

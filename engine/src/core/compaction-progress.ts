import type { CompactionReason } from "../context/compaction.js";
import type { AgentEvent } from "../types/events.js";

export type CompactionStarted = (reason: Exclude<CompactionReason, "none">) => void;

/** Forward start notifications while awaiting summary work, not after it has finished. */
export async function* withCompactionProgress<T>(work: (started: CompactionStarted) => Promise<T> | T): AsyncGenerator<AgentEvent, T, void> {
  const events: AgentEvent[] = [];
  const seen = new Set<CompactionReason>();
  let wake: (() => void) | undefined;
  let settled = false;
  let failed = false;
  let error: unknown;
  let result!: T;
  const pending = Promise.resolve().then(() => work(reason => {
    if (settled || seen.has(reason)) return;
    seen.add(reason);
    events.push({ type: "state", phase: "compacting", detail: `${reason}: generating context summary` });
    wake?.();
  })).then(value => { result = value; }, cause => { failed = true; error = cause; }).finally(() => {
    settled = true;
    wake?.();
  });
  try {
    while (!settled || events.length) {
      if (events.length) yield events.shift()!;
      else await new Promise<void>(resolve => { wake = resolve; });
    }
  } finally {
    // A consumer closing after the start event must not leave a detached history mutation.
    await pending;
  }
  if (failed) throw error;
  return result;
}

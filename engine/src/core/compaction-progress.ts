import { abortableWork } from "./abortable-stream.js";
import type { CompactionReason } from "../context/compaction.js";
import type { AgentEvent } from "../types/events.js";

export type CompactionStarted = (reason: Exclude<CompactionReason, "none">) => void;

/** Forward start notifications while awaiting summary work, not after it has finished. */
export async function* withCompactionProgress<T>(work: (started: CompactionStarted) => Promise<T> | T, signal?: AbortSignal): AsyncGenerator<AgentEvent, T, void> {
  const events: AgentEvent[] = [];
  const seen = new Set<CompactionReason>();
  let wake: (() => void) | undefined;
  let settled = false;
  let failed = false;
  let error: unknown;
  let result!: T;
  const pending = abortableWork(async () => work(reason => {
    if (settled || signal?.aborted || seen.has(reason)) return;
    seen.add(reason);
    events.push({ type: "state", phase: "compacting", detail: `${reason}: generating context summary` });
    wake?.();
  }), signal).then(value => { result = value; }, cause => { failed = true; error = cause; }).finally(() => {
    settled = true;
    wake?.();
  });
  try {
    while (!settled || events.length) {
      if (events.length) yield events.shift()!;
      else await new Promise<void>(resolve => { wake = resolve; });
    }
  } finally {
    // Wait for the bounded operation, never for a provider ignoring cancellation.
    await pending;
  }
  signal?.throwIfAborted();
  if (failed) throw error;
  return result;
}

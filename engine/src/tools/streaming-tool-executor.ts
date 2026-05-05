import { createToolResultMessage, type Message, type ToolUseRequest } from "../types/messages";
import { runToolUse, type RunToolUseOptions, type ToolMessageUpdate } from "./run-tool-use";
import type { ToolUseContext } from "./tool";

export interface StreamingToolExecutorOptions {
  context: ToolUseContext;
  runOptions?: RunToolUseOptions;
}

type TrackedToolStatus = "queued" | "executing" | "completed" | "yielded" | "discarded";

interface TrackedTool {
  request: ToolUseRequest;
  status: TrackedToolStatus;
  concurrencySafe: boolean;
  promise?: Promise<ToolMessageUpdate[]>;
  updates?: ToolMessageUpdate[];
}

export class StreamingToolExecutor {
  private readonly tracked: TrackedTool[] = [];
  private discarded = false;

  constructor(private readonly options: StreamingToolExecutorOptions) {}

  addTool(request: ToolUseRequest): void {
    if (this.discarded) return;
    const tool = this.options.context.tools.get(request.name) ?? this.options.context.tools.getByAlias?.(request.name);
    const concurrencySafe = tool?.isConcurrencySafe?.(request.input, this.options.context) ?? tool?.metadata.concurrent ?? true;
    this.tracked.push({ request, status: "queued", concurrencySafe });
    this.processQueue();
  }

  getCompletedResults(): Message[] {
    const messages: Message[] = [];
    for (const tracked of this.tracked) {
      if (tracked.status !== "completed" || !tracked.updates) continue;
      tracked.status = "yielded";
      messages.push(...tracked.updates.map((update) => update.message));
    }
    this.processQueue();
    return messages;
  }

  async getRemainingResults(): Promise<Message[]> {
    while (this.tracked.some((tracked) => tracked.status === "queued" || tracked.status === "executing" || tracked.status === "completed")) {
      const executing = this.tracked.filter((tracked) => tracked.status === "executing" && tracked.promise);
      if (executing.length) await Promise.race(executing.map((tracked) => tracked.promise));
      const completed = this.getCompletedResults();
      if (completed.length) return [...completed, ...(await this.getRemainingResults())];
      this.processQueue();
    }
    return [];
  }

  discard(): Message[] {
    this.discarded = true;
    const synthetic: Message[] = [];
    for (const tracked of this.tracked) {
      if (tracked.status === "yielded" || tracked.status === "discarded") continue;
      tracked.status = "discarded";
      synthetic.push(createToolResultMessage(tracked.request, false, { error: "Tool result discarded after stream fallback or abort" }));
    }
    return synthetic;
  }

  private processQueue(): void {
    if (this.discarded) return;
    for (const tracked of this.tracked) {
      if (tracked.status !== "queued") continue;
      if (!this.canExecute(tracked)) return;
      tracked.status = "executing";
      tracked.promise = runToolUse(tracked.request, this.options.context, this.options.runOptions)
        .then((updates) => {
          tracked.updates = updates;
          tracked.status = "completed";
          this.processQueue();
          return updates;
        })
        .catch((error) => {
          tracked.updates = [
            {
              message: createToolResultMessage(tracked.request, false, {
                error: error instanceof Error ? error.message : String(error),
              }),
            },
          ];
          tracked.status = "completed";
          this.processQueue();
          return tracked.updates;
        });
    }
  }

  private canExecute(next: TrackedTool): boolean {
    const executing = this.tracked.filter((tracked) => tracked.status === "executing");
    if (executing.length === 0) return true;
    return next.concurrencySafe && executing.every((tracked) => tracked.concurrencySafe);
  }
}

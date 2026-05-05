import type { ToolUseRequest } from "../types/messages";
import type { ToolUseContext } from "./tool";
import { runToolUse } from "./run-tool-use";

export interface StreamingToolExecutorOptions {
  context: ToolUseContext;
}

export class StreamingToolExecutor {
  constructor(private readonly options: StreamingToolExecutorOptions) {}

  async addTool(request: ToolUseRequest): Promise<void> {
    await runToolUse(request, this.options.context);
  }
}

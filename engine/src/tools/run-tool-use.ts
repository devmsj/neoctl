import { createToolResultMessage, type Message, type ToolUseRequest } from "../types/messages";
import type { ToolResult, ToolUseContext } from "./tool";

export async function runToolUse(request: ToolUseRequest, context: ToolUseContext): Promise<Message> {
  const tool = context.tools.get(request.name);
  if (!tool) {
    return createToolResultMessage(request, false, { error: `Unknown tool: ${request.name}` });
  }

  try {
    const input = tool.validate ? tool.validate(request.input) : request.input;
    const result: ToolResult = await tool.execute(input, context);
    const output = tool.mapResult ? tool.mapResult(result, request) : result.output;
    return createToolResultMessage(request, result.ok, output);
  } catch (error) {
    return createToolResultMessage(request, false, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

import type { Tool } from "../tool.js";

export const echoTool: Tool<{ text: string }> = {
  name: "echo",
  aliases: ["say"],
  description: "Return the provided text. Useful for wiring tests before real tools exist.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string", description: "Text to return." } },
    required: ["text"],
    additionalProperties: false,
  },
  metadata: { readOnly: true, concurrent: true, visible: true, maxResultSizeChars: 4096, searchHint: "echo text" },
  validate(input: unknown): { text: string } {
    return { text: (input as { text: string }).text };
  },
  validateInput(input) {
    return input.text.length > 0 ? { ok: true, value: input } : { ok: false, message: "echo.text cannot be empty" };
  },
  isConcurrencySafe() {
    return true;
  },
  async call(input, _context, options) {
    options.onProgress?.({ toolName: "echo", message: "Echo text prepared" });
    return { ok: true, output: input.text };
  },
};

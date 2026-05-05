import type { Tool } from "../tool";

export const echoTool: Tool<{ text: string }> = {
  name: "echo",
  description: "Return the provided text. Useful for wiring tests before real tools exist.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  },
  metadata: { readOnly: true, concurrent: true, visible: true },
  validate(input: unknown): { text: string } {
    if (!input || typeof input !== "object" || typeof (input as { text?: unknown }).text !== "string") {
      throw new Error("echo.text must be a string");
    }
    return { text: (input as { text: string }).text };
  },
  async execute(input) {
    return { ok: true, output: input.text };
  },
};

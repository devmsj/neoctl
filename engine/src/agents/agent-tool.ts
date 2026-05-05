import type { Tool } from "../tools/tool";

export interface AgentToolInput {
  prompt: string;
  mode?: "sync" | "background" | "fork";
  agentId?: string;
}

export function createAgentTool(): Tool<AgentToolInput> {
  return {
    name: "agent",
    description: "Spawn or address a child agent. Placeholder until the task runtime is implemented.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        mode: { type: "string", enum: ["sync", "background", "fork"] },
        agentId: { type: "string" },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    metadata: { readOnly: false, concurrent: true, visible: true, requiresApproval: false },
    validate(input: unknown): AgentToolInput {
      if (!input || typeof input !== "object" || typeof (input as { prompt?: unknown }).prompt !== "string") {
        throw new Error("agent.prompt must be a string");
      }
      return input as AgentToolInput;
    },
    async execute(input) {
      return { ok: false, output: { message: "AgentTool boundary exists but spawning is not implemented yet.", input } };
    },
  };
}

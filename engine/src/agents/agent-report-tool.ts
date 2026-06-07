import type { Tool, ToolUseContext } from "../tools/tool.js";

export const AGENT_REPORT_TOOL_NAME = "agent_report";

export interface AgentReportInput {
  content: string;
  status?: "completed" | "incomplete";
}

export interface AgentReportOutput {
  report: string;
  status: "completed" | "incomplete";
}

export function createAgentReportTool(): Tool<AgentReportInput> {
  return {
    name: AGENT_REPORT_TOOL_NAME,
    description: [
      "Submit the subagent's final report to the parent agent.",
      "Use this exactly once when your assigned scope is complete or when you must return an INCOMPLETE report.",
      "The parent agent will use this tool result as the authoritative subagent output instead of incidental progress text.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "The complete final report or INCOMPLETE report for the assigned subagent task.",
        },
        status: {
          type: "string",
          enum: ["completed", "incomplete"],
          description: "Whether the assigned scope was completed.",
        },
      },
      required: ["content"],
      additionalProperties: false,
    },
    metadata: { readOnly: true, concurrent: false, visible: true },
    validate(input: unknown, _context: ToolUseContext): AgentReportInput {
      if (!input || typeof input !== "object") throw new Error("agent_report input must be an object");
      const value = input as Record<string, unknown>;
      if (typeof value.content !== "string" || value.content.trim().length === 0) {
        throw new Error("agent_report.content must be a non-empty string");
      }
      if (value.status !== undefined && value.status !== "completed" && value.status !== "incomplete") {
        throw new Error("agent_report.status must be 'completed' or 'incomplete'");
      }
      return { content: value.content, status: value.status as AgentReportInput["status"] };
    },
    async call(input: AgentReportInput) {
      const report = input.content.trim();
      const status = input.status ?? (report.startsWith("INCOMPLETE") ? "incomplete" : "completed");
      return {
        ok: true,
        output: { report, status } satisfies AgentReportOutput,
        summary: status === "completed" ? "Subagent final report submitted" : "Subagent incomplete report submitted",
      };
    },
  };
}

import type { Tool, ToolUseContext } from "../tools/tool.js";

export const AGENT_REPORT_TOOL_NAME = "agent_report";

export type AgentReportStatus = "draft" | "completed" | "incomplete";

export interface AgentReportInput {
  content: string;
  status?: AgentReportStatus;
}

export interface AgentReportOutput {
  report: string;
  status: AgentReportStatus;
  final: boolean;
}

export function createAgentReportTool(): Tool<AgentReportInput> {
  return {
    name: AGENT_REPORT_TOOL_NAME,
    description: [
      "Submit the subagent report that is visible to the parent agent.",
      "Use status='completed' when the assigned scope is finished, or status='incomplete' when you cannot finish and need to end with a clear reason instead of asking the parent a follow-up question.",
      "Normal assistant text is not authoritative parent-visible subagent output.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "The current report content. For incomplete reports, include exactly why the task cannot be completed and what was/was not done.",
        },
        status: {
          type: "string",
          enum: ["draft", "completed", "incomplete"],
          description: "draft updates the parent-visible report without ending; completed or incomplete marks the report final and ends the subagent call.",
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
      if (value.status !== undefined && value.status !== "draft" && value.status !== "completed" && value.status !== "incomplete") {
        throw new Error("agent_report.status must be 'draft', 'completed', or 'incomplete'");
      }
      return { content: value.content, status: value.status as AgentReportInput["status"] };
    },
    async call(input: AgentReportInput) {
      const report = input.content.trim();
      const status = input.status ?? (report.startsWith("INCOMPLETE") ? "incomplete" : "draft");
      const final = status === "completed" || status === "incomplete";
      return {
        ok: true,
        output: { report, status, final } satisfies AgentReportOutput,
        summary: final
          ? (status === "completed" ? "Subagent final report completed" : "Subagent incomplete report finalized")
          : "Subagent report draft updated",
      };
    },
  };
}

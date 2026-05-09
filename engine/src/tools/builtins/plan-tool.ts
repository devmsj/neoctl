import type { Tool } from "../tool.js";

export type PlanItemStatus = "pending" | "in_progress" | "completed";

export interface PlanItem {
  description: string;
  status: PlanItemStatus;
}

export interface PlanToolInput {
  items: PlanItem[];
  title?: string;
  note?: string;
}

export interface PlanToolOutput extends PlanToolInput {
  summary: string;
  total: number;
  completed: number;
  inProgress: number;
  pending: number;
}

export const planTool: Tool<PlanToolInput> = {
  name: "plan",
  description: "Create or update the current task plan. Use this to make multi-step work visible; mark items completed as they are finished.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Optional short title for the plan." },
      note: { type: "string", description: "Optional short note about the current plan update." },
      items: {
        type: "array",
        description: "Ordered plan items. Include the full current plan each time you update it.",
        items: {
          type: "object",
          properties: {
            description: { type: "string", description: "A concise step description." },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed"],
              description: "Current status for this step.",
            },
          },
          required: ["description", "status"],
          additionalProperties: false,
        },
      },
    },
    required: ["items"],
    additionalProperties: false,
  },
  metadata: { readOnly: true, concurrent: true, visible: true, maxResultSizeChars: 8192, searchHint: "update visible plan" },
  validate(input: unknown): PlanToolInput {
    const record = input as PlanToolInput;
    return {
      title: record.title,
      note: record.note,
      items: record.items,
    };
  },
  validateInput(input) {
    if (!input.items.length) return { ok: false, message: "plan.items must contain at least one item" };
    for (const [index, item] of input.items.entries()) {
      if (!item.description.trim()) return { ok: false, message: `plan.items[${index}].description cannot be empty` };
    }
    return { ok: true, value: input };
  },
  isConcurrencySafe() {
    return true;
  },
  async call(input) {
    const completed = input.items.filter((item) => item.status === "completed").length;
    const inProgress = input.items.filter((item) => item.status === "in_progress").length;
    const pending = input.items.filter((item) => item.status === "pending").length;
    const output: PlanToolOutput = {
      ...input,
      summary: `${completed}/${input.items.length} completed`,
      total: input.items.length,
      completed,
      inProgress,
      pending,
    };
    return { ok: true, output };
  },
};

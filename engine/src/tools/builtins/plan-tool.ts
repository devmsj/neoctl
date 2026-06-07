import type { JsonSchema, Tool } from "../tool.js";

export type PlanItemStatus = "pending" | "in_progress" | "completed";

export interface PlanItem {
  description: string;
  status: PlanItemStatus;
  subitems?: PlanItem[];
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

const PLAN_ITEM_STATUSES: PlanItemStatus[] = ["pending", "in_progress", "completed"];

function planItemSchema(depth = 3): JsonSchema {
  const schema: JsonSchema = {
    type: "object",
    properties: {
      description: { type: "string", description: "A concise step description." },
      status: {
        type: "string",
        enum: PLAN_ITEM_STATUSES,
        description: "Current status for this step.",
      },
    },
    required: ["description", "status"],
    additionalProperties: false,
  };
  if (depth > 0) {
    schema.properties = {
      ...schema.properties,
      subitems: {
        type: "array",
        description: "Optional ordered sub-steps for this item. Use these when a main item benefits from being split into smaller, trackable tasks.",
        items: planItemSchema(depth - 1),
      },
    };
  }
  return schema;
}

export const planTool: Tool<PlanToolInput> = {
  name: "plan",
  description: "Create or update the current task plan. Use this to make multi-step work visible; mark items completed as they are finished. When implementing a main plan item, you may reasonably split it into subitems to keep progress more detailed and verifiable.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Optional short title for the plan." },
      note: { type: "string", description: "Optional short note about the current plan update." },
      items: {
        type: "array",
        description: "Ordered plan items. Include the full current plan each time you update it. Items may include subitems for finer-grained progress tracking.",
        items: planItemSchema(),
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
    const validationError = validatePlanItems(input.items, "plan.items");
    if (validationError) return { ok: false, message: validationError };
    return { ok: true, value: input };
  },
  isConcurrencySafe() {
    return true;
  },
  async call(input) {
    const counts = countPlanItems(input.items);
    const output: PlanToolOutput = {
      ...input,
      summary: `${counts.completed}/${counts.total} completed`,
      total: counts.total,
      completed: counts.completed,
      inProgress: counts.inProgress,
      pending: counts.pending,
    };
    return { ok: true, output };
  },
};

interface PlanCounts {
  total: number;
  completed: number;
  inProgress: number;
  pending: number;
}

function countPlanItems(items: readonly PlanItem[]): PlanCounts {
  const counts: PlanCounts = { total: 0, completed: 0, inProgress: 0, pending: 0 };
  for (const item of items) {
    counts.total += 1;
    if (item.status === "completed") counts.completed += 1;
    else if (item.status === "in_progress") counts.inProgress += 1;
    else counts.pending += 1;
    if (item.subitems?.length) {
      const subitemCounts = countPlanItems(item.subitems);
      counts.total += subitemCounts.total;
      counts.completed += subitemCounts.completed;
      counts.inProgress += subitemCounts.inProgress;
      counts.pending += subitemCounts.pending;
    }
  }
  return counts;
}

function validatePlanItems(items: readonly PlanItem[] | undefined, path: string): string | undefined {
  if (!Array.isArray(items)) return `${path} must be an array`;
  for (const [index, item] of items.entries()) {
    const itemPath = `${path}[${index}]`;
    if (!item.description.trim()) return `${itemPath}.description cannot be empty`;
    if (!PLAN_ITEM_STATUSES.includes(item.status)) return `${itemPath}.status must be one of pending, in_progress, completed`;
    if (item.subitems !== undefined) {
      if (!Array.isArray(item.subitems)) return `${itemPath}.subitems must be an array`;
      if (item.subitems.length === 0) return `${itemPath}.subitems must contain at least one item when provided`;
      const subitemError = validatePlanItems(item.subitems, `${itemPath}.subitems`);
      if (subitemError) return subitemError;
    }
  }
  return undefined;
}

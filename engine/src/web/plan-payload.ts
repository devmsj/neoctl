export interface WebPlanPayload extends Record<string, unknown> {
  title?: string;
  note?: string;
  summary?: string;
  items: WebPlanItem[];
}

export interface WebPlanItem {
  description: string;
  status: "pending" | "in_progress" | "completed";
  subitems?: WebPlanItem[];
}

export function isWebPlanPayload(value: unknown): value is WebPlanPayload {
  if (!isRecord(value) || !Array.isArray(value.items)) return false;
  return value.items.every(isWebPlanItem);
}

export function webPlanBodyTitle(payload: WebPlanPayload): string | undefined {
  const title = payload.title?.trim();
  return title || undefined;
}

export function serializeWebPlanPayload(payload: WebPlanPayload): string {
  return JSON.stringify(payload);
}

function isWebPlanItem(item: unknown): item is WebPlanItem {
  if (!isRecord(item)) return false;
  if (typeof item.description !== "string") return false;
  if (item.status !== "pending" && item.status !== "in_progress" && item.status !== "completed") return false;
  if (item.subitems === undefined) return true;
  return Array.isArray(item.subitems) && item.subitems.every(isWebPlanItem);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

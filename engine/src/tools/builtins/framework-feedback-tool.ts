import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getNeoctlHome } from "../../paths.js";
import type { Tool, ToolUseContext } from "../tool.js";

export const FRAMEWORK_FEEDBACK_TOOL = "framework_feedback";
export const FRAMEWORK_FEEDBACK_PROMPT = "Proactively note framework issues actually encountered while using neo. Complete the user's task first, then submit one item at a time through framework_feedback. Keep the title and body concise; include the issue, reproduction steps, and suggested improvement. Do not speculate, duplicate feedback, or include sensitive information.";
export interface FrameworkFeedbackInput { title: string; body: string }
export interface FrameworkFeedback extends FrameworkFeedbackInput { id: string; createdAt: string }
const RECORD_NAME = /^\d{13}-[a-f0-9-]{36}\.json$/;

/** Immutable records use the existing atomic-file storage pattern; no database or session scan. */
export class FrameworkFeedbackStore {
  constructor(readonly directory = path.join(getNeoctlHome(), "framework-feedback")) {}

  async submit(input: FrameworkFeedbackInput): Promise<FrameworkFeedback> {
    const title = input.title?.trim(), body = input.body?.trim();
    if (!title || title.length > 60 || !body || body.length > 400) throw new Error("标题须为1–60字，正文须为1–400字，每次只提交一条意见");
    const now = Date.now();
    const record = { id: `${now}-${randomUUID()}`, createdAt: new Date(now).toISOString(), title, body };
    await fs.mkdir(this.directory, { recursive: true });
    const target = path.join(this.directory, `${record.id}.json`);
    const temporary = `${target}.tmp`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await fs.rename(temporary, target);
    } finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
    return record;
  }

  async delete(id: unknown): Promise<boolean> {
    if (typeof id !== "string" || !RECORD_NAME.test(`${id}.json`)) throw new Error("Invalid feedback id");
    try {
      await fs.unlink(path.join(this.directory, `${id}.json`));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async list(requestedPage = 1, requestedSize = 10) {
    const pageSize = Number.isSafeInteger(requestedSize) ? Math.max(1, Math.min(50, requestedSize)) : 10;
    const requested = Number.isSafeInteger(requestedPage) ? Math.max(1, requestedPage) : 1;
    const names = await fs.readdir(this.directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [] as string[];
      throw error;
    });
    const files = names.filter(name => RECORD_NAME.test(name)).sort().reverse();
    const total = files.length, totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requested, totalPages);
    const items: FrameworkFeedback[] = await Promise.all(files.slice((page - 1) * pageSize, page * pageSize).map(async name => {
      const item = JSON.parse(await fs.readFile(path.join(this.directory, name), "utf8")) as FrameworkFeedback;
      if (typeof item.title !== "string" || typeof item.body !== "string" || typeof item.createdAt !== "string" || item.id !== name.slice(0, -5)) throw new Error("Invalid feedback record");
      return { id: item.id, title: item.title, body: item.body, createdAt: item.createdAt };
    }));
    return { items, total, page, pageSize, totalPages };
  }
}

export function createFrameworkFeedbackTool(store = new FrameworkFeedbackStore()): Tool<FrameworkFeedbackInput> {
  return {
    name: FRAMEWORK_FEEDBACK_TOOL,
    description: "After completing the user's task, submit one improvement suggestion for a neo framework issue actually encountered. Keep the title and body concise; include the issue, reproduction steps, and suggested improvement. Exclude secrets and private user information. Saved locally only.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["title", "body"],
      properties: {
        title: { type: "string", minLength: 1, maxLength: 60, description: "A concise title for one suggestion, up to 60 characters." },
        body: { type: "string", minLength: 1, maxLength: 400, description: "Issue, reproduction steps, and suggested improvement. Keep concise, up to 400 characters." },
      },
    },
    metadata: { readOnly: false, concurrent: true, visible: true },
    validateInput(input) {
      if (!input.title.trim() || input.title.trim().length > 60 || !input.body.trim() || input.body.trim().length > 400) {
        return { ok: false, message: "标题须为1–60字，正文须为1–400字，每次只提交一条意见" };
      }
      return { ok: true, value: { title: input.title.trim(), body: input.body.trim() } };
    },
    async call(input, context: ToolUseContext) {
      if (context.abortSignal?.aborted) return { ok: false, output: { error: "已取消提交" } };
      const safe = context.secretRedactions?.redact(input) ?? input;
      try {
        const record = await store.submit(safe);
        return { ok: true, output: { id: record.id, saved: true }, summary: "已提交建议" };
      } catch { return { ok: false, output: { error: "建议保存失败" } }; }
    },
  };
}

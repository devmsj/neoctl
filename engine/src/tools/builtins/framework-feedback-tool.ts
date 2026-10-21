import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getNeoctlHome } from "../../paths.js";
import type { Tool, ToolUseContext } from "../tool.js";

export const FRAMEWORK_FEEDBACK_TOOL = "framework_feedback";
export const FRAMEWORK_FEEDBACK_PROMPT = "使用 neo 时主动记录实际框架问题。先完成用户任务，再用 framework_feedback 提交；每次一条，标题、正文尽量短，正文含问题、复现、改进方向。不臆测、不重复、不含敏感信息。";
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
    description: "用户任务完成后，提交一条实际遇到的 neo 框架改进建议。标题和正文尽量短；正文含问题、复现、改进方向，不含密钥或用户隐私。仅本机保存。",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["title", "body"],
      properties: {
        title: { type: "string", minLength: 1, maxLength: 60, description: "一条意见的简短标题，最多60字。" },
        body: { type: "string", minLength: 1, maxLength: 400, description: "问题；复现；改进。尽量短，最多400字。" },
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

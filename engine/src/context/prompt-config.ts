import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getNeoctlHome } from "../paths.js";

export const MAX_SYSTEM_PROMPT_BYTES = 200_000;
export const SYSTEM_PROMPT_VERSION: string = createRequire(import.meta.url)("../../package.json").version;

export interface PromptConfigSnapshot {
  content: string;
  revision: string;
  version: string;
  path: string;
}

export interface PromptConfigStoreOptions {
  /** Trusted host configuration only. Never accept this option from an HTTP client. */
  filePath?: string;
  homeDir?: string;
  version?: string;
}

export class PromptConfigError extends Error {
  constructor(public readonly errorCode: string, message: string, public readonly status: number) {
    super(message);
    this.name = "PromptConfigError";
  }
}

export function validateSystemPromptContent(content: unknown): asserts content is string {
  if (typeof content !== "string" || !content.trim()) {
    throw new PromptConfigError("PROMPT_CONFIG_INVALID", "System prompt content must be a non-empty string.", 400);
  }
  if (Buffer.byteLength(content, "utf8") > MAX_SYSTEM_PROMPT_BYTES) {
    throw new PromptConfigError("PROMPT_CONFIG_TOO_LARGE", `System prompt exceeds ${MAX_SYSTEM_PROMPT_BYTES} UTF-8 bytes.`, 413);
  }
}

/** The version's real packaged Markdown, also used by synchronous prompt helpers. */
export function readBundledSystemPrompt(): string {
  const content = readFileSync(new URL("./system.md", import.meta.url), "utf8");
  validateSystemPromptContent(content);
  return content;
}

/** File-backed global baseline. No content cache: every build observes the latest atomic file. */
export class PromptConfigStore {
  readonly filePath: string;
  readonly version: string;

  constructor(options: PromptConfigStoreOptions = {}) {
    this.version = options.version ?? SYSTEM_PROMPT_VERSION;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(this.version)) throw new Error("Invalid prompt configuration version.");
    this.filePath = resolve(options.filePath ?? process.env.NEO_SYSTEM_PROMPT_PATH ?? join(options.homeDir ?? getNeoctlHome(), "prompts", this.version, "system.md"));
  }

  async read(): Promise<PromptConfigSnapshot> {
    try {
      return await this.readExisting();
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
    return this.withLock(async () => {
      // Another session/process may have initialized the file while this reader waited.
      try { return await this.readExisting(); } catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
      const content = readBundledSystemPrompt();
      await this.atomicWrite(content);
      return this.snapshot(content);
    });
  }

  async save(content: unknown, revision: unknown): Promise<PromptConfigSnapshot> {
    validateSystemPromptContent(content);
    if (typeof revision !== "string" || !/^[a-f0-9]{64}$/.test(revision)) {
      throw new PromptConfigError("PROMPT_CONFIG_INVALID", "A valid prompt revision is required.", 400);
    }
    return this.withLock(async () => {
      let current: PromptConfigSnapshot;
      try { current = await this.readExisting(); } catch (error) {
        if (!hasCode(error, "ENOENT")) throw error;
        throw new PromptConfigError("PROMPT_CONFIG_CONFLICT", "System prompt file changed. Reload before saving.", 409);
      }
      if (current.revision !== revision) {
        throw new PromptConfigError("PROMPT_CONFIG_CONFLICT", "System prompt changed. Reload before saving.", 409);
      }
      await this.atomicWrite(content);
      return this.snapshot(content);
    });
  }

  private snapshot(content: string): PromptConfigSnapshot {
    return { content, revision: createHash("sha256").update(content, "utf8").digest("hex"), version: this.version, path: this.filePath };
  }

  private async readExisting(): Promise<PromptConfigSnapshot> {
    const handle = await fs.open(this.filePath, "r");
    try {
      if ((await handle.stat()).size > MAX_SYSTEM_PROMPT_BYTES) {
        throw new PromptConfigError("PROMPT_CONFIG_TOO_LARGE", `System prompt exceeds ${MAX_SYSTEM_PROMPT_BYTES} UTF-8 bytes.`, 413);
      }
      const content = await handle.readFile("utf8");
      validateSystemPromptContent(content);
      return this.snapshot(content);
    } finally { await handle.close(); }
  }

  private async atomicWrite(content: string): Promise<void> {
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temporary, "wx", 0o600);
      try { await handle.writeFile(content, "utf8"); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, this.filePath);
    } finally { await fs.rm(temporary, { force: true }); }
  }

  /** Directory creation is atomic across store instances and OS processes. Never steal a live lock. */
  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await fs.mkdir(dirname(this.filePath), { recursive: true });
    const lockPath = `${this.filePath}.lock`;
    const deadline = Date.now() + 10_000;
    while (true) {
      try { await fs.mkdir(lockPath); break; } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
        if (Date.now() >= deadline) throw new PromptConfigError("PROMPT_CONFIG_BUSY", "Prompt configuration is locked. Retry later; after a crashed writer, remove its .lock directory only when no writer is running.", 503);
        await delay(15);
      }
    }
    try { return await operation(); } finally { await fs.rmdir(lockPath); }
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

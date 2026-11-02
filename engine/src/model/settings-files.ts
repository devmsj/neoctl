import { existsSync, mkdirSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getNeoctlHome } from "../paths.js";
export const modelSettingsHome = () => process.env.NEO_MODEL_CONFIG_DIR || getNeoctlHome();
export function atomicJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 }); renameSync(temp, file); }
  finally { if (existsSync(temp)) unlinkSync(temp); }
}
export function locked<T>(file: string, action: () => T): T {
  mkdirSync(path.dirname(file), { recursive: true });
  let fd: number;
  const deadline = Date.now() + 3000;
  for (;;) {
    try { fd = openSync(file + ".lock", "wx"); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error("配置锁被占用，请稍后重试；若所有 neo 进程已退出，请移除遗留的 .lock 文件。");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try { return action(); } finally { closeSync(fd); unlinkSync(file + ".lock"); }
}

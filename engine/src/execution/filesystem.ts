import localFs from "node:fs/promises";
import { existsSync as localExistsSync, readFileSync as localReadFileSync, statSync as localStatSync } from "node:fs";
import { dockerArgs, dockerEnabled, dockerRun, dockerRunSync } from "./docker.js";

// This small transport program is sent over stdin; no host paths or application code are mounted.
const program = String.raw`
const fs = require('node:fs/promises');
const chunks = [];
process.stdin.on('data', c => chunks.push(c));
process.stdin.on('end', async () => {
  const encode = v => {
    if (Buffer.isBuffer(v)) return { $buffer: v.toString('base64') };
    if (v && typeof v.isFile === 'function') return {
      name: v.name, size: v.size, mode: v.mode, mtimeMs: v.mtimeMs,
      $kind: v.isFile() ? 'file' : v.isDirectory() ? 'directory' : v.isSymbolicLink() ? 'symlink' : 'other'
    };
    if (Array.isArray(v)) return v.map(encode);
    return v;
  };
  try {
    const { op, args } = JSON.parse(Buffer.concat(chunks).toString());
    const allowed = ['stat','lstat','readFile','writeFile','appendFile','mkdir','readdir','access','realpath','rename','rm','rmdir','unlink','copyFile','truncate'];
    if (!allowed.includes(op)) throw new Error('Unsupported file operation');
    const decoded = args.map(v => v && v.$buffer !== undefined ? Buffer.from(v.$buffer,'base64') : v);
    const result = await fs[op](...decoded);
    process.stdout.write(JSON.stringify({ value: encode(result) }));
  } catch (e) { process.stdout.write(JSON.stringify({ error: e.message, code: e.code })); }
});`;

function request(op: string, args: unknown[]): string {
  return JSON.stringify({ op, args: args.map(value => Buffer.isBuffer(value) ? { $buffer: value.toString("base64") } : value) });
}
function decode(result: Buffer): any {
  const envelope = JSON.parse(result.toString());
  if (envelope.error) throw Object.assign(new Error(envelope.error), { code: envelope.code });
  const restore = (v: any): any => {
    if (v?.$buffer !== undefined) return Buffer.from(v.$buffer, "base64");
    if (v?.$kind) return { ...v, mtime: new Date(v.mtimeMs || 0), isFile: () => v.$kind === "file", isDirectory: () => v.$kind === "directory", isSymbolicLink: () => v.$kind === "symlink" };
    return Array.isArray(v) ? v.map(restore) : v;
  };
  return restore(envelope.value);
}
async function remote(op: string, args: unknown[]): Promise<any> {
  return decode(await dockerRun(dockerArgs(["node", "-e", program]), request(op, args)));
}
function remoteSync(op: string, args: unknown[]): any {
  return decode(dockerRunSync(dockerArgs(["node", "-e", program]), request(op, args)));
}

/** Import only for agent-controlled file operations. Configuration/session storage stays local. */
export const executionFs: typeof localFs = new Proxy(localFs, {
  get(target, property) {
    if (!dockerEnabled()) return Reflect.get(target, property);
    if (typeof property !== "string") return undefined;
    if (!["stat", "lstat", "readFile", "writeFile", "appendFile", "mkdir", "readdir", "access", "realpath", "rename", "rm", "rmdir", "unlink", "copyFile", "truncate"].includes(property)) {
      return () => { throw new Error(`Unsupported container filesystem operation: ${property}`); };
    }
    return (...args: unknown[]) => remote(property, args);
  },
});

export const executionReadFileSync: typeof localReadFileSync = ((...args: unknown[]) => dockerEnabled() ? remoteSync("readFile", args) : (localReadFileSync as Function)(...args)) as typeof localReadFileSync;
export const executionStatSync: typeof localStatSync = ((...args: unknown[]) => dockerEnabled() ? remoteSync("stat", args) : (localStatSync as Function)(...args)) as typeof localStatSync;
export const executionExistsSync: typeof localExistsSync = ((...args: unknown[]) => {
  if (!dockerEnabled()) return (localExistsSync as Function)(...args);
  try { remoteSync("stat", args); return true; } catch { return false; }
}) as typeof localExistsSync;

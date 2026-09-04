import fs from "node:fs/promises";
import path from "node:path";
import type { Tool, ToolResult, ToolUseContext } from "../tool.js";

export interface ReadFileToolInput {
  path: string;
  offset: number;
  limit: number;
}

export interface ListDirectoryToolInput {
  path?: string;
  recursive: boolean;
  includeHidden: boolean;
  maxEntries: number;
  maxDepth?: number;
  exclude: string[];
}

export const readFileTool: Tool<ReadFileToolInput> = {
  name: "file_read",
  description: "Read a text file by line range. Use offset and limit to inspect specific locations without loading the whole file.",
  inputSchema: {
    type: "object",
    properties: {
      description: { type: "string", description: "Optional model-facing reason for this read request. Ignored by the tool." },
      path: { type: "string", description: "Absolute or cwd-relative file path to read." },
      offset: { type: "integer", description: "1-based starting line. Defaults to 1." },
      limit: { type: "integer", description: "Number of lines to return, 1-500. Defaults to 120." },
    },
    required: ["path"],
    additionalProperties: false,
  },
  metadata: {
    readOnly: true,
    concurrent: true,
    visible: true,
    maxResultSizeChars: 30000,
    searchHint: "read a file line range",
    ignoreUnknownInputProperties: true,
  },
  validate(input) {
    const record = input as Partial<ReadFileToolInput>;
    return {
      path: record.path ?? "",
      offset: record.offset ?? 1,
      limit: record.limit ?? 120,
    };
  },
  validateInput(input) {
    if (!input.path.trim()) return { ok: false, message: "read.path cannot be empty" };
    if (!Number.isInteger(input.offset) || input.offset < 1) return { ok: false, message: "read.offset must be a positive integer" };
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500) {
      return { ok: false, message: "read.limit must be between 1 and 500" };
    }
    return { ok: true, value: input };
  },
  isConcurrencySafe() {
    return true;
  },
  async call(input, context) {
    const root = workingDirectory(context);
    const target = resolveTarget(root, input.path);
    const stat = await fs.stat(target).catch(() => undefined);
    if (!stat) return { ok: false, output: { error: `read.path does not exist: ${target}` } };
    if (!stat.isFile()) return { ok: false, output: { error: `read.path is not a file: ${target}` } };
    if (stat.size > 8 * 1024 * 1024) {
      return { ok: false, output: { error: `read.path is too large to read directly: ${stat.size} bytes`, path: target, size: stat.size } };
    }

    const buffer = await fs.readFile(target);
    if (looksBinary(buffer)) {
      return { ok: false, output: { error: "read.path appears to be binary; use list/grep metadata instead", path: target, size: stat.size } };
    }

    const text = buffer.toString("utf8").replace(/^\uFEFF/, "");
    const lines = text.split(/\r\n|\n|\r/);
    const totalLines = lines.length === 1 && lines[0] === "" ? 0 : lines.length;
    const startIndex = Math.min(Math.max(0, input.offset - 1), totalLines);
    const endIndex = Math.min(totalLines, startIndex + input.limit);
    const selected = lines.slice(startIndex, endIndex).map((line, index) => ({
      line: startIndex + index + 1,
      text: line,
    }));

    return {
      ok: true,
      output: {
        path: target,
        offset: input.offset,
        limit: input.limit,
        startLine: selected[0]?.line,
        endLine: selected[selected.length - 1]?.line,
        totalLines,
        hasMoreBefore: startIndex > 0,
        hasMoreAfter: endIndex < totalLines,
        content: selected.map((line) => `${String(line.line).padStart(4, " ")} | ${line.text}`).join("\n"),
      },
      summary: selected.length ? `lines ${selected[0].line}-${selected[selected.length - 1].line} of ${totalLines}` : `0 lines of ${totalLines}`,
    };
  },
};

export const listDirectoryTool: Tool<ListDirectoryToolInput> = {
  name: "file_list",
  description: "List a file or directory. Recursive listings are bounded and skip heavy directories by default; use exclude/maxDepth to control scope.",
  inputSchema: {
    type: "object",
    properties: {
      description: { type: "string", description: "Optional model-facing reason for this list request. Ignored by the tool." },
      path: { type: "string", description: "Absolute or cwd-relative file/directory path. Defaults to current working directory." },
      recursive: { type: "boolean", description: "Recursively inventory descendants. Defaults to false." },
      includeHidden: { type: "boolean", description: "Include dotfiles and hidden-looking names. Defaults to false." },
      maxEntries: { type: "integer", description: "Maximum entries to return, 1-500. Defaults to 120." },
      maxDepth: { type: "integer", description: "Maximum recursive depth below the target directory. 0 means only direct children. Defaults to 4 when recursive, 0 otherwise." },
      exclude: {
        type: "array",
        items: { type: "string" },
        description: "Directory or file name/path fragments to skip. Defaults to heavy directories such as .git, node_modules, dist, build, coverage.",
      },
    },
    additionalProperties: false,
  },
  metadata: {
    readOnly: true,
    concurrent: true,
    visible: true,
    maxResultSizeChars: 30000,
    searchHint: "list directory entries and file counts",
    ignoreUnknownInputProperties: true,
  },
  mapResult(result) {
    return shrinkDirectoryOutputForTransport(result.output, 26000);
  },
  validate(input) {
    const record = input as Partial<ListDirectoryToolInput>;
    return {
      path: record.path,
      recursive: record.recursive ?? false,
      includeHidden: record.includeHidden ?? false,
      maxEntries: record.maxEntries ?? 120,
      maxDepth: record.maxDepth,
      exclude: record.exclude ?? DEFAULT_LIST_EXCLUDES,
    };
  },
  validateInput(input) {
    if (input.path !== undefined && !input.path.trim()) return { ok: false, message: "list.path cannot be empty" };
    if (!Number.isInteger(input.maxEntries) || input.maxEntries < 1 || input.maxEntries > 500) {
      return { ok: false, message: "list.maxEntries must be between 1 and 500" };
    }
    if (input.maxDepth !== undefined && (!Number.isInteger(input.maxDepth) || input.maxDepth < 0 || input.maxDepth > 50)) {
      return { ok: false, message: "list.maxDepth must be between 0 and 50" };
    }
    if (input.exclude.some((entry) => !entry.trim())) return { ok: false, message: "list.exclude entries cannot be empty" };
    return { ok: true, value: input };
  },
  isConcurrencySafe() {
    return true;
  },
  async call(input, context) {
    const root = workingDirectory(context);
    const target = resolveTarget(root, input.path ?? ".");
    const stat = await fs.stat(target).catch(() => undefined);
    if (!stat) return { ok: false, output: { error: `list.path does not exist: ${target}` } };

    if (stat.isFile()) {
      return {
        ok: true,
        output: { path: target, type: "file", size: stat.size, mtime: stat.mtime.toISOString(), extension: path.extname(target) || undefined },
        summary: "file",
      };
    }

    if (!stat.isDirectory()) {
      return { ok: false, output: { error: `list.path is not a regular file or directory: ${target}` } };
    }

    return listDirectory(target, input);
  },
};

async function listDirectory(target: string, input: ListDirectoryToolInput): Promise<ToolResult> {
  const entries: ListedEntry[] = [];
  const extensionCounts = new Map<string, number>();
  const excludedCounts = new Map<string, number>();
  const maxDepth = input.maxDepth ?? (input.recursive ? 4 : 0);
  const exclude = input.exclude.length ? input.exclude : DEFAULT_LIST_EXCLUDES;
  let totalFiles = 0;
  let totalDirectories = 0;
  let truncated = false;

  const visit = async (dir: string, depth: number): Promise<void> => {
    const children = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    children.sort(compareDirectoryEntries);

    for (const child of children) {
      if (!input.includeHidden && child.name.startsWith(".")) continue;
      const fullPath = path.join(dir, child.name);
      const excludedBy = findExcludeMatch(target, fullPath, child.name, exclude);
      if (excludedBy) {
        excludedCounts.set(excludedBy, (excludedCounts.get(excludedBy) ?? 0) + 1);
        continue;
      }
      const childStat = await fs.stat(fullPath).catch(() => undefined);
      if (!childStat) continue;

      if (child.isDirectory()) totalDirectories += 1;
      if (child.isFile()) {
        totalFiles += 1;
        const extension = path.extname(child.name).toLowerCase() || "[no extension]";
        extensionCounts.set(extension, (extensionCounts.get(extension) ?? 0) + 1);
      }

      if (entries.length < input.maxEntries) {
        entries.push({
          path: fullPath,
          name: child.name,
          type: child.isDirectory() ? "directory" : child.isFile() ? "file" : "other",
          size: childStat.size,
          mtime: childStat.mtime.toISOString(),
          depth,
          extension: child.isFile() ? path.extname(child.name) || undefined : undefined,
        });
      } else {
        truncated = true;
      }

      if (input.recursive && child.isDirectory() && depth < maxDepth) await visit(fullPath, depth + 1);
    }
  };

  await visit(target, 0);

  return {
    ok: true,
    output: {
      path: target,
      type: "directory",
      recursive: input.recursive,
      maxDepth,
      exclude,
      totalFiles,
      totalDirectories,
      returnedEntries: entries.length,
      truncated,
      truncation: truncated ? { reason: "maxEntries", maxEntries: input.maxEntries } : undefined,
      excludedCounts: Object.fromEntries([...excludedCounts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))),
      extensionCounts: Object.fromEntries([...extensionCounts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))),
      entries,
    },
    summary: `${totalFiles} file(s), ${totalDirectories} directory(s)${truncated ? ", truncated" : ""}`,
  };
}

const DEFAULT_LIST_EXCLUDES = [
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".vite",
  ".cache",
  ".idea",
  ".vscode",
  ".agent-tasks",
];

function workingDirectory(context: ToolUseContext): string {
  const snapshot = context.appState.snapshot();
  return path.resolve(snapshot.cwd ?? process.cwd());
}

function resolveTarget(root: string, targetPath: string): string {
  return path.isAbsolute(targetPath) ? path.normalize(targetPath) : path.resolve(root, targetPath);
}

function findExcludeMatch(root: string, fullPath: string, name: string, exclude: readonly string[]): string | undefined {
  const relative = path.relative(root, fullPath).split(path.sep).join("/");
  return exclude.find((entry) => {
    const normalized = entry.replace(/\\/g, "/").replace(/\/+$/, "");
    return name === normalized || relative === normalized || relative.startsWith(`${normalized}/`) || relative.includes(`/${normalized}/`);
  });
}

function compareDirectoryEntries(left: { isDirectory(): boolean; isFile(): boolean; name: string }, right: { isDirectory(): boolean; isFile(): boolean; name: string }): number {
  return entrySortRank(left) - entrySortRank(right) || left.name.localeCompare(right.name);
}

function entrySortRank(entry: { isDirectory(): boolean; isFile(): boolean; name: string }): number {
  const typeRank = entry.isDirectory() ? 0 : entry.isFile() ? 2 : 3;
  const hiddenRank = entry.name.startsWith(".") ? 1 : 0;
  return typeRank + hiddenRank;
}

function shrinkDirectoryOutputForTransport(output: unknown, maxChars: number): unknown {
  if (!isDirectoryOutput(output)) return output;
  const serialized = JSON.stringify(output);
  if (serialized.length <= maxChars) return output;

  const originalEntries = output.entries;
  const compacted: DirectoryOutput = {
    ...output,
    returnedEntries: 0,
    entries: [],
    transportTruncation: {
      reason: "resultSize",
      originalLength: serialized.length,
      entriesBeforeTransport: originalEntries.length,
      maxChars,
    },
  };

  for (let count = Math.min(originalEntries.length, output.returnedEntries); count >= 0; count -= 1) {
    compacted.entries = originalEntries.slice(0, count);
    compacted.returnedEntries = compacted.entries.length;
    const candidate = JSON.stringify(compacted);
    if (candidate.length <= maxChars) return compacted;
  }

  return compacted;
}

function isDirectoryOutput(output: unknown): output is DirectoryOutput {
  return typeof output === "object" && output !== null && (output as Partial<DirectoryOutput>).type === "directory" && Array.isArray((output as Partial<DirectoryOutput>).entries);
}

function looksBinary(buffer: Buffer): boolean {
  const sampleLength = Math.min(buffer.length, 4096);
  for (let index = 0; index < sampleLength; index += 1) {
    if (buffer[index] === 0) return true;
  }
  return false;
}

interface ListedEntry {
  path: string;
  name: string;
  type: "directory" | "file" | "other";
  size: number;
  mtime: string;
  depth: number;
  extension?: string;
}

interface DirectoryOutput {
  path: string;
  type: "directory";
  recursive: boolean;
  maxDepth: number;
  exclude: string[];
  totalFiles: number;
  totalDirectories: number;
  returnedEntries: number;
  truncated: boolean;
  truncation?: { reason: string; maxEntries: number };
  transportTruncation?: {
    reason: "resultSize";
    originalLength: number;
    entriesBeforeTransport: number;
    maxChars: number;
  };
  excludedCounts: Record<string, number>;
  extensionCounts: Record<string, number>;
  entries: ListedEntry[];
}

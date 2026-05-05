import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { Tool, ToolResult, ToolUseContext } from "../tool";
import { resolveBundledRipgrepBinary } from "./ripgrep-binary";

export interface SearchToolInput {
  query: string;
  path?: string;
  glob?: string[];
  caseMode: "smart" | "sensitive" | "insensitive";
  fixedStrings: boolean;
  includeHidden: boolean;
  contextLines: number;
  maxResults: number;
  maxColumns: number;
}

export interface SearchMatch {
  file: string;
  line: number;
  column?: number;
  text: string;
  submatches: Array<{ start: number; end: number; text: string }>;
}

export interface SearchToolOutput {
  query: string;
  root: string;
  path: string;
  total: number;
  truncated: boolean;
  matches: SearchMatch[];
  errors?: string[];
}

export const searchTool: Tool<SearchToolInput> = {
  name: "search",
  aliases: ["grep", "rg"],
  description: "Search files with the bundled ripgrep binary. Accepts absolute paths and cwd-relative paths. Use this for fast code and text search before reading files.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Regex pattern or literal text to search for." },
      path: { type: "string", description: "Absolute or cwd-relative file/directory to search. Defaults to the current working directory." },
      glob: {
        type: "array",
        items: { type: "string" },
        description: "Optional ripgrep glob filters such as src/**/*.ts or !dist/**.",
      },
      caseMode: { type: "string", enum: ["smart", "sensitive", "insensitive"], description: "Case handling mode." },
      fixedStrings: { type: "boolean", description: "Treat query as literal text instead of a regex." },
      includeHidden: { type: "boolean", description: "Include hidden files and directories while still respecting ignore files." },
      contextLines: { type: "integer", description: "Number of context lines around each match, 0-5." },
      maxResults: { type: "integer", description: "Maximum total matches to return, 1-200." },
      maxColumns: { type: "integer", description: "Maximum line width before ripgrep truncates a line, 80-1000." },
    },
    required: ["query"],
    additionalProperties: false,
  },
  metadata: {
    readOnly: true,
    concurrent: true,
    visible: true,
    maxResultSizeChars: 24000,
    searchHint: "search files with bundled ripgrep",
  },
  validate(input) {
    const record = input as Partial<SearchToolInput>;
    return {
      query: record.query ?? "",
      path: record.path,
      glob: record.glob,
      caseMode: record.caseMode ?? "smart",
      fixedStrings: record.fixedStrings ?? false,
      includeHidden: record.includeHidden ?? false,
      contextLines: record.contextLines ?? 0,
      maxResults: record.maxResults ?? 50,
      maxColumns: record.maxColumns ?? 300,
    };
  },
  validateInput(input) {
    if (!input.query.trim()) return { ok: false, message: "search.query cannot be empty" };
    if (input.path !== undefined && !input.path.trim()) return { ok: false, message: "search.path cannot be empty" };
    if (!Number.isInteger(input.contextLines) || input.contextLines < 0 || input.contextLines > 5) {
      return { ok: false, message: "search.contextLines must be between 0 and 5" };
    }
    if (!Number.isInteger(input.maxResults) || input.maxResults < 1 || input.maxResults > 200) {
      return { ok: false, message: "search.maxResults must be between 1 and 200" };
    }
    if (!Number.isInteger(input.maxColumns) || input.maxColumns < 80 || input.maxColumns > 1000) {
      return { ok: false, message: "search.maxColumns must be between 80 and 1000" };
    }
    if (input.glob?.some((glob) => !glob.trim())) return { ok: false, message: "search.glob entries cannot be empty" };
    return { ok: true, value: input };
  },
  isConcurrencySafe() {
    return true;
  },
  async call(input, context, options) {
    const { executablePath, platformKey } = resolveBundledRipgrepBinary();
    const root = workingDirectory(context);
    const target = path.resolve(root, input.path ?? ".");

    const stat = await fs.stat(target).catch(() => undefined);
    if (!stat) return { ok: false, output: { error: `search.path does not exist: ${target}` } };

    options.onProgress?.({ toolName: "search", message: `Searching with bundled rg (${platformKey})` });
    return runRipgrep(executablePath, root, target, input);
  },
};

function workingDirectory(context: ToolUseContext): string {
  const snapshot = context.appState.snapshot();
  return path.resolve(snapshot.cwd ?? process.cwd());
}

async function runRipgrep(
  executablePath: string,
  root: string,
  target: string,
  input: SearchToolInput,
): Promise<ToolResult> {
  const args = buildArgs(input, target);
  const matches: SearchMatch[] = [];
  const errors: string[] = [];
  let stderr = "";
  let stdoutBuffer = "";
  let truncated = false;

  const child = spawn(executablePath, args, { cwd: root, windowsHide: true });

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    let newline = stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (line) handleJsonLine(line, root, matches, errors);
      if (matches.length >= input.maxResults) {
        truncated = true;
        child.kill();
        break;
      }
      newline = stdoutBuffer.indexOf("\n");
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-12000);
  });

  return new Promise((resolve) => {
    child.on("error", (error) => {
      resolve({ ok: false, output: { error: error.message } });
    });

    child.on("close", (code) => {
      const remaining = stdoutBuffer.trim();
      if (remaining && !truncated) handleJsonLine(remaining, root, matches, errors);

      const output: SearchToolOutput = {
        query: input.query,
        root,
        path: path.relative(root, target) || ".",
        total: matches.length,
        truncated,
        matches,
        errors: errors.length ? errors : undefined,
      };

      if (code === 0 || code === 1 || truncated) {
        resolve({ ok: true, output, summary: `${matches.length}${truncated ? "+" : ""} match(es)` });
        return;
      }

      resolve({ ok: false, output: { ...output, error: stderr.trim() || `rg exited with code ${code}` } });
    });
  });
}

function buildArgs(input: SearchToolInput, target: string): string[] {
  const args = ["--json", "--color=never", "--line-number", "--column", "--with-filename", "--max-columns", String(input.maxColumns)];
  if (input.caseMode === "smart") args.push("--smart-case");
  if (input.caseMode === "insensitive") args.push("--ignore-case");
  if (input.fixedStrings) args.push("--fixed-strings");
  if (input.includeHidden) args.push("--hidden");
  if (input.contextLines > 0) args.push("--context", String(input.contextLines));
  for (const glob of input.glob ?? []) args.push("--glob", glob);
  args.push("--", input.query, target);
  return args;
}

function handleJsonLine(line: string, root: string, matches: SearchMatch[], errors: string[]): void {
  try {
    const event = JSON.parse(line) as RipgrepJsonEvent;
    if (event.type !== "match") return;
    const text = event.data.lines.text.replace(/[\r\n]+$/, "");
    matches.push({
      file: path.relative(root, event.data.path.text) || event.data.path.text,
      line: event.data.line_number,
      column: event.data.submatches[0]?.start + 1,
      text,
      submatches: event.data.submatches.map((submatch) => ({
        start: submatch.start,
        end: submatch.end,
        text: submatch.match.text,
      })),
    });
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
}

interface RipgrepJsonEvent {
  type: string;
  data: {
    path: { text: string };
    lines: { text: string };
    line_number: number;
    submatches: Array<{ start: number; end: number; match: { text: string } }>;
  };
}

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
  textTruncated?: {
    originalLength: number;
    maxChars: number;
  };
  submatches: Array<{ start: number; end: number; text: string }>;
  contextBefore?: SearchContextLine[];
  contextAfter?: SearchContextLine[];
}

export interface SearchContextLine {
  file: string;
  line: number;
  text: string;
  textTruncated?: {
    originalLength: number;
    maxChars: number;
  };
}

export interface SearchToolOutput {
  query: string;
  cwd: string;
  searchPath: string;
  returnedMatches: number;
  totalMatchesKnown: number | null;
  truncated: boolean;
  matches: SearchMatch[];
  transportTruncation?: {
    reason: "resultSize";
    originalLength: number;
    matchesBeforeTransport: number;
    omittedMatches: number;
    maxChars: number;
  };
  errors?: string[];
}

export const searchTool: Tool<SearchToolInput> = {
  name: "search",
  aliases: ["grep", "rg"],
  description: "Search files with the bundled ripgrep binary. Accepts absolute paths and cwd-relative paths. It does not exclude heavy directories by default; pass explicit negated glob filters such as !node_modules/** when you want to skip them.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Regex pattern or literal text to search for." },
      path: { type: "string", description: "Absolute or cwd-relative file/directory to search. Defaults to the current working directory." },
      glob: {
        type: "array",
        items: { type: "string" },
        description: "Optional ripgrep glob filters such as src/**/*.ts, !dist/**, or !node_modules/**.",
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
  mapResult(result) {
    return shrinkSearchOutputForTransport(result.output, 21000);
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
  const state: SearchParseState = {
    matches: [],
    errors: [],
    pendingContext: [],
    maxResults: input.maxResults,
    maxContextLines: input.contextLines,
    truncated: false,
    stopped: false,
    overflowedMaxResults: false,
  };
  let stderr = "";
  let stdoutBuffer = "";

  const child = spawn(executablePath, args, { cwd: root, windowsHide: true });

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (state.stopped) return;
    stdoutBuffer += chunk;
    let newline = stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (line) handleJsonLine(line, root, state);
      if (shouldStopSearch(state)) {
        state.stopped = true;
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
      if (remaining && !state.stopped) handleJsonLine(remaining, root, state);
      const matches = state.matches.slice(0, input.maxResults);
      const truncated = state.truncated || state.matches.length > input.maxResults;

      const output: SearchToolOutput = {
        query: input.query,
        cwd: root,
        searchPath: target,
        returnedMatches: matches.length,
        totalMatchesKnown: truncated ? null : matches.length,
        truncated,
        matches,
        errors: state.errors.length ? state.errors : undefined,
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

function handleJsonLine(line: string, root: string, state: SearchParseState): void {
  try {
    const event = JSON.parse(line) as RipgrepJsonEvent;
    if (event.type === "match") {
      if (state.matches.length >= state.maxResults) {
        state.truncated = true;
        state.overflowedMaxResults = true;
        return;
      }
      const match = mapMatchEvent(event, root);
      if (state.pendingContext.length) {
        match.contextBefore = state.pendingContext.slice(-state.maxContextLines);
        state.pendingContext = [];
      }
      state.matches.push(match);
      if (state.matches.length >= state.maxResults) state.truncated = true;
      return;
    }

    if (event.type === "context" && state.maxContextLines > 0) {
      const context = mapContextEvent(event, root);
      const lastMatch = state.matches[state.matches.length - 1];
      if (!lastMatch) {
        state.pendingContext = [...state.pendingContext, context].slice(-state.maxContextLines);
        return;
      }
      const contextAfter = [...(lastMatch.contextAfter ?? []), context].slice(0, state.maxContextLines);
      lastMatch.contextAfter = contextAfter;
    }
  } catch (error) {
    state.errors.push(error instanceof Error ? error.message : String(error));
  }
}

function mapMatchEvent(event: RipgrepJsonEvent, root: string): SearchMatch {
  const text = normalizeLine(event.data.lines.text);
  return {
    file: relativeEventPath(root, event),
    line: event.data.line_number,
    column: event.data.submatches[0]?.start + 1,
    text,
    submatches: event.data.submatches.map((submatch) => ({
      start: submatch.start,
      end: submatch.end,
      text: submatch.match.text,
    })),
  };
}

function mapContextEvent(event: RipgrepJsonEvent, root: string): SearchContextLine {
  return {
    file: relativeEventPath(root, event),
    line: event.data.line_number,
    text: normalizeLine(event.data.lines.text),
  };
}

function relativeEventPath(root: string, event: RipgrepJsonEvent): string {
  return path.relative(root, event.data.path.text) || event.data.path.text;
}

function normalizeLine(text: string): string {
  return text.replace(/[\r\n]+$/, "");
}

function shouldStopSearch(state: SearchParseState): boolean {
  if (!state.truncated) return false;
  if (state.overflowedMaxResults) return true;
  if (state.maxContextLines === 0) return true;
  const lastMatch = state.matches[state.matches.length - 1];
  return (lastMatch?.contextAfter?.length ?? 0) >= state.maxContextLines;
}

function shrinkSearchOutputForTransport(output: unknown, maxChars: number): unknown {
  if (!isSearchOutput(output)) return output;
  const boundedOutput = boundLongSearchLines(output);
  const serialized = JSON.stringify(boundedOutput);
  if (serialized.length <= maxChars) return boundedOutput;

  const originalMatches = boundedOutput.matches;
  const transportTruncation = {
    reason: "resultSize" as const,
    originalLength: serialized.length,
    matchesBeforeTransport: originalMatches.length,
    omittedMatches: originalMatches.length,
    maxChars,
  };
  const compacted: SearchToolOutput = {
    ...boundedOutput,
    returnedMatches: 0,
    matches: [],
    truncated: true,
    totalMatchesKnown: boundedOutput.truncated ? boundedOutput.totalMatchesKnown : originalMatches.length,
    transportTruncation,
  };

  for (let count = originalMatches.length; count >= 0; count -= 1) {
    compacted.matches = originalMatches.slice(0, count);
    compacted.returnedMatches = compacted.matches.length;
    compacted.transportTruncation = {
      reason: transportTruncation.reason,
      originalLength: transportTruncation.originalLength,
      matchesBeforeTransport: transportTruncation.matchesBeforeTransport,
      maxChars: transportTruncation.maxChars,
      omittedMatches: originalMatches.length - count,
    };
    const candidate = JSON.stringify(compacted);
    if (candidate.length <= maxChars) return compacted;
  }

  return compacted;
}

function isSearchOutput(output: unknown): output is SearchToolOutput {
  return typeof output === "object" && output !== null && Array.isArray((output as Partial<SearchToolOutput>).matches);
}

function boundLongSearchLines(output: SearchToolOutput): SearchToolOutput {
  return {
    ...output,
    matches: output.matches.map((match) => ({
      ...match,
      ...truncateTextField(match.text, MAX_MATCH_TEXT_CHARS),
      submatches: match.submatches.map((submatch) => ({
        ...submatch,
        text: truncatePlainText(submatch.text, MAX_SUBMATCH_TEXT_CHARS),
      })),
      contextBefore: match.contextBefore?.map(truncateContextLine),
      contextAfter: match.contextAfter?.map(truncateContextLine),
    })),
  };
}

function truncateContextLine(line: SearchContextLine): SearchContextLine {
  return {
    ...line,
    ...truncateTextField(line.text, MAX_CONTEXT_TEXT_CHARS),
  };
}

function truncateTextField(text: string, maxChars: number): { text: string; textTruncated?: { originalLength: number; maxChars: number } } {
  if (text.length <= maxChars) return { text };
  return {
    text: `${text.slice(0, maxChars)}...[truncated ${text.length - maxChars} chars]`,
    textTruncated: { originalLength: text.length, maxChars },
  };
}

function truncatePlainText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}...[truncated ${text.length - maxChars} chars]`;
}

const MAX_MATCH_TEXT_CHARS = 4000;
const MAX_CONTEXT_TEXT_CHARS = 2000;
const MAX_SUBMATCH_TEXT_CHARS = 500;

interface SearchParseState {
  matches: SearchMatch[];
  errors: string[];
  pendingContext: SearchContextLine[];
  maxResults: number;
  maxContextLines: number;
  truncated: boolean;
  stopped: boolean;
  overflowedMaxResults: boolean;
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

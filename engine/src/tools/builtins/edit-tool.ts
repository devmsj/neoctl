import fs from "node:fs/promises";
import path from "node:path";
import type { Tool, ToolResult, ToolUseContext } from "../tool.js";

export interface EditToolInput {
  path: string;
  oldString: string;
  newString: string;
  replaceAll: boolean;
}

export interface WriteToolInput {
  path: string;
  content: string;
}

export interface TextEditOutput {
  path: string;
  operation: "create" | "edit" | "write";
  replacements: number;
  bytesBefore: number;
  bytesAfter: number;
  lineEnding: "LF" | "CRLF" | "CR" | "mixed" | "none";
  encoding: "utf8" | "utf16le";
  patch: PatchHunk[];
}

export interface PatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export const editTool: Tool<EditToolInput> = {
  name: "edit",
  aliases: ["replace"],
  description:
    "Modify a text file by replacing oldString with newString. oldString must match uniquely unless replaceAll is true; LF/CRLF line-ending differences and straight/curly quote differences are tolerated. Use oldString='' only to create a new file.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute or cwd-relative path of the text file to modify." },
      oldString: { type: "string", description: "Text to replace. LF/CRLF line-ending differences and straight/curly quote differences are tolerated. Use an empty string only when creating a new file." },
      newString: { type: "string", description: "Replacement text. Must differ from oldString." },
      replaceAll: { type: "boolean", description: "Replace every occurrence of oldString. Defaults to false." },
    },
    required: ["path", "oldString", "newString"],
    additionalProperties: false,
  },
  metadata: {
    readOnly: false,
    concurrent: false,
    visible: true,
    requiresApproval: false,
    destructive: true,
    maxResultSizeChars: 100000,
    searchHint: "edit text files by exact string replacement",
  },
  validate(input) {
    const record = input as Partial<EditToolInput>;
    return {
      path: record.path ?? "",
      oldString: record.oldString ?? "",
      newString: record.newString ?? "",
      replaceAll: record.replaceAll ?? false,
    };
  },
  validateInput(input) {
    if (!input.path.trim()) return { ok: false, message: "edit.path cannot be empty" };
    if (input.oldString === input.newString) return { ok: false, message: "edit.oldString and edit.newString must differ" };
    return { ok: true, value: input };
  },
  isConcurrencySafe() {
    return false;
  },
  async call(input, context) {
    const target = resolveTarget(context, input.path);
    const current = await readExistingText(target);

    if (!current.exists) {
      if (input.oldString !== "") {
        return { ok: false, output: { error: `edit.path does not exist: ${target}. Use oldString='' to create a new file.` } };
      }
      return writeUpdatedText({
        target,
        before: "",
        after: input.newString,
        replacements: 1,
        operation: "create",
        encoding: "utf8",
        lineEnding: detectLineEnding(input.newString),
      });
    }

    if (input.oldString === "") {
      if (current.content.trim() !== "") return { ok: false, output: { error: "Cannot create file because edit.path already exists and is not empty", path: target } };
      return writeUpdatedText({
        target,
        before: current.content,
        after: input.newString,
        replacements: 1,
        operation: "edit",
        encoding: current.encoding,
        lineEnding: current.lineEnding,
      });
    }

    const match = findActualString(current.content, input.oldString);
    if (!match) {
      return {
        ok: false,
        output: {
          error: "String to replace not found in file",
          path: target,
          oldString: input.oldString,
        },
      };
    }

    const actualOldString = match.actual;
    const matches = countOccurrences(current.content, actualOldString);
    if (matches > 1 && !input.replaceAll) {
      return {
        ok: false,
        output: {
          error: `Found ${matches} matches of oldString, but replaceAll is false. Provide more context or set replaceAll=true.`,
          path: target,
          matches,
        },
      };
    }

    const actualNewString = adaptReplacementString(input.oldString, actualOldString, input.newString);
    const after = input.replaceAll
      ? current.content.replaceAll(actualOldString, actualNewString)
      : replaceOne(current.content, actualOldString, actualNewString);

    return writeUpdatedText({
      target,
      before: current.content,
      after,
      replacements: input.replaceAll ? matches : 1,
      operation: "edit",
      encoding: current.encoding,
      lineEnding: current.lineEnding,
    });
  },
};

export const writeTool: Tool<WriteToolInput> = {
  name: "write",
  aliases: ["overwrite"],
  description: "Create or overwrite a text file with the provided full content.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute or cwd-relative path of the file to write." },
      content: { type: "string", description: "Full text content to write." },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  metadata: {
    readOnly: false,
    concurrent: false,
    visible: true,
    requiresApproval: false,
    destructive: true,
    maxResultSizeChars: 100000,
    searchHint: "create or overwrite text files",
  },
  validate(input) {
    const record = input as Partial<WriteToolInput>;
    return {
      path: record.path ?? "",
      content: record.content ?? "",
    };
  },
  validateInput(input) {
    if (!input.path.trim()) return { ok: false, message: "write.path cannot be empty" };
    return { ok: true, value: input };
  },
  isConcurrencySafe() {
    return false;
  },
  async call(input, context) {
    const target = resolveTarget(context, input.path);
    const current = await readExistingText(target);
    return writeUpdatedText({
      target,
      before: current.exists ? current.content : "",
      after: input.content,
      replacements: current.exists ? 1 : 0,
      operation: current.exists ? "write" : "create",
      encoding: current.exists ? current.encoding : "utf8",
      lineEnding: current.exists ? current.lineEnding : detectLineEnding(input.content),
    });
  },
};

async function writeUpdatedText(input: {
  target: string;
  before: string;
  after: string;
  replacements: number;
  operation: TextEditOutput["operation"];
  encoding: "utf8" | "utf16le";
  lineEnding: TextEditOutput["lineEnding"];
}): Promise<ToolResult> {
  await fs.mkdir(path.dirname(input.target), { recursive: true });
  await fs.writeFile(input.target, encodeText(input.after, input.encoding));
  const output: TextEditOutput = {
    path: input.target,
    operation: input.operation,
    replacements: input.replacements,
    bytesBefore: Buffer.byteLength(input.before),
    bytesAfter: Buffer.byteLength(input.after),
    lineEnding: input.lineEnding,
    encoding: input.encoding,
    patch: buildPatch(input.before, input.after),
  };
  return {
    ok: true,
    output,
    summary: `${input.operation} ${input.target}, ${input.replacements} replacement(s), ${countChangedLines(output.patch).added} added/${countChangedLines(output.patch).removed} removed`,
  };
}

async function readExistingText(target: string): Promise<
  | { exists: false }
  | { exists: true; content: string; encoding: "utf8" | "utf16le"; lineEnding: TextEditOutput["lineEnding"] }
> {
  const buffer = await fs.readFile(target).catch((error) => {
    if (isNotFound(error)) return undefined;
    throw error;
  });
  if (!buffer) return { exists: false };
  if (looksBinary(buffer)) throw new Error(`edit.path appears to be binary: ${target}`);
  const encoding = detectEncoding(buffer);
  const content = decodeText(buffer, encoding);
  return {
    exists: true,
    content,
    encoding,
    lineEnding: detectLineEnding(content),
  };
}

function resolveTarget(context: ToolUseContext, targetPath: string): string {
  const root = path.resolve(context.appState.snapshot().cwd ?? process.cwd());
  return path.isAbsolute(targetPath) ? path.normalize(targetPath) : path.resolve(root, targetPath);
}

function findActualString(fileContent: string, searchString: string): { actual: string } | null {
  if (fileContent.includes(searchString)) return { actual: searchString };
  const normalizedSearch = normalizeForMatch(searchString);
  const match = findNormalizedMatch(fileContent, normalizedSearch);
  return match ? { actual: fileContent.slice(match.start, match.end) } : null;
}

function normalizeForMatch(value: string): string {
  return normalizeLineEndings(normalizeQuotes(value));
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function findNormalizedMatch(fileContent: string, normalizedSearch: string): { start: number; end: number } | null {
  if (!normalizedSearch) return null;
  const indexMap: number[] = [];
  let normalizedFile = "";

  for (let index = 0; index < fileContent.length; index += 1) {
    const char = fileContent[index];
    if (char === "\r") {
      normalizedFile += "\n";
      indexMap.push(index);
      if (fileContent[index + 1] === "\n") index += 1;
      continue;
    }

    normalizedFile += normalizeQuotes(char);
    indexMap.push(index);
  }

  const normalizedIndex = normalizedFile.indexOf(normalizedSearch);
  if (normalizedIndex < 0) return null;

  const normalizedEnd = normalizedIndex + normalizedSearch.length;
  const start = indexMap[normalizedIndex];
  const end = normalizedEnd < indexMap.length ? indexMap[normalizedEnd] : fileContent.length;
  return { start, end };
}

const LEFT_SINGLE = "\u2018";
const RIGHT_SINGLE = "\u2019";
const LEFT_DOUBLE = "\u201c";
const RIGHT_DOUBLE = "\u201d";

function normalizeQuotes(value: string): string {
  return value
    .replaceAll(LEFT_SINGLE, "'")
    .replaceAll(RIGHT_SINGLE, "'")
    .replaceAll(LEFT_DOUBLE, "\"")
    .replaceAll(RIGHT_DOUBLE, "\"");
}

function adaptReplacementString(oldString: string, actualOldString: string, newString: string): string {
  let result = newString;
  if (oldString !== actualOldString) {
    result = preserveLineEndingStyle(oldString, actualOldString, result);
    result = preserveQuoteStyle(actualOldString, result);
  }
  return result;
}

function preserveLineEndingStyle(oldString: string, actualOldString: string, newString: string): string {
  if (lineEndingPattern(oldString) !== "LF") return newString;
  const actualPattern = lineEndingPattern(actualOldString);
  if (actualPattern === "CRLF") return newString.replace(/(?<!\r)\n/g, "\r\n");
  if (actualPattern === "CR") return newString.replace(/\r?\n/g, "\r");
  return newString;
}

function lineEndingPattern(value: string): "LF" | "CRLF" | "CR" | "mixed" | "none" {
  const hasCrLf = /\r\n/.test(value);
  const withoutCrLf = value.replace(/\r\n/g, "");
  const hasLf = withoutCrLf.includes("\n");
  const hasCr = withoutCrLf.includes("\r");
  const kinds = [hasCrLf, hasLf, hasCr].filter(Boolean).length;
  if (kinds === 0) return "none";
  if (kinds > 1) return "mixed";
  if (hasCrLf) return "CRLF";
  if (hasCr) return "CR";
  return "LF";
}

function preserveQuoteStyle(actualOldString: string, newString: string): string {
  let result = newString;
  if (actualOldString.includes(LEFT_DOUBLE) || actualOldString.includes(RIGHT_DOUBLE)) result = applyCurlyQuotes(result, "\"", LEFT_DOUBLE, RIGHT_DOUBLE);
  if (actualOldString.includes(LEFT_SINGLE) || actualOldString.includes(RIGHT_SINGLE)) result = applyCurlyQuotes(result, "'", LEFT_SINGLE, RIGHT_SINGLE);
  return result;
}

function applyCurlyQuotes(value: string, quote: string, left: string, right: string): string {
  const chars = [...value];
  return chars.map((char, index) => {
    if (char !== quote) return char;
    const previous = chars[index - 1];
    const next = chars[index + 1];
    if (quote === "'" && previous && next && /\p{L}/u.test(previous) && /\p{L}/u.test(next)) return right;
    return !previous || /[\s([{]/.test(previous) ? left : right;
  }).join("");
}

function countOccurrences(value: string, search: string): number {
  if (!search) return 0;
  let count = 0;
  let index = 0;
  while (true) {
    index = value.indexOf(search, index);
    if (index < 0) return count;
    count += 1;
    index += search.length;
  }
}

function replaceOne(value: string, search: string, replacement: string): string {
  const index = value.indexOf(search);
  if (index < 0) return value;
  return `${value.slice(0, index)}${replacement}${value.slice(index + search.length)}`;
}

function buildPatch(before: string, after: string): PatchHunk[] {
  if (before === after) return [];
  const beforeLines = splitLinesForDiff(before);
  const afterLines = splitLinesForDiff(after);
  let prefix = 0;
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const contextBefore = Math.min(3, prefix);
  const oldStartIndex = prefix - contextBefore;
  const newStartIndex = prefix - contextBefore;
  const oldChangedEnd = beforeLines.length - suffix;
  const newChangedEnd = afterLines.length - suffix;
  const contextAfter = Math.min(3, suffix);
  const oldEndIndex = oldChangedEnd + contextAfter;
  const newEndIndex = newChangedEnd + contextAfter;
  const lines: string[] = [];

  for (let index = oldStartIndex; index < prefix; index += 1) lines.push(` ${beforeLines[index]}`);
  for (let index = prefix; index < oldChangedEnd; index += 1) lines.push(`-${beforeLines[index]}`);
  for (let index = prefix; index < newChangedEnd; index += 1) lines.push(`+${afterLines[index]}`);
  for (let index = oldChangedEnd; index < oldEndIndex; index += 1) lines.push(` ${beforeLines[index]}`);

  return [{
    oldStart: oldStartIndex + 1,
    oldLines: oldEndIndex - oldStartIndex,
    newStart: newStartIndex + 1,
    newLines: newEndIndex - newStartIndex,
    lines,
  }];
}

function splitLinesForDiff(value: string): string[] {
  if (value === "") return [];
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

function countChangedLines(patch: readonly PatchHunk[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const hunk of patch) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) added += 1;
      if (line.startsWith("-")) removed += 1;
    }
  }
  return { added, removed };
}

function detectEncoding(buffer: Buffer): "utf8" | "utf16le" {
  return buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe ? "utf16le" : "utf8";
}

function decodeText(buffer: Buffer, encoding: "utf8" | "utf16le"): string {
  const text = buffer.toString(encoding);
  return text.replace(/^\uFEFF/, "");
}

function encodeText(text: string, encoding: "utf8" | "utf16le"): Buffer {
  if (encoding === "utf16le") return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
  return Buffer.from(text, "utf8");
}

function detectLineEnding(text: string): TextEditOutput["lineEnding"] {
  const crlf = /\r\n/.test(text);
  const withoutCrlf = text.replace(/\r\n/g, "");
  const lf = /\n/.test(withoutCrlf);
  const cr = /\r/.test(withoutCrlf);
  const count = [crlf, lf, cr].filter(Boolean).length;
  if (count > 1) return "mixed";
  if (crlf) return "CRLF";
  if (lf) return "LF";
  if (cr) return "CR";
  return "none";
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  if (detectEncoding(buffer) === "utf16le") return false;
  return sample.includes(0);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}

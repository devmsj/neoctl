import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { InMemoryAppState } from "../app/app-state.js";
import type { Message } from "../types/messages.js";
import { echoTool } from "./builtins/echo-tool.js";
import { editTool, writeTool } from "./builtins/edit-tool.js";
import { execTool } from "./builtins/exec-tool.js";
import { listDirectoryTool, readFileTool } from "./builtins/filesystem-tools.js";
import { searchTool } from "./builtins/search-tool.js";
import { ToolRegistry } from "./registry.js";
import { runToolUseToMessages } from "./run-tool-use.js";
import { runTools } from "./tool-orchestration.js";
import type { Tool, ToolUseContext } from "./tool.js";

const delayTool: Tool<{ id: string; delayMs: number }> = {
  name: "delay",
  description: "Wait briefly and return an id.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" }, delayMs: { type: "integer" } },
    required: ["id", "delayMs"],
    additionalProperties: false,
  },
  metadata: { readOnly: true, concurrent: true, visible: true },
  validate(input) {
    return input as { id: string; delayMs: number };
  },
  async call(input) {
    await new Promise((resolve) => setTimeout(resolve, input.delayMs));
    return { ok: true, output: input.id };
  },
};

const largeTool: Tool<{ size: number }> = {
  name: "large",
  description: "Return a large string for truncation tests.",
  inputSchema: {
    type: "object",
    properties: { size: { type: "integer" } },
    required: ["size"],
    additionalProperties: false,
  },
  metadata: { readOnly: true, concurrent: true, visible: true, maxResultSizeChars: 8 },
  validate(input) {
    return input as { size: number };
  },
  async call(input) {
    return { ok: true, output: "x".repeat(input.size) };
  },
};

async function main(): Promise<void> {
  const registry = new ToolRegistry();
  registry.register(echoTool);
  registry.register(editTool);
  registry.register(writeTool);
  registry.register(execTool);
  registry.register(listDirectoryTool);
  registry.register(readFileTool);
  registry.register(searchTool);
  registry.register(delayTool);
  registry.register(largeTool);

  const context: ToolUseContext = {
    agentId: "tool-smoke",
    tools: registry,
    appState: new InMemoryAppState("tool-smoke", process.cwd()),
    emit: () => undefined,
  };
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-tools-smoke-"));

  const valid = await runToolUseToMessages({ id: "echo1", name: "say", input: { text: "ok" } }, context);
  const invalid = await runToolUseToMessages({ id: "echo2", name: "echo", input: { text: "" } }, context);
  const unknown = await runToolUseToMessages({ id: "missing", name: "missing", input: {} }, context);
  const large = await runToolUseToMessages({ id: "large", name: "large", input: { size: 20 } }, context);
  const search = await runToolUseToMessages(
    { id: "search", name: "search", input: { query: "echoTool", path: "src/tools/builtins/echo-tool.ts", maxResults: 5 } },
    context,
  );
  const truncatedSearch = await runToolUseToMessages(
    { id: "search-truncated", name: "search", input: { query: "import", path: "src", maxResults: 1 } },
    context,
  );
  const contextSearch = await runToolUseToMessages(
    { id: "search-context", name: "search", input: { query: "description", path: "src/tools/builtins/echo-tool.ts", contextLines: 1, maxResults: 2 } },
    context,
  );
  const read = await runToolUseToMessages(
    { id: "read", name: "read", input: { path: "src/tools/builtins/echo-tool.ts", offset: 1, limit: 5 } },
    context,
  );
  const list = await runToolUseToMessages(
    { id: "list", name: "list", input: { path: "src/tools/builtins", recursive: false, maxEntries: 20 } },
    context,
  );
  const recursiveListRoot = path.join(tempDir, "recursive-list");
  await fs.mkdir(path.join(recursiveListRoot, ".idea"), { recursive: true });
  await fs.mkdir(path.join(recursiveListRoot, ".agent-tasks"), { recursive: true });
  await fs.mkdir(path.join(recursiveListRoot, "visible"), { recursive: true });
  await fs.writeFile(path.join(recursiveListRoot, ".idea", "workspace.xml"), "ignored", "utf8");
  await fs.writeFile(path.join(recursiveListRoot, ".agent-tasks", "task.json"), "ignored", "utf8");
  await fs.writeFile(path.join(recursiveListRoot, "visible", "keep.ts"), "export {};", "utf8");
  const recursiveList = await runToolUseToMessages(
    { id: "list-recursive", name: "list", input: { path: recursiveListRoot, recursive: true, maxEntries: 20, includeHidden: true } },
    context,
  );
  const exec = await runToolUseToMessages(
    { id: "exec", name: "exec", input: { command: "node -e \"console.log(process.cwd()); console.error('warn')\"", timeoutMs: 10000, maxOutputChars: 4000 } },
    context,
  );
  const execFailure = await runToolUseToMessages(
    { id: "exec-fail", name: "exec", input: { command: "node -e \"process.exit(7)\"", timeoutMs: 10000 } },
    context,
  );
  const editCreate = await runToolUseToMessages(
    { id: "edit-create", name: "edit", input: { path: path.join(tempDir, "sample.txt"), oldString: "", newString: "alpha\nbeta\nalpha\n" } },
    context,
  );
  const editAmbiguous = await runToolUseToMessages(
    { id: "edit-ambiguous", name: "edit", input: { path: path.join(tempDir, "sample.txt"), oldString: "alpha", newString: "gamma" } },
    context,
  );
  const editReplaceAll = await runToolUseToMessages(
    { id: "edit-all", name: "edit", input: { path: path.join(tempDir, "sample.txt"), oldString: "alpha", newString: "gamma", replaceAll: true } },
    context,
  );
  const crlfPath = path.join(tempDir, "crlf.txt");
  await fs.writeFile(crlfPath, "one\r\ntwo\r\nthree\r\n", "utf8");
  const editCrlfWithLfOldString = await runToolUseToMessages(
    { id: "edit-crlf-lf-old", name: "edit", input: { path: crlfPath, oldString: "one\ntwo\n", newString: "uno\ndos\n" } },
    context,
  );
  const write = await runToolUseToMessages(
    { id: "write", name: "write", input: { path: path.join(tempDir, "nested", "write.txt"), content: "full\ncontent\n" } },
    context,
  );
  const searchOutput = toolOutput(search[search.length - 1]) as {
    cwd?: string;
    searchPath?: string;
    returnedMatches?: number;
    totalMatchesKnown?: number | null;
  };
  const truncatedSearchOutput = toolOutput(truncatedSearch[truncatedSearch.length - 1]) as {
    returnedMatches?: number;
    totalMatchesKnown?: number | null;
    truncated?: boolean;
  };
  const contextSearchOutput = toolOutput(contextSearch[contextSearch.length - 1]) as {
    matches?: Array<{ contextBefore?: unknown[]; contextAfter?: unknown[] }>;
  };
  const recursiveListOutput = toolOutput(recursiveList[recursiveList.length - 1]) as {
    exclude?: string[];
    excludedCounts?: Record<string, number>;
    entries?: Array<{ name: string; path: string }>;
  };
  const execOutput = toolOutput(exec[exec.length - 1]) as {
    exitCode?: number | null;
    stdout?: string;
    stderr?: string;
    cwd?: string;
  };
  const execFailureOutput = toolOutput(execFailure[execFailure.length - 1]) as {
    exitCode?: number | null;
  };
  const editCreateOutput = toolOutput(editCreate[editCreate.length - 1]) as {
    operation?: string;
    replacements?: number;
    patch?: unknown[];
  };
  const editReplaceAllOutput = toolOutput(editReplaceAll[editReplaceAll.length - 1]) as {
    operation?: string;
    replacements?: number;
    patch?: unknown[];
  };
  const editCrlfWithLfOldStringOutput = toolOutput(editCrlfWithLfOldString[editCrlfWithLfOldString.length - 1]) as {
    operation?: string;
    replacements?: number;
  };
  const writeOutput = toolOutput(write[write.length - 1]) as {
    operation?: string;
    bytesAfter?: number;
  };
  const started = Date.now();
  const batch = await runTools(
    [
      { id: "d1", name: "delay", input: { id: "a", delayMs: 60 } },
      { id: "d2", name: "delay", input: { id: "b", delayMs: 60 } },
    ],
    context,
  );
  const elapsedMs = Date.now() - started;

  const checks = {
    validTool: toolOk(valid[valid.length - 1]),
    invalidRejected: !toolOk(invalid[invalid.length - 1]),
    unknownRejected: !toolOk(unknown[0]),
    transportTruncationLabel: JSON.stringify(large[large.length - 1]).includes("truncated"),
    searchOk: toolOk(search[search.length - 1]),
    searchFindsFile: JSON.stringify(search[search.length - 1]).includes("echo-tool.ts"),
    searchFields: searchOutput.cwd !== undefined && searchOutput.searchPath !== undefined,
    searchKnownTotal: searchOutput.returnedMatches === searchOutput.totalMatchesKnown,
    searchNoLegacyRoot: !JSON.stringify(search[search.length - 1]).includes('"root"'),
    truncatedSearchOk: toolOk(truncatedSearch[truncatedSearch.length - 1]),
    truncatedSearchCounts:
      truncatedSearchOutput.returnedMatches === 1 &&
      truncatedSearchOutput.totalMatchesKnown === null &&
      truncatedSearchOutput.truncated === true,
    contextSearchOk: toolOk(contextSearch[contextSearch.length - 1]),
    contextSearchLines:
      (contextSearchOutput.matches?.some((match) => (match.contextBefore?.length ?? 0) > 0) ?? false) ||
      (contextSearchOutput.matches?.some((match) => (match.contextAfter?.length ?? 0) > 0) ?? false),
    readOk: toolOk(read[read.length - 1]),
    readLineMetadata: JSON.stringify(read[read.length - 1]).includes('"startLine":1'),
    readContent: JSON.stringify(read[read.length - 1]).includes("echoTool"),
    listOk: toolOk(list[list.length - 1]),
    listFindsFile: JSON.stringify(list[list.length - 1]).includes("search-tool.ts"),
    recursiveListOk: toolOk(recursiveList[recursiveList.length - 1]),
    recursiveListDefaultExcludes:
      recursiveListOutput.exclude?.includes(".git") === true &&
      recursiveListOutput.exclude?.includes(".idea") === true &&
      recursiveListOutput.exclude?.includes(".agent-tasks") === true,
    recursiveListTracksExcluded:
      recursiveListOutput.excludedCounts?.[".idea"] !== undefined &&
      recursiveListOutput.excludedCounts?.[".agent-tasks"] !== undefined,
    recursiveListEntriesClean:
      recursiveListOutput.entries?.every((entry) => ![".git", ".idea", ".agent-tasks", "node_modules", "dist"].includes(entry.name)) === true,
    execOk:
      toolOk(exec[exec.length - 1]) &&
      execOutput.exitCode === 0 &&
      execOutput.stdout?.includes(process.cwd()) === true &&
      execOutput.stderr?.includes("warn") === true,
    execFailureRejected:
      !toolOk(execFailure[execFailure.length - 1]) &&
      typeof execFailureOutput.exitCode === "number" &&
      execFailureOutput.exitCode !== 0,
    editCreateOk:
      toolOk(editCreate[editCreate.length - 1]) &&
      editCreateOutput.operation === "create" &&
      editCreateOutput.replacements === 1 &&
      (editCreateOutput.patch?.length ?? 0) > 0,
    editAmbiguousRejected: !toolOk(editAmbiguous[editAmbiguous.length - 1]),
    editReplaceAllOk:
      toolOk(editReplaceAll[editReplaceAll.length - 1]) &&
      editReplaceAllOutput.operation === "edit" &&
      editReplaceAllOutput.replacements === 2 &&
      (await fs.readFile(path.join(tempDir, "sample.txt"), "utf8")).includes("gamma\nbeta\ngamma"),
    editCrlfWithLfOldStringOk:
      toolOk(editCrlfWithLfOldString[editCrlfWithLfOldString.length - 1]) &&
      editCrlfWithLfOldStringOutput.operation === "edit" &&
      editCrlfWithLfOldStringOutput.replacements === 1 &&
      (await fs.readFile(crlfPath, "utf8")) === "uno\r\ndos\r\nthree\r\n",
    writeOk:
      toolOk(write[write.length - 1]) &&
      writeOutput.operation === "create" &&
      writeOutput.bytesAfter === Buffer.byteLength("full\ncontent\n") &&
      (await fs.readFile(path.join(tempDir, "nested", "write.txt"), "utf8")) === "full\ncontent\n",
    batchMessages: batch.messages.length === 4,
    batchConcurrent: elapsedMs < 110,
  };
  const ok = Object.values(checks).every(Boolean);

  console.log(JSON.stringify({ ok, elapsedMs, checks, counts: { valid: valid.length, invalid: invalid.length, unknown: unknown.length, large: large.length, search: search.length, truncatedSearch: truncatedSearch.length, contextSearch: contextSearch.length, read: read.length, list: list.length, recursiveList: recursiveList.length, exec: exec.length, execFailure: execFailure.length, editCreate: editCreate.length, editAmbiguous: editAmbiguous.length, editReplaceAll: editReplaceAll.length, editCrlfWithLfOldString: editCrlfWithLfOldString.length, write: write.length, batch: batch.messages.length } }, null, 2));
  if (!ok) process.exitCode = 1;
}

function toolOk(message: Message): boolean {
  return message.blocks.every((block) => block.type !== "tool_result" || block.ok);
}

function toolOutput(message: Message): unknown {
  const block = message.blocks.find((candidate) => candidate.type === "tool_result");
  return block?.type === "tool_result" ? block.output : undefined;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

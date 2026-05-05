import { InMemoryAppState } from "../app/app-state";
import type { Message } from "../types/messages";
import { echoTool } from "./builtins/echo-tool";
import { listDirectoryTool, readFileTool } from "./builtins/filesystem-tools";
import { searchTool } from "./builtins/search-tool";
import { ToolRegistry } from "./registry";
import { runToolUseToMessages } from "./run-tool-use";
import { runTools } from "./tool-orchestration";
import type { Tool, ToolUseContext } from "./tool";

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
  const read = await runToolUseToMessages(
    { id: "read", name: "read", input: { path: "src/tools/builtins/echo-tool.ts", offset: 1, limit: 5 } },
    context,
  );
  const list = await runToolUseToMessages(
    { id: "list", name: "list", input: { path: "src/tools/builtins", recursive: false, maxEntries: 20 } },
    context,
  );
  const recursiveList = await runToolUseToMessages(
    { id: "list-recursive", name: "list", input: { path: ".", recursive: true, maxEntries: 20, includeHidden: true } },
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
  const recursiveListOutput = toolOutput(recursiveList[recursiveList.length - 1]) as {
    exclude?: string[];
    excludedCounts?: Record<string, number>;
    entries?: Array<{ name: string; path: string }>;
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
      (truncatedSearchOutput.returnedMatches ?? 0) >= 1 &&
      truncatedSearchOutput.totalMatchesKnown === null &&
      truncatedSearchOutput.truncated === true,
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
    batchMessages: batch.messages.length === 4,
    batchConcurrent: elapsedMs < 110,
  };
  const ok = Object.values(checks).every(Boolean);

  console.log(JSON.stringify({ ok, elapsedMs, checks, counts: { valid: valid.length, invalid: invalid.length, unknown: unknown.length, large: large.length, search: search.length, truncatedSearch: truncatedSearch.length, read: read.length, list: list.length, recursiveList: recursiveList.length, batch: batch.messages.length } }, null, 2));
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

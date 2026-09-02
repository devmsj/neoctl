import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { InMemoryAppState } from "../app/app-state.js";
import type { Message } from "../types/messages.js";
import { editTool, writeTool } from "./builtins/edit-tool.js";
import { createExecTool, createWriteStdinTool } from "./builtins/exec-tool.js";
import { ExecProcessManager } from "./builtins/exec-process-manager.js";
import { listDirectoryTool, readFileTool } from "./builtins/filesystem-tools.js";
import { grepTool } from "./builtins/grep-tool.js";
import { createOpenAIImageGenerationTool, DEFAULT_IMAGE_TIMEOUT_MS } from "./builtins/image-generation-tool.js";
import { createSearchTool } from "./builtins/search-tool.js";
import type { SearchProvider } from "./builtins/search-providers.js";
import { createSearchProvider, openAIResponsesUrl } from "./builtins/search-providers.js";
import { planTool } from "./builtins/plan-tool.js";
import { ToolRegistry } from "./registry.js";
import { runToolUseToMessages } from "./run-tool-use.js";
import { runTools } from "./tool-orchestration.js";
import type { Tool, ToolUseContext } from "./tool.js";

const smokePassthroughTool: Tool<{ text: string }> = {
  name: "smoke_passthrough",
  aliases: ["smoke_pass"],
  description: "Return provided text for smoke tests.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string", description: "Text to return." } },
    required: ["text"],
    additionalProperties: false,
  },
  metadata: { readOnly: true, concurrent: true, visible: true, maxResultSizeChars: 4096, searchHint: "smoke passthrough text" },
  validate(input: unknown): { text: string } {
    return { text: (input as { text: string }).text };
  },
  validateInput(input) {
    return input.text.length > 0 ? { ok: true, value: input } : { ok: false, message: "smoke_passthrough.text cannot be empty" };
  },
  isConcurrencySafe() {
    return true;
  },
  async call(input) {
    return { ok: true, output: input.text };
  },
};

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


const mockSearchProvider: SearchProvider = {
  name: "mock",
  async search(input) {
    return {
      provider: "mock",
      query: input.query,
      results: [
        {
          title: `Mock result for ${input.query}`,
          url: "https://example.com/mock",
          published: "2026-05-07",
          highlights: ["Mock provider result used by smoke tests."],
        },
      ],
    };
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
  const execProcessManager = new ExecProcessManager();
  registry.register(smokePassthroughTool);
  registry.register(editTool);
  registry.register(writeTool);
  registry.register(createExecTool({ processManager: execProcessManager }));
  registry.register(createWriteStdinTool(execProcessManager));
  registry.register(listDirectoryTool);
  registry.register(readFileTool);
  registry.register(grepTool);
  registry.register(createSearchTool({ provider: mockSearchProvider }));
  registry.register(planTool);
  registry.register(delayTool);
  registry.register(largeTool);

  const context: ToolUseContext = {
    agentId: "tool-smoke",
    tools: registry,
    appState: new InMemoryAppState("tool-smoke", process.cwd()),
    emit: () => undefined,
  };
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-tools-smoke-"));

  const valid = await runToolUseToMessages({ id: "smoke_passthrough1", name: "smoke_pass", input: { text: "ok" } }, context);
  const invalid = await runToolUseToMessages({ id: "smoke_passthrough2", name: "smoke_passthrough", input: { text: "" } }, context);
  const unknown = await runToolUseToMessages({ id: "missing", name: "missing", input: {} }, context);
  const large = await runToolUseToMessages({ id: "large", name: "large", input: { size: 20, maxResultChars: 8 } }, context);
  const grep = await runToolUseToMessages(
    { id: "grep", name: "grep", input: { query: "grepTool", path: "src/tools/builtins/grep-tool.ts", maxResults: 5 } },
    context,
  );
  const truncatedGrep = await runToolUseToMessages(
    { id: "grep-truncated", name: "grep", input: { query: "import", path: "src", maxResults: 1 } },
    context,
  );
  const webSearch = await runToolUseToMessages(
    { id: "web-search", name: "search", input: { query: "agent scaffold", numResults: 1 } },
    context,
  );
  const plan = await runToolUseToMessages(
    {
      id: "plan",
      name: "plan",
      input: {
        title: "Smoke plan",
        items: [
          { description: "Register plan tool", status: "completed", subitems: [{ description: "Expose subitems schema", status: "completed" }] },
          { description: "Render plan", status: "in_progress", subitems: [{ description: "Indent nested plan rows", status: "pending" }] },
          { description: "Validate smoke", status: "pending" },
        ],
      },
    },
    context,
  );
  const contextGrep = await runToolUseToMessages(
    { id: "grep-context", name: "grep", input: { query: "description", path: "src/tools/builtins/grep-tool.ts", contextLines: 1, maxResults: 2 } },
    context,
  );
  const read = await runToolUseToMessages(
    { id: "read", name: "read", input: { path: "src/tools/builtins/grep-tool.ts", offset: 1, limit: 5 } },
    context,
  );
  const list = await runToolUseToMessages(
    { id: "list", name: "list", input: { path: "src/tools/builtins", recursive: false, maxEntries: 20 } },
    context,
  );
  const readWithDescription = await runToolUseToMessages(
    { id: "read-description", name: "read", input: { description: "Verify description is tolerated", path: "src/tools/builtins/grep-tool.ts", offset: 1, limit: 2, ignoredField: "ignored" } },
    context,
  );
  const listWithDescription = await runToolUseToMessages(
    { id: "list-description", name: "list", input: { description: "Verify description is tolerated", path: "src/tools/builtins", recursive: false, maxEntries: 5, ignoredField: "ignored" } },
    context,
  );
  const grepWithDescription = await runToolUseToMessages(
    { id: "grep-description", name: "grep", input: { description: "Verify description is tolerated", query: "grepTool", path: "src/tools/builtins/grep-tool.ts", maxResults: 1, ignoredField: "ignored" } },
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
    { id: "exec", name: "exec_command", input: { cmd: "node -e \"console.log(process.cwd()); console.error('warn')\"", description: "Verify exec captures stdout, stderr, and cwd", timeout_ms: 10000, max_output_chars: 4000 } },
    context,
  );
  const execFailure = await runToolUseToMessages(
    { id: "exec-fail", name: "exec_command", input: { cmd: "node -e \"process.exit(7)\"", description: "Verify exec reports non-zero exit status", timeout_ms: 10000 } },
    context,
  );
  const interactiveStart = await runToolUseToMessages(
    { id: "exec-interactive", name: "exec_command", input: { cmd: "node -e \"process.stdin.once('data', value => { console.log('received:' + value.toString().trim()); process.exit(0); })\"", description: "Verify a running terminal accepts later input", timeout_ms: 10000, yield_time_ms: 20 } },
    context,
  );
  const interactiveStartOutput = toolOutput(interactiveStart[interactiveStart.length - 1]) as { session_id?: string; status?: string };
  const interactiveWrite = await runToolUseToMessages(
    { id: "exec-interactive-write", name: "write_stdin", input: { session_id: interactiveStartOutput.session_id, chars: "hello\n", yield_time_ms: 2000 } },
    context,
  );
  const interactiveWriteOutput = toolOutput(interactiveWrite[interactiveWrite.length - 1]) as { stdout?: string; status?: string; exit_code?: number | null };
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
  const grepOutput = toolOutput(grep[grep.length - 1]) as {
    cwd?: string;
    grepPath?: string;
    returnedMatches?: number;
    totalMatchesKnown?: number | null;
  };
  const truncatedGrepOutput = toolOutput(truncatedGrep[truncatedGrep.length - 1]) as {
    returnedMatches?: number;
    totalMatchesKnown?: number | null;
    truncated?: boolean;
  };
  const contextGrepOutput = toolOutput(contextGrep[contextGrep.length - 1]) as {
    matches?: Array<{ contextBefore?: unknown[]; contextAfter?: unknown[] }>;
  };
  const recursiveListOutput = toolOutput(recursiveList[recursiveList.length - 1]) as {
    exclude?: string[];
    excludedCounts?: Record<string, number>;
    entries?: Array<{ name: string; path: string }>;
  };
  const execOutput = toolOutput(exec[exec.length - 1]) as {
    exit_code?: number | null;
    stdout?: string;
    stderr?: string;
    cwd?: string;
  };
  const execFailureOutput = toolOutput(execFailure[execFailure.length - 1]) as {
    exit_code?: number | null;
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
  const webSearchOutput = toolOutput(webSearch[webSearch.length - 1]) as {
    provider?: string;
    returnedResults?: number;
    results?: Array<{ url?: string }>;
  };
  const defaultOpenAISearchProvider = createSearchProvider({}, { MODEL_PROVIDER: "openai", OPENAI_API_KEY: "test-key" } as NodeJS.ProcessEnv);
  const explicitExaSearchProvider = createSearchProvider({}, { MODEL_PROVIDER: "openai", SEARCH_PROVIDER: "exa" } as NodeJS.ProcessEnv);
  const fallbackSearchProvider = createSearchProvider({}, {} as NodeJS.ProcessEnv);
  const searchToolDefinition = registry.get("search");
  const searchToolPrompt = JSON.stringify({ description: searchToolDefinition?.description, schema: searchToolDefinition?.inputSchema });
  const imageTool = createOpenAIImageGenerationTool();
  const imageToolPrompt = JSON.stringify({ name: imageTool.name, description: imageTool.description, schema: imageTool.inputSchema });
  const imageDefaultValidation = await imageTool.validateInput?.(imageTool.validate?.({ semanticName: "smoke-test", prompt: "smoke" }, context) ?? { semanticName: "smoke-test", prompt: "smoke" }, context);
  const imageLegacyModelValidation = await imageTool.validateInput?.(imageTool.validate?.({ semanticName: "smoke-test", prompt: "smoke", model: "gpt-image-1" }, context) ?? { semanticName: "smoke-test", prompt: "smoke", model: "gpt-image-1" }, context);
  const imageEditSmokeMessages: Message[] = [
    {
      id: "image-old",
      role: "assistant",
      createdAt: new Date(0).toISOString(),
      blocks: [{
        type: "image",
        mimeType: "image/png",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0ioAAAAASUVORK5CYII=",
        label: "[img#10]",
      }],
    },
    {
      id: "image-new",
      role: "assistant",
      createdAt: new Date(1).toISOString(),
      blocks: [{
        type: "image",
        mimeType: "image/png",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0ioAAAAASUVORK5CYII=",
        label: "[img#10]",
      }],
    },
  ];
  const imageEditContext: ToolUseContext = { ...context, messages: imageEditSmokeMessages };
  const imageEditTool = createOpenAIImageGenerationTool({ apiKey: "test-key", baseUrl: "https://example.test" });
  const originalFetch = globalThis.fetch;
  const seenImageFilenames: string[] = [];
  let imageEditRefOutput:
    | {
      imageRefs?: string[];
      sourceImages?: number;
    }
    | undefined;
  let imageEditNumberOutput:
    | {
      imageRefs?: string[];
      sourceImages?: number;
    }
    | undefined;
  globalThis.fetch = async (_input, init) => {
    const body = init?.body;
    if (!(body instanceof FormData)) throw new Error("Expected image edit request to use FormData");
    const files = body.getAll("image[]");
    seenImageFilenames.splice(0, seenImageFilenames.length, ...files.map((file) => file instanceof File ? file.name : String(file)));
    return new Response(JSON.stringify({
      data: [{
        b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0ioAAAAASUVORK5CYII=",
      }],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    const imageEditRefResult = await imageEditTool.call?.({
      mode: "edit",
      semanticName: "smoke-edit-ref",
      prompt: "smoke edit",
      imageRefs: ["img#10"],
      useLatestImage: false,
    }, imageEditContext, {});
    imageEditRefOutput = imageEditRefResult?.output as {
      imageRefs?: string[];
      sourceImages?: number;
    } | undefined;
    const imageEditNumberResult = await imageEditTool.call?.({
      mode: "edit",
      semanticName: "smoke-edit-number",
      prompt: "smoke edit",
      imageRefs: ["10"],
      useLatestImage: false,
    }, imageEditContext, {});
    imageEditNumberOutput = imageEditNumberResult?.output as {
      imageRefs?: string[];
      sourceImages?: number;
    } | undefined;
  } finally {
    globalThis.fetch = originalFetch;
  }
  const planOutput = toolOutput(plan[plan.length - 1]) as {
    summary?: string;
    completed?: number;
    inProgress?: number;
    pending?: number;
    total?: number;
    items?: Array<{ status?: string; subitems?: Array<{ status?: string }> }>;
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
    grepOk: toolOk(grep[grep.length - 1]),
    grepFindsFile: JSON.stringify(grep[grep.length - 1]).includes("grep-tool.ts"),
    grepFields: grepOutput.cwd !== undefined && grepOutput.grepPath !== undefined,
    grepKnownTotal: grepOutput.returnedMatches === grepOutput.totalMatchesKnown,
    grepNoLegacyRoot: !JSON.stringify(grep[grep.length - 1]).includes('"root"'),
    truncatedGrepOk: toolOk(truncatedGrep[truncatedGrep.length - 1]),
    webSearchOk: toolOk(webSearch[webSearch.length - 1]),
    webSearchUsesProvider: webSearchOutput.provider === "mock" && webSearchOutput.returnedResults === 1,
    webSearchFindsUrl: webSearchOutput.results?.[0]?.url === "https://example.com/mock",
    webSearchDefaultsToOpenAI: defaultOpenAISearchProvider.name === "openai",
    webSearchExplicitExaOverride: explicitExaSearchProvider.name === "exa",
    webSearchDefaultsToOpenAIWithoutConfig: fallbackSearchProvider.name === "openai",
    webSearchResponsesUrlAddsV1: openAIResponsesUrl("https://api.openai.com") === "https://api.openai.com/v1/responses",
    webSearchResponsesUrlPreservesV1: openAIResponsesUrl("https://api.openai.com/v1/") === "https://api.openai.com/v1/responses",
    webSearchPromptUsesOpenAIDefault: searchToolPrompt.includes("OpenAI is the default"),
    webSearchPromptFallsBackToExa: searchToolPrompt.includes("exa") && searchToolPrompt.includes("unavailable") && searchToolPrompt.includes("partially unavailable"),
    image2OnlyToolName: imageTool.name === "image2" && !imageToolPrompt.includes("draw_image") && !imageToolPrompt.includes("generate_image"),
    image2DefaultsToGptImage2: imageDefaultValidation?.ok === true && imageDefaultValidation.value.model === "gpt-image-2" && imageToolPrompt.includes("gpt-image-2"),
    image2DefaultTimeoutIsSixMinutes: DEFAULT_IMAGE_TIMEOUT_MS === 360_000,
    image2RejectsGptImage1: imageLegacyModelValidation?.ok === false && imageLegacyModelValidation.message.includes("gpt-image-2") && !imageToolPrompt.includes("gpt-image-1"),
    image2EditAcceptsBareImgRef:
      imageEditRefOutput?.sourceImages === 1 &&
      imageEditRefOutput.imageRefs?.[0] === "[img#10]" &&
      seenImageFilenames[0] === "image-2.png",
    image2EditNumericFallbackPrefersLatestMatchingLabel:
      imageEditNumberOutput?.sourceImages === 1 &&
      imageEditNumberOutput.imageRefs?.[0] === "[img#10]",
    planOk:
      toolOk(plan[plan.length - 1]) &&
      planOutput.summary === "2/5 completed" &&
      planOutput.total === 5 &&
      planOutput.completed === 2 &&
      planOutput.inProgress === 1 &&
      planOutput.pending === 2 &&
      planOutput.items?.[0]?.status === "completed" &&
      planOutput.items?.[0]?.subitems?.[0]?.status === "completed" &&
      String(planTool.description).includes("split it into subitems") &&
      JSON.stringify(planTool.inputSchema).includes("subitems"),
    truncatedGrepCounts:
      truncatedGrepOutput.returnedMatches === 1 &&
      truncatedGrepOutput.totalMatchesKnown === null &&
      truncatedGrepOutput.truncated === true,
    contextGrepOk: toolOk(contextGrep[contextGrep.length - 1]),
    contextGrepLines:
      (contextGrepOutput.matches?.some((match) => (match.contextBefore?.length ?? 0) > 0) ?? false) ||
      (contextGrepOutput.matches?.some((match) => (match.contextAfter?.length ?? 0) > 0) ?? false),
    readOk: toolOk(read[read.length - 1]),
    readLineMetadata: JSON.stringify(read[read.length - 1]).includes('"startLine":1'),
    readContent: JSON.stringify(read[read.length - 1]).includes("spawn"),
    listOk: toolOk(list[list.length - 1]),
    listFindsFile: JSON.stringify(list[list.length - 1]).includes("grep-tool.ts"),
    simpleReadOnlyToolsTolerateDescription:
      toolOk(readWithDescription[readWithDescription.length - 1]) &&
      toolOk(listWithDescription[listWithDescription.length - 1]) &&
      toolOk(grepWithDescription[grepWithDescription.length - 1]),
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
    legacyExecAliasesRemoved:
      ["exec", "shell", "bash", "powershell"].every((name) => registry.get(name) === undefined),
    execOk:
      toolOk(exec[exec.length - 1]) &&
      execOutput.exit_code === 0 &&
      execOutput.stdout?.includes(process.cwd()) === true &&
      execOutput.stderr?.includes("warn") === true,
    execFailureRejected:
      !toolOk(execFailure[execFailure.length - 1]) &&
      typeof execFailureOutput.exit_code === "number" &&
      execFailureOutput.exit_code !== 0,
    execInteractiveOk:
      interactiveStartOutput.status === "running" &&
      typeof interactiveStartOutput.session_id === "string" &&
      toolOk(interactiveWrite[interactiveWrite.length - 1]) &&
      interactiveWriteOutput.status === "exited" &&
      interactiveWriteOutput.exit_code === 0 &&
      interactiveWriteOutput.stdout?.includes("received:hello") === true,
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

  console.log(JSON.stringify({
    ok,
    elapsedMs,
    checks,
    counts: { valid: valid.length, invalid: invalid.length, unknown: unknown.length, large: large.length, grep: grep.length, truncatedGrep: truncatedGrep.length, webSearch: webSearch.length, plan: plan.length, contextGrep: contextGrep.length, read: read.length, list: list.length, recursiveList: recursiveList.length, exec: exec.length, execFailure: execFailure.length, interactiveStart: interactiveStart.length, interactiveWrite: interactiveWrite.length, editCreate: editCreate.length, editAmbiguous: editAmbiguous.length, editReplaceAll: editReplaceAll.length, editCrlfWithLfOldString: editCrlfWithLfOldString.length, write: write.length, batch: batch.messages.length },
    ...(!ok ? { terminalDiagnostics: { exec: execOutput, execFailure: execFailureOutput, interactiveStart: interactiveStartOutput, interactiveWrite: interactiveWriteOutput } } : {}),
  }, null, 2));
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

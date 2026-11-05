import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileToolResultMemory, truncateToolText } from "../../src/session/tool-result-memory.js";
import { runToolUseToMessages } from "../../src/tools/run-tool-use.js";
import { applyToolResultBudget } from "../../src/core/message-pipeline.js";
import { listDirectoryTool } from "../../src/tools/builtins/filesystem-tools.js";
import { createToolResultMessage } from "../../src/types/messages.js";
import type { Tool, ToolUseContext } from "../../src/tools/tool.js";

for (const budget of [1, 20, 200, 2200, 48000, 100000]) {
  test(`persisted output obeys ${budget} chars including wrapper and remains stable`, async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "neo-budget-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const memory = new FileToolResultMemory({ sessionDir: dir });
    const original = { exit_code: 0, stdout: "输出😀".repeat(30000) };
    const result = await memory.processToolResult("call", original, budget);
    assert.ok(typeof result.output === "string" && result.output.length <= budget);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, "tool-results/call.json"), "utf8")), original);
    if (budget >= 2200) {
      assert.match(String(result.output), /Full output saved to: /);
      assert.match(String(result.output), /exit_code/);
    }
    const restored = new FileToolResultMemory({ sessionDir: dir }, [result.record!]);
    assert.equal((await restored.processToolResult("call", "different", 1)).output, result.output);
    const history = [createToolResultMessage({ id: "call", name: "test", input: {} }, true, result.output)];
    const before = JSON.stringify(history);
    assert.equal(JSON.stringify((await restored.applyBudget(history, { maxSerializedLength: 1 })).messages), before);
    assert.equal(JSON.stringify(history), before);
  });
}

test("custom renderer and mapped output cannot bypass explicit limits; images remain attached", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "neo-render-budget-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const persisted of [false, true]) for (const custom of [false, true]) {
    const tool: Tool = {
      name: "test", description: "test", inputSchema: { type: "object" }, metadata: { readOnly: true, concurrent: true, visible: true },
      async call(input) { assert.equal((input as Record<string, unknown>).maxResultChars, undefined); return { ok: true, output: { body: "😀".repeat(4000) } }; },
      mapResult: r => ({ mapped: r.output }),
      renderToolResultMessage: custom ? (r, call) => ({ ...createToolResultMessage(call!, true, `CUSTOM ${JSON.stringify(r.output)}`), blocks: [
        { type: "tool_result", toolUseId: call!.id, name: "test", ok: true, output: `CUSTOM ${JSON.stringify(r.output)}` },
        { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
      ] }) : undefined,
    };
    const context = { agentId: "main", tools: { get: () => tool }, emit() {}, toolResultMemory: persisted ? new FileToolResultMemory({ sessionDir: dir }) : undefined } as unknown as ToolUseContext;
    const messages = await runToolUseToMessages({ id: `call-${persisted}-${custom}`, name: "test", input: { maxResultChars: 600 } }, context);
    const block = messages[0]!.blocks[0]!;
    assert.equal(block.type, "tool_result");
    if (block.type !== "tool_result") return;
    assert.ok(String(block.output).length <= 600);
    if (custom) assert.equal(messages[0]!.blocks[1]!.type, "image");
    if (persisted) assert.match(String(block.output), custom ? /CUSTOM/ : /mapped/);
  }
});

test("small output stays structured; Unicode truncation never splits surrogate pairs", async () => {
  const memory = new FileToolResultMemory({ sessionDir: os.tmpdir() });
  const small = { text: "hello" };
  assert.equal((await memory.processToolResult("small", small, 30)).output, small);
  assert.equal(truncateToolText("😀😀😀", 4), "😀…");
});


test("explicit large budgets bypass builtin pre-shrinking and remain intact in sessionless context processing", async () => {
  const payload = { entries: Array.from({ length: 500 }, (_, i) => ({ path: `file-${i}-${"x".repeat(80)}`, type: "file" })) };
  const request = { id: "list", name: "file_list", input: { maxResultChars: 100000 } };
  assert.equal(listDirectoryTool.mapResult!({ ok: true, output: payload }, request), payload);
  const tool: Tool = { name: "test", description: "test", inputSchema: { type: "object" },
    metadata: { readOnly: true, concurrent: true, visible: true },
    async call() { return { ok: true, output: "x".repeat(80000) }; } };
  const context = { agentId: "main", tools: { get: () => tool }, emit() {} } as unknown as ToolUseContext;
  const messages = await runToolUseToMessages({ ...request, name: "test" }, context);
  assert.equal(JSON.stringify(applyToolResultBudget(messages)), JSON.stringify(messages));
  const newMemory = new FileToolResultMemory({ sessionDir: os.tmpdir() });
  assert.equal(JSON.stringify((await newMemory.applyBudget(messages)).messages), JSON.stringify(messages), "fork/import must not re-budget already accepted results");
  const small = applyToolResultBudget([createToolResultMessage(request, true, "x".repeat(100))], { maxSerializedLength: 10 });
  const block = small[0]!.blocks[0]!;
  assert.ok(block.type === "tool_result" && String(block.output).length <= 10);
});

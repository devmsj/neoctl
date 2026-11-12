import assert from "node:assert/strict";
import test from "node:test";
import { ToolRegistry } from "../../src/tools/registry.js";
import { runToolUseToMessages } from "../../src/tools/run-tool-use.js";
import { readFileTool } from "../../src/tools/builtins/filesystem-tools.js";
import { classifyToolDetailFields } from "../../src/web/tool-detail-fields.js";
import type { Tool, ToolUseContext } from "../../src/tools/tool.js";

function fixture(native = false, ignoreUnknown = false) {
  const received: unknown[] = [];
  const tool: Tool = { name: "custom", description: "custom", aliases: ["alias"],
    inputSchema: { type: "object", properties: { value: { type: "string" }, ...(native ? { description: { type: "string" } } : {}) }, required: ["value"], additionalProperties: false },
    metadata: { visible: true, readOnly: true, concurrent: true, ignoreUnknownInputProperties: ignoreUnknown },
    validate(input) { received.push(input); return input; },
    async call(input) { received.push(input); return { ok: true, output: input }; },
  };
  const tools = new ToolRegistry(); tools.register(tool);
  const context = { agentId: "test", tools, emit() {} } as unknown as ToolUseContext;
  return { tool, tools, context, received };
}

test("all registered tools expose one required description and an optional unchanged result budget", () => {
  const f = fixture(); f.tools.register(readFileTool);
  const before = JSON.stringify(f.tool.inputSchema);
  for (const definition of f.tools.clone().definitions()) {
    assert.equal(definition.inputSchema.required?.filter(k => k === "description").length, 1);
    assert.equal(definition.inputSchema.properties?.description?.type, "string");
    assert(!definition.inputSchema.required?.includes("maxResultChars"));
    assert.match(definition.inputSchema.properties?.maxResultChars?.description ?? "", /48000.*200000/);
    assert.equal(Object.keys(definition.inputSchema.properties!)[0], "description");
  }
  assert.equal(JSON.stringify(f.tool.inputSchema), before);
});

test("missing, empty, whitespace or non-string purpose fails before tool execution, including aliases", async () => {
  const f = fixture(false, true);
  for (const description of [undefined, "", " \n\t", null, 42, false]) {
    const input = { value: "x", ...(description === undefined ? {} : { description }) };
    const result = await runToolUseToMessages({ id: "call", name: "alias", input }, f.context);
    assert.match(JSON.stringify(result), /description/);
    const block = result[0]!.blocks[0]!;
    assert(block.type === "tool_result" && !block.ok);
  }
  assert.equal(f.received.length, 0);
});

test("framework purpose survives on the original call but is stripped from undeclared plugin parameters", async () => {
  for (const native of [false, true]) for (const ignore of [false, true]) {
    const f = fixture(native, ignore);
    const input = { value: "x", description: "Inspect the result", maxResultChars: 2000 };
    const result = await runToolUseToMessages({ id: "call", name: "custom", input }, f.context);
    const block = result[0]!.blocks[0]!; assert(block.type === "tool_result" && block.ok);
    const expected = { value: "x", ...(native ? { description: input.description } : {}) };
    assert.deepEqual(f.received, [expected, expected]);
    assert.equal(input.description, "Inspect the result");
    assert.equal(input.maxResultChars, 2000);
  }
});

test("detail purpose prefers the unified description and still reads legacy purpose", () => {
  const current = classifyToolDetailFields({ toolName: "custom", input: { description: "Current label", purpose: "Legacy label" } });
  assert.equal(current.purpose.value, "Current label");
  const legacy = classifyToolDetailFields({ toolName: "custom", input: { purpose: "Legacy label" } });
  assert.equal(legacy.purpose.value, "Legacy label");
});

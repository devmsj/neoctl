import assert from "node:assert/strict";
import test from "node:test";
import { jsonClone } from "../../src/core/json-clone.js";

test("jsonClone matches a JSON round trip", () => {
  const date = new Date("2026-11-18T00:00:00Z");
  const values: unknown[] = [
    { id: "m", role: "user", blocks: [{ type: "text", text: "中文 😀 \ud800" }, { type: "image", data: "A".repeat(1000), storage: undefined }], metadata: { n: 1.5, z: -0, inf: Infinity, nan: NaN, d: date, f: () => 1, nested: [undefined, () => 1, null, true, { a: [] }] } },
    JSON.parse('{"__proto__": {"polluted": true}, "x": 1}'),
    [1, "two", { toJSON: () => ({ three: 3 }) }],
    Object.assign(Object.create({ inherited: 1 }), { own: 2 }),
  ];
  for (const value of values) assert.deepStrictEqual(jsonClone(value), JSON.parse(JSON.stringify(value)));
  const clone = jsonClone(values[1]) as Record<string, unknown>;
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.ok(Object.prototype.hasOwnProperty.call(clone, "__proto__"));
  const source = { blocks: [{ text: "x" }] };
  const copy = jsonClone(source);
  copy.blocks[0]!.text = "changed";
  assert.equal(source.blocks[0]!.text, "x");
  assert.throws(() => jsonClone({ big: 1n }), TypeError);
});

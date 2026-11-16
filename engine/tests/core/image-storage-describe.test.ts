import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describeStoredImageSync, resolveStoredImageDataResultSync } from "../../src/core/image-storage.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

test("stored image metadata equals full validation without reading whole payloads", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "neo-image-describe-"));
  try {
    const expected = (storage: { path: string; storedBytes?: number }) => {
      const full = resolveStoredImageDataResultSync(storage);
      return full.available ? { available: true, sizeBytes: Buffer.from(full.data.replace(/^data:[^;,]+;base64,/iu, ""), "base64").length } : full;
    };
    const big = Buffer.concat([png, Buffer.alloc(300_001, 7)]);
    const cases: Record<string, string> = {
      base64: big.toString("base64"),
      padded1: Buffer.concat([png, Buffer.alloc(1)]).toString("base64"),
      dataUrl: `data:image/png;base64,${big.toString("base64")}`,
      whitespace: `${big.toString("base64").slice(0, 400)}\n${big.toString("base64").slice(400)}\n`,
      invalid: "not base64 at all!",
      tiny: png.toString("base64"),
    };
    for (const [name, text] of Object.entries(cases)) {
      const file = path.join(dir, `${name}.base64.txt`);
      await fs.writeFile(file, text);
      for (const storage of [{ path: file }, { path: file, storedBytes: Buffer.byteLength(text) }, { path: file, storedBytes: 1 }]) {
        assert.deepEqual(describeStoredImageSync(storage), expected(storage), `${name} ${JSON.stringify(storage.storedBytes)}`);
      }
    }
    assert.deepEqual(describeStoredImageSync({ path: path.join(dir, "missing") }), { available: false, error: "storage-unreadable" });
    assert.deepEqual(describeStoredImageSync(undefined), { available: false, error: "missing-payload" });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

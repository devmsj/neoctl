import test from "node:test";
import assert from "node:assert/strict";
import { imageResultMetadata } from "../../src/web/image-result-metadata.js";

test("image UI metadata preserves actual dimensions and false alpha without carrying payloads", () => {
  const output = imageResultMetadata({ size: "1536x1024", quality: "max", model: "gpt-image-2.5-sunburst", images: [{ label: "red-mug", width: 1370, height: 1148, mimeType: "image/png", hasAlphaChannel: true, hasTransparentPixels: false, base64: "PRIVATE-PAYLOAD", path: "PRIVATE-PATH" }] });
  assert.equal(output?.size, "1536x1024");
  assert.equal(output?.images[0]?.width, 1370);
  assert.equal(output?.images[0]?.hasAlphaChannel, true);
  assert.equal(output?.images[0]?.hasTransparentPixels, false);
  assert.ok(!JSON.stringify(output).includes("PRIVATE"));
});

test("legacy metadata absence remains unknown; invalid dimensions are not promoted", () => {
  assert.equal(imageResultMetadata(null), undefined);
  const output = imageResultMetadata({ images: [{ width: "1024", height: -1, hasAlphaChannel: "true" }, null] });
  assert.equal(output?.images[0]?.width, undefined);
  assert.equal(output?.images[0]?.height, undefined);
  assert.equal(output?.images[0]?.hasAlphaChannel, undefined);
  assert.equal(output?.images.length, 2);
});

test('image details retain actual structured lifecycle metadata',()=>{
 const value=imageResultMetadata({provider:'openai',sourceImages:2,startedAt:'start',finishedAt:'end',duration:1234,revisedPrompt:'actual revision',images:[]});
 assert.equal(value?.sourceImages,2);assert.equal(value?.durationMs,1234);assert.equal(value?.revisedPrompt,'actual revision');
});

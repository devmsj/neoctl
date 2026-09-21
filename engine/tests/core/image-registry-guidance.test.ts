import assert from "node:assert/strict";
import test from "node:test";
import { buildImageRegistry, formatImageRegistryForContext } from "../../src/core/image-registry.js";
import type { Message } from "../../src/types/messages.js";

const message: Message = {
  id: "image-message",
  role: "user",
  createdAt: new Date().toISOString(),
  blocks: [{
    type: "image",
    imageId: "image-stable-id",
    label: "[img#1]",
    mimeType: "image/png",
    data: "",
    storage: { path: "C:\\private\\attachments\\payload.base64.txt", format: "base64" },
  }],
};

test("image registry tells models to copy only the leading stable ID", () => {
  const rendered = formatImageRegistryForContext(buildImageRegistry([message]));
  assert.match(rendered, /use the listed img_N ID exactly/);
  assert.match(rendered, /do not copy captions, URIs, paths, or surrounding text/);
  assert.match(rendered, /^- img_1:/m);
});

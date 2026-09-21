import assert from "node:assert/strict";
import test from "node:test";
import { buildChatRequest } from "../../src/model/openai-chat-mapper.js";
import { buildResponsesRequest } from "../../src/model/openai-responses-mapper.js";
import type { Message } from "../../src/types/messages.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0ioAAAAASUVORK5CYII=";
const storagePath = "C:\\private\\attachments\\payload.base64.txt";
const message: Message = {
  id: "image-message",
  role: "user",
  createdAt: new Date().toISOString(),
  blocks: [{
    type: "image",
    imageId: "image-stable-id",
    label: "[img#1]",
    mimeType: "image/png",
    data: png,
    storage: { path: storagePath, format: "base64" },
  }],
};

test("OpenAI request guidance exposes only the copyable image reference, not its storage path", () => {
  for (const body of [
    buildResponsesRequest({ messages: [message], tools: [], stream: true }, { model: "gpt-test" }),
    buildChatRequest({ messages: [message], tools: [], stream: true }, { model: "gpt-test" }),
  ]) {
    const serialized = JSON.stringify(body);
    assert.match(serialized, /Image reference: image-stable-id/);
    assert.match(serialized, /pass exactly this value in imageRefs/);
    assert.doesNotMatch(serialized, /payload\.base64\.txt/);
  }
});

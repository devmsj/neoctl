import assert from "node:assert/strict";
import { createWebRuntimeContextPayload, WEB_RUNTIME_CONTEXT_PROTOCOL_VERSION } from "./runtime-context-protocol.js";

const payload = createWebRuntimeContextPayload({
  model: "gpt-5.6-sol",
  systemPrompt: "stable\n__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__\ndynamic",
  promptSections: [
    { name: "Agent Scaffold", content: "stable", cacheStable: true },
    { name: "Runtime", content: "dynamic", cacheStable: false },
  ],
  toolDefinitions: [{
    name: "file_read",
    description: "Read a file",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    strict: false,
  }],
  commands: ["/help"],
  agents: [],
  skills: ["documents"],
  plugins: [],
  userContext: { currentDate: "2026-08-31" },
  systemContext: { cwd: "C:/workspace", platform: "win32" },
  projectDocuments: [{ name: "AGENTS.md", path: "C:/workspace/AGENTS.md", content: "Project rules" }],
}, {
  revision: 3,
  sessionId: "session-1",
  generatedAt: "2026-08-31T00:00:00.000Z",
  toolPresentations: {
    file_read: { family: "filesystem", action: "read", label: "读取文件", visibility: "primary" },
  },
});

assert.equal(payload.protocolVersion, WEB_RUNTIME_CONTEXT_PROTOCOL_VERSION);
assert.equal(payload.revision, 3);
assert.equal(payload.prompt.stableSections, 1);
assert.equal(payload.prompt.dynamicSections, 1);
assert.equal(payload.prompt.sections[1].content, "dynamic");
assert.equal(payload.tools[0].inputSchema.properties?.path.type, "string");
assert.deepEqual(payload.tools[0].presentation, { family: "filesystem", action: "read", label: "读取文件", visibility: "primary" });
assert.deepEqual(payload.capabilities.skills, ["documents"]);
assert.equal(payload.project.injected, true);
assert.equal(payload.project.documents[0]?.name, "AGENTS.md");

console.log("runtime context protocol smoke ok");

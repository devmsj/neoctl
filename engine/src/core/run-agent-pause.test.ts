import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runAgent, type RunAgentOptions } from "./run-agent.js";
import { SessionStore } from "../session/session-store.js";
import { ToolRegistry } from "../tools/registry.js";
import type { ToolUseContext } from "../tools/tool.js";
import type { ModelRequest, ModelStreamEvent } from "../model/model-gateway.js";
import { createTextMessage } from "../types/messages.js";

test("abort after checkpoint then restart keeps compacted context without reinserting original directive", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "neo-child-pause-"));
  try {
    const controller = new AbortController();
    const options: RunAgentOptions = {
      agentId: "paused-child", agent: { agentType: "test", whenToUse: "test", tools: [] },
      prompt: "OLD_BEFORE_PAUSE", maxTurns: 1, abortSignal: controller.signal, workspaceCwd: root,
      parentContext: { session: { sessionId: "parent", sessionDir: root } } as ToolUseContext,
      dependencies: {
        tools: new ToolRegistry(),
        contextManager: { async build() { return { systemPrompt: "test", promptSections: [], userContext: { currentDate: "2026-01-01" }, systemContext: { cwd: root, platform: process.platform } }; } },
        compactor: { async compact() { return { messages: [createTextMessage("user", "PAUSE_CHECKPOINT")], changed: true, reason: "autocompact" }; } },
        modelGateway: { async *stream(): AsyncIterable<ModelStreamEvent> { controller.abort(); yield { type: "assistant_delta", text: "interrupted" }; } },
      },
    };
    const first = runAgent(options);
    let result;
    while (true) { const next = await first.next(); if (next.done) { result = next.value; break; } }
    assert.equal(result.status, "aborted");
    const stored = await SessionStore.open({ rootDir: path.join(root, "subagents"), sessionId: "paused-child", agentId: "paused-child", resume: true });
    assert.match(JSON.stringify(stored.getInitialMessages()), /PAUSE_CHECKPOINT/);
    assert.doesNotMatch(JSON.stringify(stored.getInitialMessages()), /OLD_BEFORE_PAUSE/);
    const requests: ModelRequest[] = [];
    const resumed = runAgent({ ...options, abortSignal: undefined, dependencies: { ...options.dependencies,
      compactor: { async compact(messages) { return { messages: [...messages], changed: false }; } },
      modelGateway: { async *stream(request): AsyncIterable<ModelStreamEvent> { requests.push(request); yield { type: "assistant_message", message: createTextMessage("assistant", "done") }; } },
    } });
    for await (const _event of resumed) { /* Drain real runAgent with fake gateway. */ }
    assert.equal(requests.length, 1);
    assert.match(JSON.stringify(requests[0].messages), /PAUSE_CHECKPOINT/);
    assert.doesNotMatch(JSON.stringify(requests[0].messages), /OLD_BEFORE_PAUSE/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

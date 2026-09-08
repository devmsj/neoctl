import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_TOOL_PROMPT_RULES, createAgentTool } from "./agent-tool.js";
import { GENERAL_PURPOSE_AGENT, EXPLORE_AGENT, FORK_AGENT, SUBAGENT_COORDINATION_RULES, type AgentDefinition } from "./agent-definition.js";
import { DefaultContextManager } from "../context/context-manager.js";
import { runAgent } from "../core/run-agent.js";
import { ToolRegistry } from "../tools/registry.js";
import type { ModelRequest, ModelStreamEvent } from "../model/model-gateway.js";
import { createTextMessage } from "../types/messages.js";

test("delegation tool states sibling isolation, explicit ownership and parent-mediated coordination", () => {
  const description = createAgentTool().description;
  assert.ok(typeof description === "string");
  assert.ok(description.includes(AGENT_TOOL_PROMPT_RULES));
  for (const rule of ["cannot communicate directly with sibling agents", "owned files/modules", "interface contracts", "acceptance checks", "main agent must relay", "this does not pause execution"]) {
    assert.ok(description.includes(rule), rule);
  }
});

const custom: AgentDefinition = { agentType: "custom", whenToUse: "test", tools: [], buildSystemPrompt: () => "CUSTOM_SCOPE_RULE" };
for (const agent of [GENERAL_PURPOSE_AGENT, EXPLORE_AGENT, FORK_AGENT, custom]) {
  for (const inheritedContext of [false, true]) {
    test(`${agent.agentType}: coordination rules reach model with ${inheritedContext ? "inherited" : "default"} context and remain stable on resume`, async () => {
      const requests: ModelRequest[] = [];
      const base = new DefaultContextManager({ memoryFileNames: [] });
      let history = [createTextMessage("user", "Existing scoped task")];
      for (let run = 0; run < 2; run++) {
        const stream = runAgent({
          agentId: "coordination-test",
          agent: { ...agent, requiresReport: false },
          prompt: "Inspect only; do not edit",
          existingMessages: history,
          resumeDirective: run ? "Continue verification" : undefined,
          maxTurns: 1,
          workspaceCwd: process.cwd(),
          onContextMessagesChanged: (messages) => { history = messages; },
          dependencies: {
            tools: new ToolRegistry(),
            contextManager: inheritedContext ? base : undefined,
            modelGateway: { async *stream(request): AsyncIterable<ModelStreamEvent> {
              requests.push(request);
              yield { type: "assistant_message", message: createTextMessage("assistant", "Checked") };
            } },
          },
        });
        for await (const _event of stream) { /* Exercise actual prompt assembly. */ }
      }
      assert.equal(requests.length, 2);
      for (const request of requests) {
        assert.ok(typeof request.systemPrompt === "string");
        assert.ok(request.systemPrompt.includes(SUBAGENT_COORDINATION_RULES));
        assert.equal(request.systemPrompt.split(SUBAGENT_COORDINATION_RULES).length - 1, 1);
        assert.ok(!JSON.stringify(request.messages).includes(SUBAGENT_COORDINATION_RULES), "rules are not appended as chat messages");
        if (agent === custom) assert.ok(request.systemPrompt.includes("CUSTOM_SCOPE_RULE"));
      }
      assert.equal(requests[0].systemPrompt, requests[1].systemPrompt, "static policy must not vary between turns/resume");
    });
  }
}

# Early tool-call observation

The streaming protocol adds one optional, additive event:

- Model gateway: `{ type: "tool_call_started", callId: string, name: string }`
- Core `AgentEvent`: `{ type: "tool_call.started", callId: string, name: string }`

This means the provider has announced a named tool call, **not** that the tool has run, been approved, or supplied complete/valid input. Core forwards the event without parsing arguments or guessing intent from prose. Existing `tool_call.delta` and execution events remain unchanged. Gateways that do not produce the new event remain compatible.

## Earliest available signal

Responses emits at `response.output_item.added` for a named `function_call`. Chat emits when a tool-call chunk first supplies `function.name`, even if `function.arguments` is empty. Each stream normalizer announces an output index once; parallel calls remain independent. Retries instantiate a fresh normalizer. No event is fabricated for ordinary text mentioning a tool. Provider buffering still limits how early anything can be observed.

The event contains no partial input and does not cause validation, dispatch, transcript message creation or token increments. Header-only arrival does not change the existing `firstOutputMs` definition (non-empty output or a finalized tool call). Actual execution timing continues to come from the worker's timing record; legacy `tool.started` may also describe queued work.

## Presentation

Web exposes a transient `status.modelOutput` for the latest observed output:

- `{ kind: "text" }` for assistant text deltas;
- `{ kind: "tool_call", callId, name? }` for tool-call headers or deltas.

Known names are displayed verbatim, including custom plugins, with a preparation label. No tool-name classification table, partial-JSON parser, file-path inference or provider-specific parsing is added to core/UI. Existing delta-only gateways still work. Parallel calls are represented by the latest observed call, not a fabricated aggregate progress value. State boundaries, retries, thinking and terminal events clear the transient observation; the current Web snapshot supplies it on reconnect.

## Cache isolation

Only response-side observation changes. No `ModelRequest`, request builder, tool schema, message, metadata or prompt-cache identity is altered. The transient status is not persisted into conversational messages. Tests compare complete Chat/Responses request bodies and cache identities with/without early events, including tool rounds, retries and persisted resume.

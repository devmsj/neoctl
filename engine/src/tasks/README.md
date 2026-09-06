# Subagent coordination

## Delegation boundary

Only the main agent schedules work. All child agents (including custom, fork and wildcard definitions) exclude `subagent_run` and `subagent_resume`; runtime calls from child contexts are also rejected. Reporting and messaging remain available. This is an application-tool policy, not an OS sandbox against arbitrary programs launched through a terminal.

Keep delegation prompts short: specify the goal, file boundaries and acceptance checks; report cross-boundary needs to the main agent rather than expanding scope.

## Current run and prior runs

`runGeneration` starts at 1 and advances on explicit resume. A resumed task clears its current result, error and progress; prior terminal results are archived separately in bounded `runHistory`. A running task is not a completed task just because an earlier run finished.

`subagent_get` defaults to a compact current-run summary (bounded progress, pending messages, recent delivery receipts and prior-run metadata). Use `detail: true` to inspect the full prompt, progress, current result and archived results. `subagent_output` reads the current run only; a running response never falls back to a previous run's result. This changes the default detail level, not the task ID or lifecycle status values.

## Message delivery

`subagent_message` returns a message receipt ID. `queued` means the message is waiting. `delivered` means it has been inserted into the agent's model-request context at a safe boundary; it does not prove the model understood, accepted, implemented or tested the request. Check the eventual report and tests for those claims.

The inbox is bounded to 256 pending messages and 16,384 characters per submitted message; excess submissions are rejected without dropping accepted messages. Each model request takes at most 32,768 characters in FIFO order. This is a character bound after context preparation, not a token-exact context reservation. Up to 128 delivered receipts and eight archived runs are retained; displayed retained counts are not lifetime totals. When a main session directory is available, coordination metadata is persisted underneath it; disabled/sessionless runs remain in memory.

Resume preserves the original resolved working directory and explicitly selected model. Output files are rewritten for the new generation; archived results remain separately inspectable while the task is retained.

Messages sent to a terminal task are `queued_for_resume` with `requires_resume: true`; sending a message does not automatically restart completed, failed or killed agents. Use `subagent_resume` explicitly. Pending-but-not-started tasks are queued normally rather than incorrectly requiring resume.

## Persistence and recovery

Each child uses `<main-session-dir>/subagents/<agentId>/`: `task.json` stores versioned scheduling metadata, `output.txt` holds the current output, and the child SessionStore retains its transcript, compaction checkpoints and tool-result memory. Restoring the owning main session loads these tasks. Formerly running/pending tasks become interrupted (`killed`) and require explicit resume; loading never launches a worker. Switching the foreground session does not stop workers owned by another session, and tools/UI/notifications are session-scoped.

Resume retains the resolved model, cwd, reasoning, context-window/output-token overrides and service tier. Child queries use the same query/compaction pipeline as the main thread. Durable compacted context is authoritative, including an empty checkpoint; stale task snapshots cannot resurrect discarded history. These are separate conversations, not a shared mutable main-thread context.

Task metadata uses atomic replacement; progress-only writes are coalesced while inbox/lifecycle boundaries are saved immediately. Task records have a matching 64 MiB UTF-8 read/write limit; oversized writes fail before replacing the previous snapshot. Completion-notification acknowledgements survive restart, though acknowledgement and delivery into the parent transcript are not a cross-file transaction; task status/output remain inspectable after an interrupted notification. Runtime gateways, abort controllers and credential-provider objects are not serialized. Session files are not encrypted and conversation text can contain sensitive content: protect the parent session directory accordingly.

An unconfirmed delivery outbox covers the gap between saving an inbox receipt and appending the child transcript. Appended messages are acknowledged before further model execution; recovery retries only unconfirmed messages, never historical receipts whose IDs disappeared through compaction.

Recovery restores conversation state, not OS processes or in-flight model requests. Unpaired historical tool calls receive synthetic interruption results rather than being replayed. This cannot guarantee exactly-once external side effects: the main agent must verify an interrupted operation before retrying it. Existing child transcripts without task metadata do not automatically become discoverable scheduling records.

## UI

The existing visual style is retained. Task details distinguish the current run from expandable earlier runs and expose pending/delivered message counts with the same delivery caveat. Recently finished agents are separate from the active background-task count. Old snapshots without coordination metadata retain a conservative fallback rather than inventing delivery or completion.

## Validation

From `engine`:

```
node --import tsx --test src/tasks/subagent-tools.test.ts src/tasks/task-persistence.test.ts src/tasks/task-ack-size.test.ts src/core/run-agent-persistence.test.ts src/core/run-agent-pause.test.ts src/agents/agent-tool-persistence.test.ts src/agents/no-nested-delegation.test.ts src/session/session-store-safety.test.ts
node node_modules/tsx/dist/cli.mjs src/web/smoke-task-session-entrypoints.ts
node node_modules/tsx/dist/cli.mjs src/agents/smoke-agent-lifecycle.ts
node node_modules/tsx/dist/cli.mjs src/web/smoke-web-agent-tasks.ts
npm run typecheck
npm run smoke:agents
```

Lifecycle and UI regression tests accompany their implementation. No live model or production Control access is required for these task-tool tests.

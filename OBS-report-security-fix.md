# Report security fix — 2026-09-07

## Scope and ownership

Fixes read-only review blockers 1 (hidden text promoted to completed report) and 3 (visible deltas lost on real stream failure). Authorized production edits: `engine/src/core/query.ts`, `core/run-agent.ts`, `agents/agent-tool.ts`, `web/agent-content-detail.ts`, and only `result()` in `tasks/task-persistence.ts`. Added `agents/agent-report-security.test.ts` and updated reader tests. No edits to local-agent-task.ts, registry, index.ts, App.vue, CSV, existing agent-tool-persistence tests or smoke tests by this agent. No commits, real model requests or user-data access. Synthetic test fixtures live in temporary directories and are removed.

Related coordinated changes owned elsewhere: `AgentToolResult.displaySource` type; registry `createStreamingRedactor({ incompleteSecret: "redact" })`; live preview state/redactionVersion; index snapshot legacy-result rejection and pre-clipping redaction.

## Contract and fixes

- `result.displaySource?: "agent_report" | "visible_text"` is assigned only from this run's non-meta real report-tool result or explicitly visible assistant blocks. Unknown/unmarked text and meta messages are not report fallback. Normal completion and injected-runner completion rebuild from authorized messages; failed/killed partials preserve incomplete status. Pure diagnostic/no-body results have no displaySource, not a fabricated source.
- Persistence retains only the two valid source enums in current/history result DTOs. Unmarked/invalid legacy current/archive results return reader `state: unavailable`, `report.content.state: unavailable`, empty text and an explicit provenance reason. No output.txt reads and no historical-message/generation guesses.
- Query collects only filtered visible stream text, finalizes an unfinalized draft at real failure/abort/end-of-stream, and emits a message for existing run-generation transcript persistence. Explicit provider error events now terminate via the failure path. A failure does not launch report-recovery turns that replace the terminal reason.
- Registered secrets use the shared prefix-safe streaming API; ambiguous terminal prefixes become `[secret:incomplete]`, never raw partial credentials. Custom registries without streaming support fail closed for visible text. Already finalized visible messages replace their draft without duplication. Unmarked/analysis-only final messages do not consume a visible draft or its hold-back tail.
- Both sync and async progress calls pass `input.context.secretRedactions` as the fourth argument. Existing captured-generation guards prevent late stopped runners from overwriting resumed results, timing or previews.

## Red/green verification

1. Initial 11 real synthetic gateway/lifecycle regressions: **0 pass / 11 fail before fixes**, then 11/11 pass.
2. Legacy unmarked current/archive report regression: expected unavailable, observed complete before resolver fix; now passes.
3. Final visible-delta → unmarked-final → throw/complete regressions: **0 pass / 2 fail before final query fix**; both now pass.
4. Final combined suite (security, OBS04 visible data, pause/persistence, OBS07-11 run facts, agent-tool persistence, no-nested delegation, subagent tools, reader): **96 tests, 94 pass, 2 fail, 0 skip**. The only failures are pre-existing fixture assumptions newly invalid under the requested security contract: `agent-tool-persistence.test.ts` synthetic gateway emits unmarked FIRST_RESULT/RESUMED_RESULT via createTextMessage but expects them to be public report text. Parent was notified to mark those synthetic provider outputs visible; this agent did not edit that unowned existing test. Security/reader/other tests all pass.
5. `npm run typecheck`: **exit 0** after final changes.
6. Real HTTP `smoke-agent-content-http.ts`: rerun passed with defects=[] including legacy provenance rejection (parent owns HTTP fixtures). No actual model calls.
7. `git diff --check` on edited tracked production files: clean after preserving LF line endings.

The dedicated security file has 22 tests: sync/async hidden final output, throw/error-event/abort delta-only partial, >4000-character exact preservation, no duplicate final text, meta rejection, cross-generation late callbacks, full and half registered secrets, incomplete stream, source-marker persistence, invalid legacy markers and untrusted runner result claims, plus visible draft followed by hidden final.

## Limits / parent integration notes

- Full repository browser/45-job orchestration remains parent-owned. This record does not claim all historical smoke tests pass.
- The historical ordinary-tool-detail path can also contain old subagent result payloads; parent was notified to inspect source checks there, separately from this resolver fix.
- No mass backfill of legacy provenance. Legacy report loss of visibility is intentional fail-closed compatibility behavior, not source recovery.
- Single JSONL 16 MiB explicit unavailable and same-permission OS TOCTOU limits remain accepted; not new obligations.
- Production writes stopped after the final mixed-channel query fix. No additional refactor or unrelated lifecycle changes.

## Authorized follow-up: ordinary agent tool payload boundary

The historical ordinary-tool-detail limitation above is now fixed for the repository's registered agent tools. Additional authorization covered `web/tool-call-detail.ts`, the two tool-result projections in `web/agent-content-detail.ts`, and new `web/agent-tool-payload-security.test.ts`; index integration remains parent-owned.

- Exported `sanitizeAgentToolPayload(name, output): { value: unknown; unavailable?: string }` for ordinary detail, agent timeline and parent index wire projection. Apply before presentation/preview, retain registry/structural redaction afterwards.
- Unproven content/message/last_text and nested result/report/output/error bodies no longer cross the boundary. Only same-object valid displaySource authorizes content; a current result does not authorize sibling or archived report bodies.
- Plain/XML bodies fail closed. Known anchored XML headers retain exact task/run/status navigation facts; arbitrary output/error tails are not searched for identity or source proof. Restored persisted tool output passes through the same boundary.
- Preserve task/run identity, status, user delegation prompt/description and protocol metadata. Preserve structured top-level tool error diagnostics for all registered agent tools and subagent_message/control protocol message/failure strings; nested result.error is not such a diagnostic.
- First real readToolCallDetail run: 12 tests, 1 pass/11 fail; 10 failures reproduced source leaks, one control-case assertion needed to respect the existing pending_messages structural redactor. Final new dedicated suite: 15 pass/0 fail, including direct and persisted real agent timelines and positive safe provenance/diagnostic controls.
- Final combined security/reader/payload run: **52 pass / 0 fail / 0 skip**. Typecheck exit 0. OBS01 ordinary-detail service smoke: 45 assertions passed, including actual subagent_message Unknown agent error. A concurrently run status smoke failed at its old line 47 assertion; parent owns status/index integration and was explicitly notified to rerun rather than this agent changing its fixtures. HTTP/wire/App/fields and full orchestration remain parent-owned.
- Current repository and d40 baseline register no agent tool aliases; TaskOutput is explicitly classified unknown by an existing fixture. No guessed aliases or generic agent-name patterns added. Pre-baseline aliases without repository evidence remain outside the verified compatibility coverage.

Production is frozen after this helper/reader follow-up. No index/App/CSV changes, commits, model calls or real user-data reads by this agent.

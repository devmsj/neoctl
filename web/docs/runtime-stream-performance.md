# Runtime stream reactivity boundaries

## Ownership

`createRuntimeLines` owns ordered shallow-reactive row membership and an ID index.
Rows are stable shallow-reactive records: an update assigns top-level fields on the
same row. Nested tool input/result/resource data is immutable. Replace a nested
field rather than mutating it. Do not replace the entire array/row for a token.
This keeps structural consumers (groups, image/resource indices, connections,
virtualizer membership) out of ordinary text/input updates.

Snapshot reconciliation still preserves unchanged activity/result references.
`replace` preserves row identities for the same session, deletes absent fields,
and changes array membership only when order or IDs change. On a session switch,
clear the store first: another session may reuse numeric row IDs.

`indexRuntimeTasks` indexes terminal aliases and agent IDs while keeping source
order and duplicate candidates. The existing runtime signal function still checks
kind/generation and first-match precedence. Task status remains reactive.

`useToolObservation` has one content subscription per observation row and a
separate membership subscription. Changes are coalesced by Vue's existing queue;
the 800ms selection cadence, pin semantics and five-second idle hide are retained.
Subscriptions are removed with rows, session changes and component unmount.

The observation reports height only when its rounded height changes. It still
measures animated geometry through ResizeObserver and existing transition hooks.
Content invalidation uses references rather than serializing the full preview.
No CSS, animation durations or rendering refresh rates are changed.

## Validation (2026-10-28)

Baseline commit: `652b560`. Independent copied long conversation: 3115 rows and
272 historical terminal IDs; real debug Tauri/WebView2 with a separate profile.
The sample is a display-history replay, not model execution or exact incident
reconstruction. Source conversation and production desktop were not modified.

Independent local SSE sender, 330-second schedule: idle30s, tool-input90s,
idle20s, thinking90s, idle30s, burst-tool40s, idle30s. Requested timer periods
50ms/25ms delivered approximately16Hz/31Hz on this Windows host (1435 events
in90s and1245 in40s); do not label those measurements achieved20Hz/40Hz.
The final run delivered and received4117 events, with visible preview growth:
47,682 tool-input characters,31,904 thinking characters,41,222 burst characters.

| Final run stage | Input-to-two-rAF P95, including CDP | Frame interval P95 | >50ms tasks |
| --- | ---: | ---: | ---: |
| idle | 48ms | 16.8ms | 0 |
| tool input,90s | 56ms | 16.8ms | 1 |
| thinking,90s | 102ms | 16.9ms | 28 |
| burst tool input,40s | 58ms | 16.8ms | 0 |
| final idle | 49ms | 16.8ms | 0 |

Baseline stopped answering renderer probes after streaming began, with no
successful probe for>366s; no valid post-freeze P95 was available. First modified
run completed but a fixture incorrectly set titleStatus='running', which the
existing phase selector treats as terminal failure, hiding generated content.
That run is not the final visual-performance result. The corrected second run
used generating activity without terminal titleStatus and verified content growth.
Baseline used the same erroneous titleStatus, so this is a robustness comparison,
not a perfectly identical visual workload A/B. The corrected run renders more
content, not less.

Final sampled JS heap peak108.2MiB, end83.1MiB, after explicit end-only GC83.0MiB.
This is not proof of absence of long-term leaks. Thinking still reparses long
Markdown and forces layout through at-bottom/scroll reads; its remaining long
tasks are a follow-up, not a claim of perfect frame stability.

New tests verify stable identities, non-invalidation of membership, task alias
precedence, per-row observation subscriptions and cleanup, and actual streaming
preview/assistant text. A separate legacy tool-activity script still targets removed status and connector
DOM selectors. It also fails against the baseline; it was not changed to hide
these failures. Current dedicated activity/connector/streaming release checks
passed. Full unit suite:237/237. Release browser suite:32/33 initially; the last
check required PLAYWRIGHT_CORE_PATH, and passed when rerun with that variable.
Thus all33 release checks passed across the suite run and targeted rerun.

Private samples/reports/profiles remain in ignored `desktop/.cache/performance`;
do not commit session contents or credentials. No model request serialization or
prompt-cache keys were changed.

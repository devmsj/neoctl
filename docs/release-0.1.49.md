# Web 0.1.49 / Core 0.2.71

Runtime update for the existing desktop client. Web pins Core to `0.2.71`; no desktop-shell update is required. Update from the desktop launch page (menu -> launch page -> update runtime).

## Changes

- Show every managed-retry error reason with the same error presentation as the final failure. Retry strategy/countdown and unrelated styles are unchanged.
- Child agents clone the parent's tool registry rather than evaluating tools without a child context (which incorrectly removed `image_inspect`). The main agent can explicitly pass `disallowed_tools`; the restriction is persisted and reapplied on resume. Existing agent-definition permissions and the non-recursive delegation boundary remain in place.
- Child agents keep the working directory captured at launch even if the parent later changes directories.
- Observe subagents in the main transcript, using the same message/tool rendering. An icon next to elapsed time/tools appears only when subagents exist and opens a main/subagent selector. Child views are read-only: no input or composer actions, but the same model/context/input/output status row remains. Its input/status separator is removed only in the read-only view.
- Observers page the child transcript without opening a writer and receive live SSE deltas. Mid-run attachment replays the in-flight remainder after the last durable message and uses the child's latest live context/usage figures. Closed streams release observer renderers; a missing task falls back to the main view. Main-agent input drafts survive view changes.
- Parent/child progress communication is semantic rather than raw stream tails: reports and tool failures trigger compact notifications after a parent tool batch; successful calls are aggregated by tool. A per-run read cursor prevents repeated injection, survives persistence, and resets on resume. `subagent_get` reads deltas and supports `wait_ms`; list and child peeks do not consume the parent's updates. Explicit detail/final-result reads remain available.

## Validation

- Core full unit suite: 770 tests, 768 passed, 2 skipped, 0 failed. Source and test TypeScript checks passed; test fixture typing corrections do not change shipped runtime code.
- Focused tests verify actual child model-request tool tables, explicit restrictions and persistence, sync/async launch-time cwd pinning, semantic progress deduplication/wait/restart/resume, and child SSE rendering/status/history isolation.
- Web unit suite: 260 passed, 0 failed. Production build and CLI packaging checks passed.
- Built, unmodified App tested in real Edge using native HTTP/SSE: 3 browser cases passed (main-only hides the entry; child/main switches preserve the draft, read-only state, status row and live deltas; missing-task reconnection falls back). Desktop and 390px menu screenshots inspected. One local fixture measurement: 106 ms to the first child view, 22 sampled frames, max 16.8 ms, no frame over 50 ms. This is a local fixture measurement, not a guarantee for every session.

## Package integrity

- Core `neoctl-0.2.71.tgz`: `sha512-jFWj3w4pxeFxXRngFeNLj10IFsoGchU+Oz/hazSKom6BzpNEV3r76EFKkz+2t/PXFgu3ldh8y5Eds9uFm98ltg==` (pinned in Web's lockfile).
- Web `neoctl-web-0.1.49.tgz`: `sha512-ekJzbNBV6XGeIvJF4MRpY64fTQBuybtw9kE2wYUJA5QUUU55Hi1M6azE1VeZkVuLfelCDdXZWyRQRpH7wqj40g==`.

## Limits

- Parent-model progress notifications are collected after tool batches; an idle parent is not automatically started. `wait_ms` waits for a semantic change without busy polling.
- Before the child's first context/usage event (or after process restart without live metrics), the context figure is estimated from retained child messages; it does not claim to include a reconstructed system/tool prompt.
- Tool-detail and uncached legacy-image lookups retain the existing full-history fallback.

# Web 0.1.48 / Core 0.2.70

Runtime update for the existing desktop client. Web pins Core to `0.2.70`; no desktop-shell update is required. Update from the desktop launch page (menu → launch page → update runtime).

## Changes

- Long-session status timing: Web snapshots and every streaming delta no longer rescan the whole transcript. Status uses the live run, or the persisted latest run found by scanning back from the tail to the previous run boundary (memoized by transcript stat). `getTimings()`/`getTimingRecords()` are unchanged.
- Deleted sessions stay deleted: a late writer (e.g. title generation of a switched-away engine) fails instead of recreating the session directory/transcript. Previously such a session reappeared in the list and could not be deleted until restart.
- Session list: summaries continue from the last complete line instead of rescanning a changed transcript, read in 1 MB chunks (no whole-file string), and are persisted in a disposable root index `.neo-list-summary.json` (file identity + tail hash; any mismatch rescans). A session deleted while listing drops its row instead of failing the whole list.
- History rendering: stored images report availability and decoded size from metadata (recorded size, payload head/tail) instead of reading, decoding and hashing every payload. Non-canonical payloads fall back to full validation; served image bytes are still fully validated.
- Web: a failed delete refreshes the session lists from the server.
- Includes the unreleased Web fix keeping a timestamp scratch cwd when a session has no workspace mapping.

## Measurements (Windows, real local data on temporary copies)

| Operation | Before | After |
| --- | ---: | ---: |
| Switch back to a 36 MB session (warm) | 1132 ms | 125–203 ms |
| One status snapshot / streaming delta | ~472 ms | 2 ms |
| Sidebar list after the active session appended | 279 ms (166 ms event-loop block) | 14 ms (5 ms) |
| First sidebar list after restart (376 MB, 173 sessions) | 3125 ms | 40 ms |
| History page render P50 / P95 / max (125 pages) | 66 / 297 / 1518 ms | 2 / 3 / 13 ms |

Warm open is independent of archive size (377 MB synthetic: 227 ms).

## Limits

- A missing/invalidated resume cache still replays the whole transcript once; a root without an index scans every transcript once.
- A same-size in-place modification of an image payload is no longer shown as unavailable in history; serving it still fails validation.
- Tool-detail and legacy (no image id) image lookups still fall back to full history on cache misses.

## Validation

- Status timing equals the full-scan derivation on the real 36 MB session; incremental list summaries equal a full rescan; all 3552 local stored images: metadata equals full validation (0 mismatches).
- New regression tests: latest-run timing equivalence, no resurrection after delete, incremental summaries (appends, partial tails, reset, replacement), image metadata equivalence. Two existing summary-cache tests now count `fsp.open` (chunked reads) instead of `fsp.readFile`; assertions unchanged.
- Final Core suite: 758 passed, 2 skipped, 0 failed; typecheck, session and web-history smoke passed. Web suite against the packed Core 0.2.70: 260 passed, 0 failed; production build passed.
- Real Web server smoke (isolated HOME/data): Core 0.2.70 loaded; new, list, resume and delete succeeded; the deleted session is not listed.
- Archive contents equal the working tree file by file and contain no runtime data or credentials. Core archive `neoctl-0.2.70.tgz` SHA512 `sha512-/L2C92N8AAo2vDtMR51lFExpuKSN9mjRnQ73qIYnDSq93Ue9vObYPlOiGHlZeimD8HcJmtAYsPzVWY0riQlRRg==` is pinned in the Web lockfile.

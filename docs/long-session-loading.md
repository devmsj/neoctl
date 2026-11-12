# Long-session loading: first-stage optimization

## Contract

- Web startup restores the complete effective model context, including compact checkpoints, content replacements, execution state and session settings. Archival display paging does not truncate model context.
- The first snapshot contains recent history; earlier history is prefetched and prepended automatically near the top. No manual pagination is required. Existing text, images, tool details and compaction reports remain available.
- Prepending preserves the reading anchor after virtual row measurement; fresh user input cancels anchor correction. Same-runtime SSE snapshots retain fetched history. A rebuilt runtime resets the paging boundary to avoid silently skipping intervening records.
- The transcript is authoritative. Checksummed, agent-scoped resume caches are disposable and rejected when the transcript changes. Cache failure never permits dropping transcript records. Stale concurrent writers cannot publish their partial state as a current cache.
- Only Web opts into lazy display; existing full-history APIs remain compatible.

## Reproduce

Build engine, then run:

```text
node tests/session/benchmark-history.mjs <source-transcript.jsonl> 1,10,100 [prefixBytes]
```

The source is read-only. All opening, cache writing and synthetic expansion use temporary copies, deleted afterward. `prefixBytes` must end on a newline and permits a stable baseline while a production session receives new appends. Repeated transcripts are a scaling fixture, not a semantically distinct conversation.

Tests:

```text
cd engine
npm run typecheck
npm test
npx tsx tests/session/smoke-session.ts
npx tsx tests/web/smoke-web-history.ts

cd ../web
npm test
npm run build
node tests/transcript-history-browser.test.mjs
```

The optional browser test requires local Playwright Core and Edge; set `NEO_PLAYWRIGHT_MODULE` to override the module path. Set `NEO_TEST_MOBILE=1` for the 390px viewport. This is a layout fixture, not a real touchscreen/device performance test.

## Measurements (Windows, local disk)

Baseline: 31,056,748 bytes, 9,643 display entries, 21 compactions, 494 effective context messages. Before: store opening 645 ms, display clone 135 ms, full UI-history reconstruction 4,152 ms; UI JSON 28,466,650 bytes.

After (individual backend stages, **not end-to-end browser startup**):

| Archive | Cold restore / cache construction | Warm restore | Recent-page read | Recent-page rendering |
| --- | ---: | ---: | ---: | ---: |
| 31 MB | 372 ms | 15 ms | 4–5 ms | 1–6 ms |
| 311 MB (10x synthetic) | 3,305 ms | 19 ms | 3–4 ms | ~1 ms |
| 3.1 GB (100x synthetic) | 31,874 ms | 14 ms | 2–4 ms | ~1 ms |

The initial history payload is 141,842 bytes (45 UI rows from 100 entries), rather than 28.5 MB. The latest page's contents determine that size; it is not a fixed byte limit for an indivisible large record/tool group.

Validation on the stable production-data copy:
- All 98 pages concatenate to exactly the original 9,643 display entries (SHA-256 equal).
- Effective model-context SHA-256 equals the original baseline.
- All 6,320 rendered UI rows compare equal to full-history rendering, excluding transport IDs/offsets.
- Desktop and narrow viewport fixtures report 0px reading-anchor drift after insertion, with no browser page errors.
- Production data was never opened for resume by the benchmark. The original transcript prefix remains hash-identical; the live source received external appends during testing. Its live image catalog also changed, so whole-directory immutability is not claimed.

## Remaining scope / honest limits

This is **not yet a complete arbitrary-length, cold-start solution**:

1. A missing, damaged or invalidated cache still requires O(total archive bytes) replay. Warm restore scales with effective context size, not total archive size. Incremental durable checkpoints/indexes are needed to remove repeated cold scans after crashes/external appends.
2. A very long uninterrupted runtime can accumulate live UI rows; scrolling all the way back retains fetched rows in browser memory. Two-way bounded windowing and scroll-coordinate rebasing are not implemented.
3. Tool-detail lookup and uncached legacy attachment lookups still use full-history fallback. Registered image payloads and recently paged attachments have fast paths.
4. A single giant record or tool group may exceed the usual page budget; preserving content and pairing takes priority over truncation.
5. Runtime rebuild changes the paging boundary and starts a fresh display window. Pixel-stable reconnection across such rebuilds and browser-native whole-history search are not guaranteed.
6. No production service restart/deployment or real remote end-to-end startup measurement is part of these results.

# Web 0.1.44 / Core 0.2.66

Runtime release for the existing desktop client's update channel. No desktop-shell version change is required. Web pins Core to `0.2.66`.

## Changes

- Restore recent display history first and automatically prefetch earlier pages while scrolling.
- Preserve effective model context independently of display paging.
- Add checksummed, disposable resume caches with transcript-change and stale-writer checks.
- Preserve reading anchors after virtual row measurement on desktop and narrow layouts.
- Accelerate registered-image and recently paged attachment access.
- Support the history route through the authenticated isolation ownership boundary.

## Validation

- Core: 710 passing, 2 skipped, 0 failed; production and test typechecks passed.
- Web: 259 passing, 0 failed; build and CLI packaging checks passed.
- Desktop scripts/UI: 57 passing, 0 failed.
- Browser history fixtures: desktop and narrow layout passed, 0px settled anchor drift.
- Source-data copy: model-context and full-history hashes unchanged; paged UI equals full rendering.

See `long-session-loading.md` for measurements and limitations. This release does not remove the initial O(archive-size) scan when no valid resume cache exists, nor implement a bounded two-way browser history window. Backend stage timings are not end-to-end startup claims.

# Web 0.1.45 / Core 0.2.67

Runtime update for the existing desktop client. Web pins Core to `0.2.67`; no desktop-shell update is required.

## Changes

- Retry interrupted model streams with the existing retry delays and attempt budget; isolate failed drafts and executable tool batches.
- Validate stream completion and upstream failure events; preserve completed responses across transport trailer errors.
- Persist each settled tool result before publishing it, without duplicate journal entries.
- Preserve summary integrity across compaction retries and retain full context for non-Responses continuation.
- Abbreviate long commands in empty terminal polls only; keep incremental output, exit status and original manager metadata.
- Comment out the five-click Runtime Context demo entry, including keyboard activation; leave presentation unchanged.

## Validation

- Engine full suite: 740 passed, 2 skipped, 0 failed.
- Web suite: 259 passed, 0 failed.
- Terminal smoke: 13 checks passed; terminal poll/pause tests: 5 passed.
- Demo browser functional checks: 2 passed. The separate 44px hit-target assertion also fails on the pre-change baseline; no layout change is included.
- Production/test typechecks, Core/Web builds, Web CLI packaging checks and git diff whitespace checks passed.
- Core archive integrity is pinned in the Web lockfile. Publish the verified archives, not a rebuilt package.

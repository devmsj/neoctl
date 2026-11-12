# Web 0.1.46 / Core 0.2.68

Runtime update for the existing desktop client. Web pins Core to `0.2.68`; no desktop-shell update is required.

## Changes

- Improve model-generated compaction summaries: preserve instruction provenance, task state and critical context without inventing new constraints.
- Preserve original user-message line/block/column mappings and index archived text for accurate paginated reads beyond the retained context budget.
- Require a non-empty `description` on every tool call through the shared model/execution schema; retain optional `maxResultChars` and its existing default budgets.
- Prefer `description` as the visible tool activity purpose while retaining legacy `purpose` compatibility. Strip injected framework fields before passing inputs to tools that do not declare them.
- Add one system-prompt sentence explaining that `description` is shown directly to the user as the tool activity label.

## Validation

- Engine full suite: 748 passed, 2 skipped, 0 failed (test concurrency 2).
- Web suite: 259 passed, 0 failed.
- Targeted tool-description, detail, pause/resume and prompt-config tests: 25 passed.
- Production/test typechecks and Core/Web builds passed.
- Tools, secrets and tool-detail smoke failures were reproduced on the pre-change HEAD in an isolated source copy; unrelated fixes are not included.
- Publish the verified archives; pin the Core archive integrity in the Web lockfile.

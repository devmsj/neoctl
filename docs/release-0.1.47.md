# Web 0.1.47 / Core 0.2.69

Runtime update for the existing desktop client. Web pins Core to `0.2.69`; no desktop-shell update is required.

## Changes

- Add `claude-fable-5-2` metadata: 128K maximum output, June 2026 knowledge cutoff, image input, and five adaptive-thinking effort levels (`low` through `max`; thinking cannot be disabled). Retain Fable 5.1 for existing configurations.
- Raise the configured context ceiling for bundled Claude models from 256K to 512K. This is neo's usage ceiling, not the upstream maximum. OpenAI limits, output limits and environment overrides are unchanged.
- Migrate the previous 256K default for existing bundled Claude entries once. Preserve other custom limits, explicitly edited/excluded entries, deletions and subsequent user changes.
- Fix OpenAI Responses search summaries being reduced to citation markers. Preserve the paragraph containing each citation, using offsets from its original content part. Invalid offsets retain the available text.
- Keep search models, request parameters, timeouts and result budgets unchanged. Previous CPA comparisons did not establish a consistent latency improvement from alternative parameters.
- Update one plugin hot-uninstall test fixture to supply the already-required tool `description`; no plugin runtime behavior changes.

## Sources

- https://platform.claude.com/docs/en/models/fable-5-2/overview
- https://platform.claude.com/docs/en/models/fable-5-2/whats-new-fable-5-2
- https://developers.openai.com/api/docs/guides/tools-web-search

## Validation

- Model metadata/settings, migration and search targeted tests: 28 passed.
- Source/test typechecks and production builds passed.
- Live CPA search through the built provider returned three non-trivial summaries (401, 444 and 438 characters) in 12.31 seconds. This validates restored summary text, not a latency improvement or full-page retrieval.
- The plugin fixture failure was reproduced with the previous release before updating the fixture.
- Final Core suite: 754 passed, 2 skipped, 0 failed. Final Web suite: 259 passed, 0 failed.
- Archive contents and SHA512 were verified against the built artifacts; neither archive contains runtime data or credentials.
- Publish the verified archives, with Core archive SHA512 pinned in the Web lockfile.

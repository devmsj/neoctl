# Neo Desktop 0.1.35

Includes Web 0.1.32 and Core 0.2.55.

- Improve native Anthropic streaming and multi-turn tool execution. Report output-limit truncation accurately, preserve final usage, and never execute a truncated tool batch.
- Use model-library output limits by default (128K for bundled Claude models; 64K fallback for unknown Anthropic-compatible models), while respecting explicit user settings.
- Show input usage from the first Anthropic packet without double-counting totals or freezing streamed output estimates. Correct the context meter using reported usage and fix local tokenizer loading.
- Set bundled Claude context budgets to 256K and retain the current fifth-generation catalog. This is a Neo context policy, not an upstream limit or pricing guarantee.
- Allow deleting referenced API connections and model entries. Require explicit interruption confirmation for active sessions, clear affected model selections, preserve conversation history, and keep cleared selections across reopening and session forks.
- Refresh deletion confirmations when occupancy changes and preserve unrelated unsaved settings.
- Repair the offline updater protocol fixture for the registry transport dependency and include protocol events in failure diagnostics.

Validated with native Claude multi-turn file/terminal tools, child tasks, image understanding, session resume, model-driven compaction, and a long tool response beyond the former 8K default. External image generation and search were not invoked as part of these live Claude checks.

Windows x64 installer, SHA-256 checksum, source commit, and payload/version manifests are attached to this release.

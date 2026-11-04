# Neo Desktop 0.1.39

Includes Web 0.1.36 and Core 0.2.58.

- Fall back to normal speed when OpenAI or Anthropic explicitly rejects fast mode, synchronize the session switch, and show a unified notification without replaying partially emitted output.
- Default to five automatic retries with increasing delays capped at 60 seconds. Show a theme-aware triangle countdown; click it to cancel automatic retry and pause, then click the normal triangle to resume manually. Include context-compaction retries and remove retry-count configuration from the Web UI.
- Enable subagent tools by default while instructing the assistant to delegate only when explicitly requested. Preserve saved tool overrides and prevent nested delegation.
- Disable the Xiaohongshu editor plugin by default while preserving explicit plugin choices.
- Keep unfinished work moving when requirements change, and use English for framework-feedback prompt and tool descriptions.
- Extend regression coverage for fast-mode fallback, retry countdowns, session settings, and default tool/plugin switches. Isolate integration tests from local model configuration.

Windows x64 installer, SHA-256 checksum, source commit, and payload/version manifests are attached to this release.

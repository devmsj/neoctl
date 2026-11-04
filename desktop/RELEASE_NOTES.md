# Neo Desktop 0.1.41

Includes Web 0.1.38 and Core 0.2.60.

- Improve Anthropic-compatible input token estimates with one fixed protocol-wide local formula, without model-specific multipliers.
- Use Messages token counting before proportional context compaction. Unsupported endpoints, invalid responses and failures fall back silently to local estimates; counting is bounded to 1.5 seconds and does not retry.
- Keep input/context display aligned with the values used for compaction instead of replacing them with generation usage. Existing compaction ratios and OpenAI accounting remain unchanged.
- Preserve counting and estimates through logging gateways, prioritized multi-connection routing, session changes and compaction boundaries.

Windows x64 installer, SHA-256 checksum, source commit, and payload/version manifests are attached to this release.

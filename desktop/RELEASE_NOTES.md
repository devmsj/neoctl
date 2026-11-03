# Neo Desktop 0.1.36

Includes Web 0.1.33 and Core 0.2.56.

- Fix native Anthropic session-title generation and persistence. Title requests use an isolated, tool-free prompt and only provider-confirmed visible text.
- Request readable adaptive-thinking summaries from Claude and supported reasoning summaries from OpenAI. Preserve streamed and completion-only summaries without duplicates; retain opaque signatures for protocol replay without displaying empty thinking cards.
- End thinking explicitly before answer text or tool generation, and on completion, cancellation or errors. Deliver the stopped state immediately over SSE so completed thinking icons cannot keep animating.
- Append a concise English UTC timestamp, precise to seconds, for every model turn including tool continuation. Persist prior timestamps unchanged and keep completed request prefixes stable, without adding cache controls.
- Separate machine/runtime system context from user-authored workspace documents. Remove the legacy date from User context and use concise English continuation/recovery instructions.
- Support native mid-conversation Claude system messages on documented model families, including Claude Haiku 5.5. Validate tool-result ordering and interrupted runtime tails. Unsupported models fail explicitly rather than silently changing roles; verified custom aliases can use the adapter capability override.

Live validation covered Anthropic Messages, OpenAI Responses and OpenAI Chat through a compatible endpoint: title generation/reload, thinking-to-answer and thinking-to-tool flows, immediate SSE/browser animation stop, and two-turn timestamp/prefix preservation. Readable thinking remains dependent on what the upstream provider returns; missing historical summaries cannot be reconstructed from signatures.

Windows x64 installer, SHA-256 checksum, source commit, and payload/version manifests are attached to this release.

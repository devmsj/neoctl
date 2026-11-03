# Neo Desktop 0.1.37

Includes Web 0.1.34 and Core 0.2.57.

- Enable fine-grained Anthropic input streaming for every client tool, including file editing/writing, terminal commands, plans and plugin tools. Preview incomplete arguments immediately; execute only after the complete response validates. Truncated, malformed, disconnected and cancelled streams never execute partial calls.
- Retain newly persisted sessions in the sidebar after switching away, and update generated titles in place.
- Sort loaded and live session rows consistently before date grouping. Empty sessions expose a stable creation date instead of appearing under older conversations.
- Refresh background session titles, additions and deletions in place while the window is visible and when it regains focus, preserving loaded pagination and scroll position. Search and administrator owner scopes remain isolated.
- Preserve the title, thinking lifecycle, concise English system-time injection and stable-prefix fixes from Desktop 0.1.36.

Live validation used Claude Haiku 5.5, Claude Opus 5.5, OpenAI Responses and OpenAI Chat through a compatible endpoint, with actual Edge DOM observation. Opus baseline buffered long parameter values until completion; enabling eager input produced continuous previews throughout generation. Regression tests cover five tool shapes, interleaved call IDs, completion/error/cancellation safety, session title retention, ordering, background refresh and search isolation.

Windows x64 installer, SHA-256 checksum, source commit, and payload/version manifests are attached to this release.

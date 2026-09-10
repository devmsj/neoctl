# Versioned global system prompt configuration

The core runtime, not the browser, owns the global base system prompt. `DefaultContextManager` (including the default used by `QueryEngine`, CLI and web runtimes) reads it on **every context build**. Saving affects future builds in all sessions using this baseline, without a restart. It does not mutate a request already sent to a provider. Session-specific prompt controls, when used, are a separate scope and do not write this file.

## Files and packaging

- The current version's complete natural-language baseline is `src/context/system.md`, not a TypeScript string or an empty override.
- `npm run build` copies it to `dist/context/system.md`; npm's existing `files: ["dist", ...]` includes that file. `prepare`/`prepack` run the build. The standalone distribution verifies and copies it with `dist`, and copies `package.json` for the version identity.
- On the first GET/build, core copies this Markdown into `~/.neoctl/prompts/<package-version>/system.md` (`%USERPROFILE%\.neoctl` on Windows). Subsequent reads and saves use **that same writable file**. Existing files, including invalid/empty files, are never reset to defaults. Each package version initializes its own file and leaves older versions untouched; migration between versions is an explicit user action.
- Trusted hosts/tests can set `NEO_SYSTEM_PROMPT_PATH` to an isolated file, or construct `PromptConfigStore({filePath})` and pass it as `DefaultContextManager({promptConfigStore})`. `homeDir`/`version` are also host-only store options. The HTTP client cannot select a path or version.

The Markdown contains Agent Scaffold, Doing Tasks, generic tool-use etiquette, and Tone And Output. Core still appends current tool availability, tool-result budgets, image loading/generation capability instructions, and secret-handling instructions. Plugin sections, application prompts, and Runtime agent/session context retain their existing composition chain. Global editing is **not** implemented with `overrideSystemPrompt`, so changing the baseline does not replace plugin/app/runtime sections.

## HTTP protocol

Handled by the engine's actual HTTP router **before** selecting/initializing a session. The outer web proxy needs no special route.

### `GET /api/prompt-config`

200 JSON, `Cache-Control: no-store`:

```json
{"content":"## Agent Scaffold\n...","revision":"<64 lowercase SHA-256 hex characters>","version":"0.2.37","path":"<absolute server-owned system.md path>"}
```

### `POST /api/prompt-config`

Accepts only `{"content":"...","revision":"<revision from GET>"}`. Content must be a string, contain non-whitespace text, and occupy at most **200000 UTF-8 bytes**. Original whitespace/newlines are preserved. Success is 200 JSON:

```json
{"ok":true,"content":"...","revision":"<new SHA-256>","version":"0.2.37","path":"<same path>"}
```

Errors always use non-2xx HTTP status and `{"errorCode":"...","error":"..."}`:

| HTTP | errorCode | Meaning |
|---|---|---|
| 400 | `PROMPT_CONFIG_INVALID` | Invalid JSON/fields/content/revision, or client-supplied path/version |
| 409 | `PROMPT_CONFIG_CONFLICT` | File revision changed or file disappeared; reload before retrying |
| 413 | `PROMPT_CONFIG_TOO_LARGE` | Content or bounded JSON request envelope too large |
| 405 | `PROMPT_CONFIG_METHOD_NOT_ALLOWED` | Only GET and POST supported |
| 503 | `PROMPT_CONFIG_BUSY` | Could not acquire writer lock within ten seconds |
| 500 | `PROMPT_CONFIG_STORAGE_ERROR` | Filesystem/storage failure |

Clients should retain unsaved drafts on failure; never automatically overwrite after a 409. Fetch the latest revision and let the user decide. Identical content has the same revision, including after a restart; external edits change the hash.

## Concurrency and recovery

Reads use the actual file, not a process content cache. Initialization and compare-and-save acquire an atomic sibling `<file>.lock` directory, serializing participating writers across sessions, store objects, and OS processes. The revision comparison happens inside this lock. Writes create a unique same-directory temporary file, flush it, and atomically rename it into place. Readers therefore see an old or new complete file, not a partly written body. Normal completion removes the lock and temporary file.

The lock is deliberately **not stolen based on age** (which could allow two live writers). After a crashed/killed writer, an administrator may remove the leftover `.lock` directory only after confirming that no writer is active. The prior complete `system.md` remains readable; orphan `.tmp` files can likewise be removed. External editors should save atomically; the API detects edits made before its locked revision check, but cannot coordinate an external editor that ignores the lock and writes concurrently.

## Layered session instructions

`GET /api/session-prompt?tabId=...&sessionId=...` returns `{content, mode, override, revision, effectiveContent, effectiveRevision}`. **content is only the editable session instruction**, empty when inheriting; `effectiveContent` is a read-only composition without internal cache markers. Clients must never save the effective preview as editable content.

Modes:

- `inherit`: no session instruction; follows the latest global file.
- `append`: latest global baseline plus session instructions (default for new edits).
- `replace_base`: replaces only sections tagged `source: "global"`, preserving runtime/tool/plugin/application sections. Embedded custom context managers must tag their global sections to opt into replacement.
- `legacy_full_override`: existing transcripts without a mode retain their exact historical full replacement. No automatic text stripping or migration occurs. The UI warns and requires confirmation before switching modes; new sessions cannot create this mode. Old clients editing an existing legacy prompt without specifying mode retain legacy semantics.

`POST` accepts `{content, mode?, revision}` or `{reset:true, revision}`. Success adds `{ok:true, deferred}` to the GET shape. Reset returns to inherit and clears only session configuration. Empty custom text, internal markers, invalid modes, unknown fields, and content over 256 Ki characters are rejected (400 / `SESSION_PROMPT_INVALID`). Competing session edits return 409 / `SESSION_PROMPT_CONFLICT`; storage failures return 500 / `SESSION_PROMPT_FAILED`.

`revision` covers the session configuration and its owner, not generated text. Global/tool/plugin changes update `effectiveRevision` and the preview without invalidating a session draft. Global editing retains its independent file CAS. Clients preserve drafts on failed saves and runtime preview updates.

Session content and mode persist in the transcript and restore in the same session only. Accepted busy edits persist immediately but become active at the next model-turn boundary; in-flight requests do not change. Runtime context exposes active `mode`, `effectiveRevision`, and queued `pendingMode`/`deferred`, separately from the editor's desired state.

## Tool-dependent context

Effective tool definitions are captured once per model request and used both for capability instructions and the provider tools list. Plugin prompt sections may declare `requiresTools: ["tool_name"]`; such sections are included only when all dependencies are in the effective tool set. General plugin instructions remain independent. The downloads plugin uses this for `expose_downloads`. Disabled tools do not rewrite arbitrary user-authored text; runtime instructions explicitly explain that text cannot enable an unavailable tool.

Web hosts provide `resolveGlobalToolOverrides` alongside persistence. Existing runtimes re-read this shared source at the next model-turn boundary or idle preview/tool-list refresh, so `inherit` follows global changes without reconstructing the session. Explicit session enable/disable settings retain precedence. Busy previews never change the executing tool registry. This is lazy refresh within the host, not a cross-process file watcher or a push update to every browser tab. Tool settings publish only after successful persistence; concurrent global/session writes are serialized.

## Validation

All tests use OS temporary directories and never touch real user configuration:

```sh
node --import tsx --test src/context/prompt-config.test.ts src/web/prompt-config-protocol.test.ts
npm run typecheck
npm run build
```

Coverage includes exact Markdown initialization, preservation/reload, restart/separate-process reads, cross-process CAS, concurrent initialization, illegal content and byte limits, actual ContextManager composition and QueryEngine future requests, real HTTP handler GET/POST/error semantics, and global route placement before session initialization.

# Desktop 0.1.16 release validation

## Version contract

- Desktop: 0.1.16
- Web: 0.1.16, exact dependency `neoctl: 0.2.42`
- Core: 0.2.42
- Release build refuses npm latest/source mismatches. The bundled Web tarball is fetched from npm; Core and other dependencies are installed online.

## Local regression checks

- Core source/test TypeScript checks: passed.
- Delegation defaults and no-nested-delegation: 7 passed.
- Web CLI/tool settings/plugin settings: 9 passed.
- Desktop UI/script unit tests: 33 passed.
- Rust: 54 library + 28 updater tests passed.
- Release updater offline protocol: passed (commit, occupied old version, cleanup retry, abort recovery, single-version retention, user-data preservation).
- Desktop browser/keyboard/backend-control checks: passed again during release preparation.
- Published Web 0.1.16 / Core 0.2.42 network integration: passed, including HTTP tool defaults, install + update, old-version deletion and data preservation. First local attempt hit a proxy ECONNRESET; a fresh full test succeeded without disabling TLS or assertions.
- First remote run exposed Windows PowerShell module discovery incompatibility in Node preparation. SHA256 and ZIP extraction now use .NET directly; no release assets were published by that failed run.

## Existing baseline failures (not suppressed)

The Core full suite has 30 existing failures: before changes 362 passed / 30 failed / 2 skipped; with the five new defaults tests 367 passed / 30 failed / 2 skipped. The failure set was compared against an isolated checkout of the original HEAD. In particular, historical secret-redaction tests expect redaction while the already-committed implementation intentionally passes through user-owned output.

The Web full suite has 119 passed / 1 failed: `queued for resume and unknown are never green completed` in `agent-task-presentation.test.mjs` expects the label `调用失败`, while the unchanged implementation returns `失败`. Neither that source nor its test was modified in this release.

The release workflow runs strict release-specific checks, not a falsely green full-suite job. Existing failures remain visible and are not skipped or relaxed.

## Remote acceptance

The GitHub release workflow must pass real npm install + upgrade in a temporary directory, exact Web/Core version assertions, HTTP Core health, seven delegation defaults, old-version deletion, and data preservation before publishing the installer. It emits version manifests, source commit and SHA256 alongside the installer. Consult the corresponding Actions run for the authoritative remote result.

## Boundaries

- No existing desktop installation or real user data is modified by these tests.
- Installer UI and an upgrade in the user's actual installed desktop are not automated by the temporary-directory integration test.
- Updates stop only managed process trees. Unrelated external processes/ACLs can still block deletion; errors remain explicit and cleanup is retryable instead of falsely reporting success.
- Rollback switches program versions; it does not undo incompatible changes to shared user data.
- The temporary local proxy is not stored in shipped configuration.

# Launcher round-trip deadlock

## Observed on Windows debug desktop

Returning to the embedded launcher and entering the existing workspace could freeze the native window. The backend stayed alive, desktop CPU stopped increasing, and Windows reported the window as not responding. This was not the earlier streaming-renderer CPU bottleneck.

Native instruction-pointer/stack-memory symbol sampling (not a fully unwound debugger backtrace) showed:

- UI thread: `NtWaitForAlertByThreadId` / mutex contention, with `local_resources::authorize` and synchronous `watch_file_drops` on the stack.
- Surface-sync worker: channel receive waiting for `WebviewWindow::url`, with `desktop_chrome::authorize` and `sync_surface` on the stack.

Source inspection confirms the lock cycle: chrome authorization retained `runtime_url` while `window.url()` synchronously dispatched to the UI thread. The UI thread was registering drag/drop and waiting for `runtime_url` itself. Windows wait-chain traversal did not detect this Rust mutex/channel cycle.

## Fix

Clone runtime authorization data inside an explicit scope and release its guard before calling any WebView API. Keep exact-origin authorization unchanged. Make drag/drop subscription commands asynchronous so their authorization does not block native IPC dispatch.

Do not replace authorization with a permissive origin check, spin on the lock, or restart the backend to conceal the freeze.

## Regression coverage

- `tests/ui/navigation-locks.test.cjs`: lock scope and async registration guards, included in `npm test`.
- `tests/ui/bootstrap-page-native.test.cjs`: opt-in native round trips, discovers the actual runtime port, stresses real surface/drop IPC concurrently and restores normal drop registration with a final reload. Uses an already-running debug shell; never sends a model message.
- Run with `PLAYWRIGHT_CORE_PATH`, `NEO_DESKTOP_CDP=http://127.0.0.1:9224`, optionally `NEO_NAVIGATION_ROUNDS=12`.

Private incident samples remain in the ignored local cache, not release artifacts.

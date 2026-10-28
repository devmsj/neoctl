# Personal appearance

## Boundaries

Appearance belongs to the signed-in account (or the local desktop data directory), not a session, workspace, model configuration or transcript. No appearance values or resource IDs are added to model input, SSE state, message history or prompt-cache keys. Administrators editing another user's runtime still edit **their own** appearance.

The editor is under Global settings → 客制化. Day and night schemes are independent. Each has one accent seed; hover, selection, focus and readable foregrounds are derived, not separately persisted. The editor exposes background, typography, colors and layout; advanced regional colors and opacity are collapsed. Animation and semantic success/error colors remain application-owned.

## Contract and storage

- `shared/appearance.mjs` is the browser/server allowlist. Version 1 stores only overrides, so `{}` retains native defaults.
- Unknown fields, unsupported versions, non-finite/out-of-range numbers, CSS injection and invalid resource IDs fail explicitly. A future schema is never silently downgraded.
- Local path: `<dataRoot>/appearance/settings.json`; isolated path: `<dataRoot>/isolated-users/<username>/appearance/settings.json`.
- Resources live in the adjacent `assets` directory, named by SHA-256 of actual bytes plus validated extension. No arbitrary paths, remote URLs or executable CSS are accepted.
- Writes are serialized within the single server process, written to a unique temporary file, flushed, then renamed. Revision-based compare-and-swap rejects stale writes with HTTP 409. This is **not** a distributed/multi-process lock.
- Corrupt configuration is preserved and reported, not overwritten. For manual recovery, stop the relevant backend, back up `settings.json`, then move it aside. Assets need not be deleted.
- localStorage is only a user-scoped startup cache. The server remains authoritative. The previous local light/dark choice is imported when no server settings exist. There is no historical appearance-schema migration because this is its first schema.
- Concurrent reads cannot replace a successful newer save. Cross-tab updates reload when not previewing; a dirty draft is never silently replaced. Navigation asks before discarding edits.

## Resources

Backgrounds are browser-decoded and independently checked by Core's byte validator. Filenames and reported MIME are not trusted. PNG/JPEG/WebP/GIF are accepted; active SVG/HTML is not. Font uploads validate table boundaries; WOFF2 additionally validates its directory and Brotli stream. Browser `FontFace` sanitizes and rejects unusable fonts; failures use fallback fonts. Font collections are not supported.

Resource delivery is authenticated in isolation mode, `private, no-store`, `nosniff`, and uses streaming backpressure. Existing reverse-proxy limits are unchanged; no new image/font file-size cap was added. Configuration JSON alone has a 256 KiB limit.

Theme export is a portable JSON bundle with referenced assets, including saved presets. Import checks the whole reference manifest before uploading and validates each returned content hash. A failed import does not apply a partial configuration. Uploaded but unsaved resources can remain on disk; there is deliberately no automatic garbage collector that could delete another tab's draft. The DELETE resource API refuses resources referenced by either active schemes or saved presets.

## Rendering and performance

`appearance-tokens.mjs` is the only configuration-to-CSS compiler. CSS declarations use semantic variables with their exact original fallback values. Preview applies a root-variable diff once per animation frame; it does not replace the application DOM or watch every streamed message. Typography/layout changes debounce virtual-row remeasurement; colors do not. Background filters are confined to one decorative layer, not every transcript row. Fonts and global listeners are removed on account unmount.

The settings controls keep fixed readable chrome so extreme workspace colors or text sizes cannot make reset/apply inaccessible. The preview and the workspace still use the draft. Day/night selection is an editing preview; apply/cancel restores the configured actual mode.

## `!important` review

Run `node scripts/audit-appearance-css.mjs` from `web`. It inventories CSS files **and component-local styles** and emits every declaration with selector, property and classification. Automatic classification is a review aid, not proof of coverage.

Reviewed categories:

| Category | Decision |
| --- | --- |
| Background/text/accent/surfaces/fonts/size/radius/borders | Connect at the original declaration or semantic-token definition, retaining fallback and specificity. |
| Legacy universal `background-image: none` | Permit only `--neo-surface-image` on the dedicated background pseudo-layer; do not re-enable old gradients everywhere. |
| Login/AuthGate | Keep fixed: no authenticated user preference should leak into a public login page. |
| Celestial theme switch, clock/rings, status glyphs, toggle pills | Preserve geometric silhouettes, semantic colors and existing animations. |
| Layout constraints, visibility, reduced-motion, hidden scrollbars, pointer behavior | Retain priority. They enforce behavior rather than decorative preference. |
| Success/error/warning, danger actions, syntax deletion | Preserve status meaning rather than recolor all states to the accent. |
| Legacy hard shadows, observation shadow/blur, overlay dimming | Preserve current treatment; shadow/motion customization is not exposed. Later chrome resets remain intentional. |
| Typography weight hierarchy, resource link decoration, alignment | Preserve hierarchy/decorations; expose正文 weight separately without flattening headings/status labels. |
| Appearance control safety rules | Keep fixed readable control font, sizing and surfaces; these are deliberate exceptions to preview customization. |

## Verification

- `appearance.test.mjs`: strict schema, derived contrast, atomic save/CAS/corrupt-file protection, content validation and resource reference guards.
- `appearance-controller.test.mjs`: late GET, overlapping save, save-time GET and dispose races.
- `isolation.test.mjs`: authenticated account scope, admin-owner exclusion, persistence without runtime warm-up.
- `appearance-browser.test.mjs`: independent day/night, single accent picker, preview/apply/cancel, conflicts, narrow screens and ordinary-account entry.
- `appearance-resources-browser.test.mjs`: real HTTP storage, misnamed image bytes, backend-store recreation, portable resource import/export, actual font loading, invalid input recovery and computed typography/layout.
- `run-release-browser-tests.mjs`: existing attachment, streaming, IME, status, tool connector and layout regressions.
- `runtime-input-performance.mjs`: explicit long-history/streaming/input measurement; never included in normal unit discovery.

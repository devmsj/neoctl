# Neo Desktop 0.1.31

Includes Web 0.1.28 and Core 0.2.51.

- Add persistent appearance customization with independent light/dark profiles, background images, fonts, layout controls and a single accent color with derived interface colors. Preview changes, save presets and import/export appearance bundles.
- Validate uploaded image/font contents, isolate appearance resources by account and protect concurrent saves with revision checks. Existing defaults remain unchanged until customized.
- Unify select controls and integrate appearance tokens throughout the workspace, composer, conversation content and settings.
- Reduce long-conversation streaming stalls by retaining stable shallow-reactive rows, indexing runtime tasks and updating only the affected observation subscriptions instead of repeatedly invalidating full history.
- Avoid redundant observation-panel height notifications and serialized content comparisons while preserving rendering, animations and interaction behavior.
- Add appearance persistence/isolation tests and streaming reactivity/browser regressions. A 330-second debug desktop replay received all 4,117 events without losing the renderer probe; remaining long-markdown layout costs are documented separately.

The release workflow verifies published npm versions, tests Core/Web/Desktop, builds the Windows x64 installer, and verifies actual installation and upgrade before publishing artifacts.

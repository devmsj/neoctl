# Desktop 0.1.26

Includes Web 0.1.24 and Core 0.2.48.

- Frameless desktop controls and an integrated application menu.
- Responsive sidebars prioritize the conversation area in narrow windows.
- Dark launcher with a single primary entry and logs shown only when available.
- Dedicated embedded launcher resources fix returning to the start page.
- Explicit development-server attachment avoids duplicate starts and runtime lock conflicts.
- Refined configuration, context, background-task, session and composer interfaces.
- Streaming math rendering and worker-based syntax highlighting with stable DOM updates.
- Multi-directory workspace scope management while preserving the stable prompt prefix.
- Consolidated tool guidance in tool descriptions.
- Release checks now cover launcher interactions, window chrome, streaming rendering, IME events and compact layouts.

The release workflow verifies published npm versions, builds the Windows x64 NSIS installer, checks the bundled updater, and tests installation and upgrade before publishing artifacts.

# Neo Desktop 0.1.30

Includes Web 0.1.27 and Core 0.2.51.

- Reduce input lag during streaming in long conversations by indexing user-message groups, tool images and previously exposed resources instead of repeatedly scanning transcript history. Existing rendering, animations and attachment visibility are preserved.
- Desktop folder drops append paths as text; file drops retain attachment handling.
- Sending while a desktop session is running queues the message by default, matching Enter. Explicit immediate-send still interrupts; Web behavior is unchanged.
- Queued messages show normal text, borderless image previews and minimal filenames without internal image labels. Pending image previews survive page reloads while the backend queue exists.
- Sidebar running indicators remain visible when switching sessions and clear when runs finish, without eagerly restoring historical sessions.
- Image generation and editing observation panels show only the model-written prompt rather than argument JSON.
- Add transcript-index correctness tests and an explicit synthetic streaming/input performance benchmark, plus desktop queue, folder-drop, running-session and image-prompt browser regressions.

The release workflow verifies published npm versions, tests Core/Web/Desktop, builds the Windows x64 installer, and verifies actual installation and upgrade before publishing artifacts.

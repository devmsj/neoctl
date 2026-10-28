# Neo Desktop 0.1.32

Includes Web 0.1.29 and Core 0.2.52.

- Simplify the session sidebar with compact search, management and new-session actions. Keep footer actions reachable, move theme switching into the menu and provide home navigation from settings and session management.
- Add themed desktop settings and always-on-top controls, unified custom tooltips, editable font selectors and accent-aware scrollbars.
- Refine Appearance with outlined category selection, background-derived opaque panels and sidebar colors, independent day/night profiles, distinct code palettes and coordinated table headers. Migrate retired panel color and opacity overrides from existing profiles and presets.
- Align the activity indicator with the observed tool. Keep clock hands in the chosen accent and turn the face and duration vivid green only after successful completion.
- Allow deletion of the current idle session after confirmation, release its writer before deleting files and open a fresh session. Protect running sessions, pending writes and multi-window reconnection.
- Fix a native window lock cycle when returning from the launcher to the workspace; preserve strict origin authorization and asynchronous drag/drop registration.
- Expand Core, Web, native window and browser regression coverage.

The workflow verifies npm package versions, runs Core/Web/Desktop regressions, builds the Windows x64 installer and tests actual installation and upgrade before publishing release assets.

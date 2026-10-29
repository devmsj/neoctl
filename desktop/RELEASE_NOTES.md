# Neo Desktop 0.1.33

Includes Web 0.1.30 and Core 0.2.53.

- Add Windows acrylic and transparent window materials with coordinated, background-derived surface layers, including inactive windows and compact layouts.
- Redesign Appearance as an extensible preset gallery. Add named custom designs, editable built-in presets with one-click reset, separate day/night profiles and immediate system-theme following.
- Add persistent display controls for session lists, the composer, background tasks, memory and quota. Reclaim hidden sidebars and keep recovery actions accessible.
- Refine desktop and mobile navigation, transient panels and loading rings. Remove disruptive icon hover hints while preserving accessible labels.
- Use the native Windows clipboard for explicit desktop copy and paste, including validated PNG image conversion, without browser clipboard permission prompts.
- Treat slash-prefixed composer messages as ordinary text rather than system commands. Present system information in expanded, accent-colored notices with appearance-aware corners and internal scrolling.
- Expand native authorization, isolation, appearance, streaming and browser regression coverage.

The release workflow verifies published package versions, runs Core/Web/Desktop regressions, builds the Windows x64 installer and tests actual installation and upgrade before publishing assets.

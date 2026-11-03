# Neo Desktop 0.1.34

Includes Web 0.1.31 and Core 0.2.54.

- Add native Anthropic Messages support alongside OpenAI Responses, with explicit protocol selection and editable API connections.
- Introduce a single model composition for the main model, OpenAI image generation and OpenAI search with Exa fallback. Apply changes across sessions at safe API-turn boundaries without changing an in-flight request.
- Add an editable, persistent model library with custom reasoning tiers, model ID changes and deletion confirmations. Warn before interrupting sessions holding a deleted model; preserve edits and removals across upgrades.
- Refresh the bundled Claude catalog using official model IDs, token limits, image-input capabilities and supported reasoning settings.
- Run capability checks independently and report results as they complete. Correct Anthropic-compatible tool-continuation detection, including DeepSeek responses.
- Simplify model settings, improve action icons and add an accent-aware, animated reasoning slider with keyboard and touch controls.
- Fix Appearance loading in the local development Web, improve desktop registry selection and refine session recency handling.
- Extend model lifecycle, live synchronization, isolation, detection and browser regression coverage.

The release workflow verifies published package versions, runs Core/Web/Desktop regressions, builds the Windows x64 installer and tests actual installation and upgrade before publishing assets.

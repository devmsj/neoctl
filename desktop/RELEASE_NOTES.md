# Neo Desktop 0.1.40

Includes Web 0.1.37 and Core 0.2.59.

- Enable several API connections at once in a drag-to-reorder priority list. Each capability uses the top-most enabled connection that lists its model and supports the model's own protocol; failed requests never switch connections automatically.
- Choose the models each connection serves with a transfer box (search, select all, double-click, add a new model ID). One connection can serve both OpenAI- and Anthropic-compatible models.
- Main model, image generation and search now pick models only; the effective connection is shown beside each field and on the list rows. Session model switching follows the same routing.
- Deleting a connection that a running session uses still asks for interruption; the next qualifying connection then takes over. Model library, metadata editing and checks are unchanged.
- Existing settings migrate automatically with identical routing and the previous session model list.

Windows x64 installer, SHA-256 checksum, source commit, and payload/version manifests are attached to this release.

# Attachment uploads

Ordinary chat attachments use sequential binary chunks (4 MiB each), with no application-level total file-size cap. The browser slices the File directly; it does not Base64-encode the whole file. The server writes chunks at validated offsets into one `.partial/<id>.part` file, then renames it to the final uploaded filename without making a second full copy.

- The pink button reports aggregate progress across files. 100% is reserved for successful finalization; errors reset it to white.
- A failed chunk can be retried up to three times. Before retrying, the browser queries the committed offset to avoid duplicate writes when a response is lost.
- Failed uploads are cancelled and their temporary file deleted when the server is reachable. Idle incomplete sessions are cleaned after 24 hours in the running process. Completed uploads have no expiry.
- Reloading the page or restarting the server does not support resuming an incomplete upload; select the file again. A server crash may leave a `.partial` file requiring cleanup.
- Disk space, browser/file-system capabilities, and network availability still apply. The 4 MiB request bound is not a total-file restriction.
- Inline image attachments retain their existing local preparation/compression and are sent with the chat message. Legacy JSON uploads remain compatible, with the previous 25 MiB check removed; use the chunk protocol for large files.

Protocol (query parameters such as workspace selection are preserved):
1. `POST /api/uploads/chunks` JSON `{name, size, mimeType}` returns `{uploadId, chunkBytes, offset}`.
2. `PATCH /api/uploads/chunks/:id` binary body, `X-Upload-Offset` header. Returns the committed byte offset.
3. `GET /api/uploads/chunks/:id` queries committed offset.
4. `POST /api/uploads/chunks/:id/complete` returns the existing `{ok, file}` attachment response.
5. `DELETE /api/uploads/chunks/:id` cancels an incomplete upload.

Validation: `node --test tests/chunk-uploads.test.mjs tests/upload-progress.test.mjs`.

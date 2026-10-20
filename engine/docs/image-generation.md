# Image generation and editing (`image_create`)

## Defaults and model selection

- Default routing model: **`gpt-image-2.5-sunburst`**.
- Default quality: **`auto`**, not `max`. `auto` lets the upstream choose; it does not promise the highest tier.
- Prefer Sunburst for finished artwork, typography, complex layouts and precise edits. Prefer `gpt-image-2.5-flare` when speed / interactive iteration is explicitly important.
- Cost is not a model or quality selection criterion. Never silently switch models or lower a requested tier.
- Both 2.5 models expose `auto`, `low`, `medium`, `high`, `xhigh`, `max`. Explicit `gpt-image-2` compatibility exposes only `auto`, `low`, `medium`, `high`.
- The tool schema and system prompt share the same selection guide. Explicit user choices override selection heuristics.

Configuration precedence: tool options > `OPENAI_IMAGE_MODEL` > default model; tool options > `OPENAI_IMAGE_API_KEY` > `OPENAI_API_KEY`; tool options > `OPENAI_IMAGE_BASE_URL` > `OPENAI_BASE_URL` > public OpenAI URL. Existing explicit model configuration remains respected. A base URL may include `/v1` (it is not appended twice). The default request timeout remains 360 seconds.

## Input contract

| Field | Contract |
| --- | --- |
| `semanticName` | Required meaningful name; generic names and Windows reserved basenames are rejected; normalized to a safe semantic slug. |
| `prompt` | Required nonempty string, at most 32,000 Unicode code points. |
| `mode` | `generate` (default) or `edit`. |
| `size` | `auto` or `WIDTHxHEIGHT`; multiples of 16, each edge <= 3840, aspect ratio <= 3:1, 655,360–8,294,400 total pixels. Examples: `1536x1024`, `2048x2048`, `3840x2160`. |
| `quality` | Model-specific tiers above; explicit tiers are sent unchanged. |
| `outputFormat` | `png` (default), `jpeg`, `webp`. |
| `background` | `auto` (default), `opaque`, `transparent`; JPEG + transparent is rejected. |
| `moderation` | `auto` (default), `low`; request acceptance is not evidence that moderation changed. |
| `n` | Integer 1–4; default 1. |
| `image` / `images` | Explicit PNG/JPEG/WebP edit sources. Exactly one of `base64`, `data`, `dataUrl` per source. Raw base64 needs a matching `mimeType`. Maximum 50 MiB each; 40 MP inspection ceiling. |
| `imageRefs` | Prior conversation stable image IDs, labels or numeric refs. Unknown / ambiguous refs fail rather than silently choosing another image. Maximum 16 total sources across all source fields. |
| `useLatestImage` | Default true; latest-image fallback only in edit mode when no explicit sources or refs are supplied. |
| `outputDir` | Optional output directory. |
| `outputPath` | Optional single-image path hint; requires `n=1`. Semantic name and actual format determine the final filename. Takes precedence over `outputDir` with a warning. |

The runner's common `maxResultChars` field is still supported and stripped before image-specific validation. Unknown image fields are rejected. Compression, mask, input fidelity, streaming and partial-image controls are **not** exposed by this integration; they have not been established as effective on the tested gateway.

Hard errors include wrong types/enums/ranges, unsupported combinations, malformed source payloads, source MIME disagreement and unresolved references. Errors identify the requested/configured model and offending parameter. Validation occurs before network requests, and direct calls also validate rather than relying solely on the runner.

Valid but potentially unintended inputs (e.g. edit sources supplied to generate mode, or both output destination fields) run with structured warnings. The source payload itself must still be valid.

## Session image identity and inspection

Images are session resources, not positions in the current model context. `sessionDir/image-resources.json` (version 1) owns the resource catalog and latest-image pointer. Every new resource receives an immutable `image_<UUID>` ID and a persistent `img_N` alias. An alias is allocated once, never renumbered by compaction or pixel retention. Labels are display metadata, not primary keys.

- User attachments, tool-loaded images, generated images and assistant image blocks are persisted and registered **before** entering the inner query loop, history or transcript. These consumers receive the same normalized identity and payload reference.
- New local imports and generated outputs keep their authoritative payload under the session's `attachments/images` directory. Moving/deleting a generated export does not remove its edit source. Re-importing the same path and bytes reuses identity; changing the file contents creates a new resource, without changing the old ID.
- `image_inspect` returns copyable UUIDs and aliases, including when loading local paths. Use `{"mode":"list","offset":0,"limit":20}` to discover references without loading pixels; `limit` is 1–100. Results include availability and pagination. This removes the need to provoke errors to discover IDs.
- `image_inspect` and `image_create` share reference and payload resolution. Unknown references, ambiguous labels and known references with missing/corrupt payloads are different errors. None silently substitutes another image. Explicit multi-image order is preserved.
- `next_turn` / `while_relevant` / `pinned` govern pixel visibility only. Expiration placeholders keep the immutable ID. Continuous compaction and restart do not unregister resources. The latest-image fallback remembers the most recently loaded/generated image; replaying preserved historical messages does not change it.
- Compaction receives an authoritative catalog snapshot. Boundaries retain compatibility metadata, but are not the source of truth; the model-facing directory shows at most 20 entries and points to paginated discovery.
- Catalog writes are serialized, file-locked, synced and atomically replaced. Independent stores reload before allocation. Identity conflicts and failed commits do not change an existing ID's bytes. Unreadable/corrupt catalogs fail closed instead of silently reallocating aliases. A lock with a live or unidentifiable owner times out rather than risking two writers; after a crashed process, an unverifiable leftover lock requires operator inspection.

### Existing sessions and lifecycle

On first open without a catalog, migration streams the original `transcript.jsonl`, reserves the latest legacy checkpoint aliases, and repairs missing identity/storage/hash fields using the exact source message and block index—not labels or image similarity. Other recorded resources are added after reserving historical aliases. Legacy inline payloads are persisted. Migration creates the catalog without rewriting the transcript or modifying existing stored payloads; missing original bytes cannot be reconstructed and remain explicitly unavailable.

The catalog must be backed up with the session and its image payloads. A context reset within the same session does not delete image resources; opening a different session uses a different catalog. Hosts with persistence disabled retain the catalog only for that in-memory session. Previously generated legacy payloads may still live at their original absolute paths; migration preserves those references rather than copying or relocating historical files.

## Compaction UI lifecycle

Compaction reports are primary timeline items, never nested inside collapsed process groups (including legacy reports without a primary flag). An idle **Compact session** click starts immediately through the settings barrier and publishes `phase=compacting` before awaiting the summary; duplicate requests are rejected while it is in flight. The browser shows progress and a completion/error notification.

While a query is busy, the same action only queues a compact request. It is consumed before the **next model call**, not during the active call and not merely because the current query finishes or aborts. If no next call occurs yet, the request stays pending. Other session settings retain their existing terminal-settlement behavior.

Automatic model-driven compaction reports its start before waiting for the summary stream. The UI distinguishes automatic, manual and context-limit recovery compaction rather than calling all summary wait time “preparing”. Ordinary budget checks that do not trigger compaction emit no false start event.

## Requested vs. reported vs. byte-inspected output

- `requested`: the actual outgoing API parameters, including model, quality and other defaults.
- `actual.model`, `actual.quality`, `actual.background`: **upstream-reported** values, or null when absent. These are not independent verification of internal model routing or compute.
- `actual.images` and `images`: MIME type and dimensions inspected from returned bytes. Every image includes `hasAlphaChannel` (boolean, encoded alpha presence from PNG color type / WebP alpha flag; JPEG is false), independently of `hasTransparentPixels` (true/false where decoded, omitted if unknown). An opaque RGBA/LA PNG still has `hasAlphaChannel=true` and `hasTransparentPixels=false`. PNG palette/color-key `tRNS` transparency is not a separate alpha channel: it can have `hasAlphaChannel=false` and `hasTransparentPixels=true`. Do not equate channel presence with actual transparent pixels.
- `warnings`: `{ code, field, message, requested?, actual?, remedy? }`, retained in the model-visible tool result and summarized in REPL/web output.

Examples: `COUNT_MISMATCH`, `SIZE_MISMATCH`, `FORMAT_MISMATCH`, `TRANSPARENCY_MISMATCH`, `MODEL_UNVERIFIED`, `QUALITY_UNVERIFIED`, `UPSTREAM_QUALITY_MISMATCH`, `INVALID_OUTPUT_IMAGE`.

A quality echo different from an explicit tier is a **metadata discrepancy**, not proof of an internal downgrade. No verified official contract was found saying that `max` is merely a compute ceiling that normally reports low/medium. Do not invent such an explanation. With `quality=auto`, low/medium/etc. reporting is expected selection, not a mismatch.

Actual MIME determines the saved extension and UI image MIME; a JPEG request returning PNG is saved as PNG, never disguised as JPEG. A partial batch with usable images succeeds with warnings; no usable images is an error. Concurrent same-name local writes use exclusive creation to avoid overwriting previous images. There is no silent local resize, format conversion, retry or fallback-model substitution.

### Inspection boundaries

PNG inspection validates chunk bounds, dimensions, image-data presence and (for 8-bit non-interlaced images) decompression, scanline filters and transparent pixels. It is not a complete PNG conformance/CRC validator. JPEG and WebP inspection validates identifying structure and dimensions, not full codec decoding. For alpha-capable WebP and unsupported PNG pixel layouts, actual transparency can remain unknown and is warned for transparent requests. Format/size inspection does not prove visual fidelity, instruction following or model identity.

## Current compatible-gateway limitation

The September 2026 investigation included 167 direct gateway requests, generation/edit matrices for both 2.5 routes, negative cases and bypass probes. On that tested Codex-backed route, many accepted controls were not reflected by actual dimensions, format or count. Responses often contained PNG, 1254x1254 and one image despite different requests. The same behavior was reproduced directly against that route's upstream; request validation alone cannot fix it.

Consequently, integration guarantees local input validation, faithful outgoing parameters, honest output inspection and warnings—not that every accepted gateway control is enforced. No gateway credentials, CPA source or investigation artifacts belong in this repository. Tool-runner end-to-end probes and investigation material are kept separately on the desktop.

## Verification

```sh
npm run typecheck
npx tsx --test tests/tools/image-generation.test.ts tests/core/session-images.test.ts
npm run smoke:images
npm run smoke:context
npm run smoke:tools
npm test
npm run build
```

The image-specific suite covers model/tier contracts, dimensions, invalid types, source/ref resolution, base URLs, real PNG/JPEG/WebP fixtures, transparent/opaque/unknown-alpha results, generate/edit transport, count/format/quality warnings, full runner propagation, concurrent file allocation, cancellation/timeouts and upstream errors. Real gateway verification is kept outside the repository and uses the compiled tool through `runToolUseToMessages`.

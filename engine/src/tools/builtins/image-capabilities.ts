import type { JsonSchema } from "../tool.js";
import { validateJsonSchema } from "../schema.js";

export const IMAGE_MODELS = ["gpt-image-2.5-sunburst", "gpt-image-2.5-flare", "gpt-image-2"] as const;
export type OpenAIImageModel = typeof IMAGE_MODELS[number];
export const DEFAULT_OPENAI_IMAGE_MODEL: OpenAIImageModel = "gpt-image-2.5-sunburst";
export const IMAGE_QUALITIES = ["auto", "low", "medium", "high", "xhigh", "max"] as const;
export const IMAGE_SIZE_RULES = "auto or WIDTHxHEIGHT: both edges multiples of 16, each <=3840, aspect ratio <=3:1, total pixels 655360..8294400";
export const IMAGE_SELECTION_GUIDE = "Prefer the GPT Image 2.5 family. Default to gpt-image-2.5-sunburst with quality=auto for final artwork, precise edits, subject/identity preservation, typography, and demanding layouts. Use gpt-image-2.5-flare when the task explicitly prioritizes speed/interactive iteration. Keep quality=auto unless a controlled tier is appropriate or requested: low for explicitly rough fast drafts, medium for iterative composition previews, high for controlled final production, xhigh for demanding text/layout/detail, max for an explicit maximum-tier request. These are selection heuristics, not guarantees that higher tiers improve every prompt. Respect explicit user tier choices. Cost is not a selection criterion. Use gpt-image-2 only when explicitly requested or necessary for confirmed compatibility; never silently switch models or lower quality. Select size for the intended layout, PNG for lossless art/transparency, JPEG for opaque photos, WebP for web assets. Review warnings and actual output metadata: a compatible gateway may accept but ignore parameters. Quality echo differences are informational: they do not prove an internal downgrade. Distinguish requested settings, upstream-reported settings, and byte-verified properties. Output images report hasAlphaChannel separately from hasTransparentPixels: an alpha channel may be fully opaque; PNG palette/color-key transparency may exist without a separate alpha channel. Missing hasTransparentPixels means unknown, not false.";

export interface ImageWarning {
  code: string;
  field: string;
  message: string;
  requested?: unknown;
  actual?: unknown;
  remedy?: string;
}

const sourceSchema: JsonSchema = {
  type: "object", additionalProperties: false,
  properties: Object.fromEntries(["base64", "data", "dataUrl", "mimeType", "name", "label"].map(key => [key, { type: "string" }])),
};
export const IMAGE_INPUT_SCHEMA: JsonSchema = {
  type: "object", additionalProperties: false, required: ["semanticName", "prompt"],
  properties: {
    mode: { type: "string", enum: ["generate", "edit"], description: "generate (default) creates a new image; edit modifies source images." },
    semanticName: { type: "string", description: "Required meaningful Chinese/English image name used for the label and filename. Do not use generic image, 图片, output, result, gen, or img." },
    prompt: { type: "string", description: "Detailed scene/layout/text requirements. In edit mode specify exactly what must change and what must remain unchanged." },
    model: { type: "string", enum: [...IMAGE_MODELS], description: `Defaults to configured OPENAI_IMAGE_MODEL or ${DEFAULT_OPENAI_IMAGE_MODEL}. ${IMAGE_SELECTION_GUIDE}` },
    quality: { type: "string", enum: [...IMAGE_QUALITIES], description: "2.5: auto, low, medium, high, xhigh, max. Default auto on all models. Explicit legacy gpt-image-2 rejects xhigh/max. Do not lower quality to save money. auto lets the upstream choose and is not guaranteed to mean max." },
    size: { type: "string", description: `${IMAGE_SIZE_RULES}. Defaults to auto. Examples: 1024x1024, 1536x1024, 1024x1536, 2048x2048, 3840x2160, 2160x3840. Gateways may resize: inspect actual dimensions and warnings.` },
    outputFormat: { type: "string", enum: ["png", "jpeg", "webp"], description: "Default png. PNG for lossless artwork/transparent assets; JPEG for opaque photography; WebP for web delivery/transparency. Actual bytes are inspected, not assumed from this request." },
    background: { type: "string", enum: ["auto", "opaque", "transparent"], description: "Default auto. transparent requires png or webp. Also explicitly request an isolated subject and true transparency in prompt. Gateway support is verified from output where possible." },
    moderation: { type: "string", enum: ["auto", "low"], description: "Default auto. low is the upstream less-restrictive moderation preset, not a safety bypass. Acceptance does not prove that a gateway applied this setting." },
    n: { type: "integer", minimum: 1, maximum: 4, description: "Number of requested images, 1..4; default 1. Returned count is verified and mismatches produce warnings." },
    image: { ...sourceSchema, description: "One explicit edit source. Exactly one of base64/data/dataUrl. PNG/JPEG/WebP; raw base64 requires matching mimeType. Maximum 50 MiB per image." },
    images: { type: "array", minItems: 1, maxItems: 16, items: sourceSchema, description: "Explicit edit sources, maximum 16 total including image and imageRefs." },
    imageRefs: { type: "array", minItems: 1, maxItems: 16, items: { type: "string" }, description: "Prior conversation image IDs/labels/numeric refs. Prefer stable image IDs. Unknown/ambiguous references are errors, never silently use a different image." },
    useLatestImage: { type: "boolean", description: "Default true: in edit mode, use latest available conversation image only when no explicit source or refs are given." },
    outputDir: { type: "string", description: "Optional output directory; defaults to session image directory." },
    outputPath: { type: "string", description: "Optional single-image filename hint; final name derives from semanticName and actual image format. n must be 1. If outputDir is also set, outputPath takes precedence with a warning." },
  },
};

export function imageValidationError(model: string, field: string, reason: string): string {
  return `image_create validation failed for model ${model}: ${field} ${reason}.`;
}

export function validImageSize(value: unknown): boolean {
  if (value === "auto") return true;
  if (typeof value !== "string" || !/^\d{3,4}x\d{3,4}$/u.test(value)) return false;
  const [w, h] = value.split("x").map(Number) as [number, number];
  return w > 0 && h > 0 && w <= 3840 && h <= 3840 && w % 16 === 0 && h % 16 === 0
    && Math.max(w, h) / Math.min(w, h) <= 3 && w * h >= 655360 && w * h <= 8294400;
}

/** Validate unknown values before any trim, coercion, network request or file write. */
export function normalizeImageInput(value: unknown, configuredModel?: string): Record<string, unknown> {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const model = typeof record.model === "string" ? record.model.trim() : configuredModel?.trim() || DEFAULT_OPENAI_IMAGE_MODEL;
  const fail = (field: string, reason: string): never => { throw new Error(imageValidationError(model, field, reason)); };
  const clean = value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined)) : value;
  const validation = validateJsonSchema(clean, IMAGE_INPUT_SCHEMA);
  if (!validation.ok) fail("input", validation.message);
  if (!IMAGE_MODELS.includes(model as OpenAIImageModel)) fail("model", `must be one of ${IMAGE_MODELS.join(", ")}; update OPENAI_IMAGE_MODEL if configured incorrectly`);
  const input: Record<string, unknown> = { mode: "generate", size: "auto", quality: "auto", outputFormat: "png", background: "auto", moderation: "auto", n: 1, useLatestImage: true, ...(clean as Record<string, unknown>), model };
  if (typeof input.prompt !== "string" || !input.prompt.trim()) fail("prompt", "must be a non-empty string");
  if ([...(input.prompt as string)].length > 32000) fail("prompt", "must not exceed 32000 characters");
  if (!validImageSize(input.size)) fail("size", `must be ${IMAGE_SIZE_RULES}; received ${JSON.stringify(input.size)}`);
  if (model === "gpt-image-2" && ["max", "xhigh"].includes(String(input.quality))) fail("quality", `${input.quality} is only available for 2.5 models; select gpt-image-2.5-sunburst or use high with gpt-image-2`);
  if (input.background === "transparent" && input.outputFormat === "jpeg") fail("outputFormat", "jpeg cannot store transparency; use png or webp with background=transparent, or request background=opaque");
  if (!Number.isInteger(input.n) || Number(input.n) < 1 || Number(input.n) > 4) fail("n", "must be an integer between 1 and 4");
  if (record.useLatestImage !== undefined && typeof record.useLatestImage !== "boolean") fail("useLatestImage", "must be boolean");
  for (const key of ["outputDir", "outputPath"] as const) {
    const v = record[key];
    if (v !== undefined && (typeof v !== "string" || !v.trim() || /[\u0000-\u001f]/u.test(v))) fail(key, "must be a non-empty path without control characters");
  }
  if (record.outputPath !== undefined && input.n !== 1) fail("outputPath", "requires n=1; use outputDir for multiple images");
  for (const key of ["images", "imageRefs"] as const) {
    const v = record[key];
    if (v !== undefined && (!Array.isArray(v) || v.length < 1 || v.length > 16)) fail(key, "must contain 1..16 entries");
  }
  if (Array.isArray(record.imageRefs) && record.imageRefs.some(ref => typeof ref !== "string" || !ref.trim())) fail("imageRefs", "must contain non-empty strings");
  const count = (record.image ? 1 : 0) + (Array.isArray(record.images) ? record.images.length : 0) + (Array.isArray(record.imageRefs) ? record.imageRefs.length : 0);
  if (count > 16) fail("images", "maximum 16 total source images including image, images and imageRefs");
  return input;
}

export function imageInputWarnings(input: Record<string, unknown>): ImageWarning[] {
  const warnings: ImageWarning[] = [];

  if (input.mode === "generate" && (input.image || input.images || input.imageRefs)) warnings.push({ code: "UNUSED_EDIT_SOURCES", field: "mode", message: "Sources were provided in generate mode and will not be sent. This is a new image, not an edit.", remedy: "Use mode=edit to preserve or modify source images." });
  if (input.outputDir && input.outputPath) warnings.push({ code: "OUTPUT_PATH_PRECEDENCE", field: "outputDir", message: "Both outputDir and outputPath were supplied; outputPath takes precedence." });
  return warnings;
}

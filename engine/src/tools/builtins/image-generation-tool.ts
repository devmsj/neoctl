import { executionFs, executionExistsSync } from "../../execution/filesystem.js";
import { dockerEnabled, executionCwd } from "../../execution/docker.js";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveImageBlockDataSync } from "../../core/image-storage.js";
import { getImageRegistryFromMessages } from "../../core/message-pipeline.js";
import { loadImageData, resolveImageRefResult, type ImageEntry, type ImageRegistry } from "../../core/image-registry.js";
import { getNeoctlHome } from "../../paths.js";
import type { Tool, ToolResult, ToolUseContext } from "../tool.js";
import type { Message } from "../../types/messages.js";
import { DEFAULT_OPENAI_IMAGE_MODEL, IMAGE_EDIT_REFERENCE_GUIDE, IMAGE_INPUT_SCHEMA, IMAGE_SELECTION_GUIDE, normalizeImageInput, imageInputWarnings, imageValidationError, type ImageWarning } from "./image-capabilities.js";
import { decodeImageBase64, inspectImageBytes, outputWarnings, type ImageByteMetadata } from "./image-output-verification.js";
export { DEFAULT_OPENAI_IMAGE_MODEL } from "./image-capabilities.js";
export type { OpenAIImageModel } from "./image-capabilities.js";

export type ImageGenerationSize = "auto" | `${number}x${number}`;
export type ImageGenerationQuality = "auto" | "low" | "medium" | "high" | "xhigh" | "max";
export type ImageGenerationFormat = "png" | "jpeg" | "webp";
export type OpenAIImageGenerationResponseFormat = ImageGenerationFormat | "jpg";
export type ImageGenerationBackground = "auto" | "transparent" | "opaque";
export type ImageGenerationModeration = "auto" | "low";
export type ImageToolMode = "generate" | "edit";

export interface ImageEditInputImage {
  /** Base64 image bytes, either raw or a data URL. */
  base64?: string;
  /** Alias for base64. */
  data?: string;
  /** Full data:image/...;base64,... URL. */
  dataUrl?: string;
  /** Required when base64/data is raw base64. Inferred from dataUrl when omitted. */
  mimeType?: string;
  /** Optional filename sent to the image edit endpoint. */
  name?: string;
  /** Optional UI/history label for diagnostics. */
  label?: string;
}

export interface ImageGenerationToolInput {
  /** generate creates a new image; edit modifies one or more existing images. */
  mode?: ImageToolMode;
  /** Required semantic image name used as the conversation label and default output filename. */
  semanticName: string;
  prompt: string;
  model?: string;
  size?: ImageGenerationSize;
  quality?: ImageGenerationQuality;
  outputFormat?: ImageGenerationFormat;
  background?: ImageGenerationBackground;
  moderation?: ImageGenerationModeration;
  n?: number;
  /** Single explicit source image for mode=edit. */
  image?: ImageEditInputImage;
  /** Multiple explicit source images for mode=edit. */
  images?: ImageEditInputImage[];
  /** Labels of prior conversation image blocks to edit. */
  imageRefs?: string[];
  /** In edit mode, use the latest prior conversation image when no image/imageRefs are provided. Defaults to true. */
  useLatestImage?: boolean;
  /** Directory where generated image files should be saved. Defaults to a session/agent image directory. */
  outputDir?: string;
  /** Single-image path hint; semanticName and verified format determine the filename. Requires n=1. */
  outputPath?: string;
}

export interface ImageGenerationResult extends ImageByteMetadata {
  index: number;
  base64: string;
  dataUrl: string;
  revisedPrompt?: string;
  /** Stable conversation label, e.g. gen#1. */
  label?: string;
  /** Absolute path to the saved binary image file, if persisted. */
  path?: string;
  /** Absolute path to the saved base64 payload used by load_image history reloads. */
  storagePath?: string;
}

export interface ImageGenerationToolTiming {
  /** Unix epoch milliseconds captured immediately before the OpenAI image request starts. */
  startedAt: number;
  /** ISO-8601 timestamp captured from startedAt for UI display. */
  startedAtIso: string;
  /** Unix epoch milliseconds captured when the tool finishes or fails. */
  finishedAt: number;
  /** ISO-8601 timestamp captured from finishedAt for UI display. */
  finishedAtIso: string;
  /** Total elapsed time in milliseconds. */
  duration: number;
  /** Alias of duration for consumers that expect elapsed milliseconds. */
  elapsed: number;
  /** Explicit millisecond aliases for consumers that prefer unit-suffixed names. */
  durationMs: number;
  elapsedMs: number;
}

export interface ImageGenerationToolOutput extends ImageGenerationToolTiming {
  provider: "openai";
  mode: ImageToolMode;
  model: string;
  prompt: string;
  semanticName: string;
  size: ImageGenerationSize;
  quality: ImageGenerationQuality;
  outputFormat: ImageGenerationFormat;
  background: ImageGenerationBackground;
  returnedImages: number;
  sourceImages?: number;
  imageRefs?: string[];
  images: ImageGenerationResult[];
  /** Explicit request, never confused with actual image properties. */
  requested: Record<string, unknown>;
  /** Upstream report, not independent proof of model/compute. */
  actual: Record<string, unknown>;
  warnings: ImageWarning[];
  raw?: unknown;
}

export interface CreateOpenAIImageGenerationToolOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
}

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com";
const DEFAULT_IMAGE_MODEL = DEFAULT_OPENAI_IMAGE_MODEL;
export const DEFAULT_IMAGE_TIMEOUT_MS = 360_000;

/**
 * OpenAI-only image generation tool backed by the Images API.
 *
 * The tool is intentionally exposed only when MODEL_PROVIDER=openai. Other providers
 * should not receive a drawable tool definition; the default system prompt tells the
 * model that image generation is unavailable in that configuration.
 */
export function createOpenAIImageGenerationTool(options: CreateOpenAIImageGenerationToolOptions = {}): Tool<ImageGenerationToolInput> {
  const normalize = (value: unknown): ImageGenerationToolInput => {
    const input = normalizeImageInput(value, options.model?.trim() || process.env.OPENAI_IMAGE_MODEL?.trim()) as unknown as ImageGenerationToolInput;
    const slug = semanticNameSlug(input.semanticName);
    if (!slug) throw new Error(imageValidationError(input.model!, "semanticName", "must be a meaningful non-generic Chinese or English name"));
    for (const [index, source] of [input.image, ...(input.images ?? [])].filter((v): v is ImageEditInputImage => v !== undefined).entries()) {
      try { resolveInputImage(source, index); }
      catch (error) { throw new Error(imageValidationError(input.model!, `images[${index}]`, error instanceof Error ? error.message : String(error))); }
    }
    return { ...input, semanticName: slug };
  };
  return {
    name: "image_create",
    description: `Generate or edit images with OpenAI's Images API. Stable tool name: image_create. ${IMAGE_SELECTION_GUIDE} Use mode=generate for new images; mode=edit for changes to attached/prior images. ${IMAGE_EDIT_REFERENCE_GUIDE} Valid but imperfect results succeed with structured warnings; invalid inputs fail with model, field, and correction guidance. Available only when MODEL_PROVIDER=openai.`,
    inputSchema: { ...IMAGE_INPUT_SCHEMA, properties: { ...IMAGE_INPUT_SCHEMA.properties, model: { ...IMAGE_INPUT_SCHEMA.properties!.model, default: options.model?.trim() || process.env.OPENAI_IMAGE_MODEL?.trim() || DEFAULT_IMAGE_MODEL } } },
    metadata: {
      readOnly: false,
      concurrent: true,
      visible: true,
      maxResultSizeChars: 24000,
    },
    validate(input) {
      // Full model-aware validation belongs in validateInput so callers get a structured failure.
      return input as ImageGenerationToolInput;
    },
    validateInput(input, context) {
      try {
        const normalized = normalize(input);
        if (normalized.mode === "edit") validateEditSources(normalized, context.messages);
        return { ok: true, value: normalized };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
    isConcurrencySafe() {
      return true;
    },
    async call(input, context, callOptions): Promise<ToolResult> {
      try { input = normalize(input); }
      catch (error) { return { ok: false, output: { provider: "openai", error: error instanceof Error ? error.message : String(error) } }; }
      const warnings = imageInputWarnings(input as unknown as Record<string, unknown>);
      const apiKey = resolveApiKey(options.apiKey);
      if (!apiKey) {
        return {
          ok: false,
          output: {
            provider: "openai",
            error: "OpenAI image generation requires OPENAI_IMAGE_API_KEY or OPENAI_API_KEY.",
          },
        };
      }

      const model = input.model?.trim() || DEFAULT_IMAGE_MODEL;
      const timeoutMs = options.timeoutMs ?? parsePositiveNumber(process.env.OPENAI_IMAGE_TIMEOUT_MS) ?? parsePositiveNumber(process.env.MODEL_TIMEOUT_MS) ?? DEFAULT_IMAGE_TIMEOUT_MS;

      const mode = input.mode ?? "generate";
      callOptions.onProgress?.({ toolName: "image_create", message: `${mode === "edit" ? "Editing" : "Generating"} image with OpenAI ${model}` });
      const startedAt = Date.now();
      try {
        const baseUrl = normalizeImageBaseUrl(options.baseUrl?.trim() || process.env.OPENAI_IMAGE_BASE_URL?.trim() || process.env.OPENAI_BASE_URL?.trim() || DEFAULT_OPENAI_BASE_URL);
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new Error("Image timeoutMs must be positive and <=2147483647");
        if (context.abortSignal?.aborted) throw new Error("Image request aborted before execution");
        const editSources = mode === "edit" ? validateEditSources(input, context.messages) : [];
        if (mode === "edit" && editSources.length === 0) {
          throw new Error("image_create mode=edit requires a source image. Provide image/images/imageRefs, attach an image, or keep useLatestImage enabled with a prior image in the conversation.");
        }
        const response = mode === "edit"
          ? await callOpenAIImageEdit({
            apiKey,
            baseUrl,
            timeoutMs,
            signal: context.abortSignal,
            input: { ...input, model },
            images: editSources,
          })
          : await callOpenAIImageGeneration({
            apiKey,
            baseUrl,
            timeoutMs,
            signal: context.abortSignal,
            input: { ...input, model },
          });
        const extracted = extractGeneratedImages(response, warnings);
        if (!extracted.length) throw new Error(`OpenAI returned no usable image data. ${openAIErrorMessage(response) ?? "Expected data[].b64_json containing PNG/JPEG/WebP."}`);
        warnings.push(...outputWarnings(input as unknown as Record<string, unknown>, response, extracted));
        if (input.outputPath && path.extname(input.outputPath).toLowerCase() && path.extname(input.outputPath).toLowerCase() !== `.${extensionForMimeType(extracted[0]!.mimeType)}`) {
          warnings.push({ code: "OUTPUT_EXTENSION_CORRECTED", field: "outputPath", message: "The filename extension follows actual image bytes, not the filename hint." });
        }
        const images = await persistGeneratedImages(extracted, input, context);
        const timing = imageGenerationTiming(startedAt);
        const output: ImageGenerationToolOutput = {
          ...timing,
          provider: "openai",
          mode,
          model,
          prompt: input.prompt,
          semanticName: input.semanticName,
          size: input.size ?? "auto",
          quality: input.quality ?? "auto",
          outputFormat: input.outputFormat ?? "png",
          background: input.background ?? "auto",
          returnedImages: images.length,
          sourceImages: mode === "edit" ? editSources.length : undefined,
          imageRefs: mode === "edit" ? editSources.map((source) => formatSourceImageRef(source)).filter((label): label is string => Boolean(label)) : undefined,
          images,
          requested: buildOpenAIImageRequestBody({ ...input, model }),
          actual: { model: stringFrom(response.model) ?? null, quality: stringFrom(response.quality) ?? null, background: stringFrom(response.background) ?? null, returnedImages: images.length, images: images.map(({ width, height, mimeType, hasAlphaChannel, hasTransparentPixels }) => ({ width, height, mimeType, hasAlphaChannel, hasTransparentPixels })) },
          warnings,
          raw: compactRawResponse(response),
        };
        return {
          ok: images.length > 0,
          output,
          summary: images.length ? `${images.length} image(s) ${mode === "edit" ? "edited" : "generated"} in ${timing.duration}ms` : `OpenAI returned no image data after ${timing.duration}ms`,
        };
      } catch (error) {
        const output = {
          ...imageGenerationTiming(startedAt),
          provider: "openai",
          mode,
          model,
          prompt: input.prompt,
          warnings,
          requested: buildOpenAIImageRequestBody({ ...input, model }),
          error: (error instanceof Error ? error.message : String(error)).split(apiKey).join("[REDACTED]"),
        };
        return {
          ok: false,
          output,
        };
      }
    },
    mapResult(result) {
      return compactImageGenerationOutput(result.output);
    },
    renderToolResultMessage(result, request) {
      return createImageGenerationToolResultMessage(result, request?.id ?? "");
    },
  };
}

export const openAIImageGenerationTool = createOpenAIImageGenerationTool();

interface OpenAIImageGenerationRequestOptions {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  signal?: AbortSignal;
  input: ImageGenerationToolInput & { model: string };
}

interface ResolvedEditImage {
  index: number;
  imageId?: string;
  base64: string;
  mimeType: string;
  filename: string;
  label?: string;
  storagePath?: string;
  sourceMessageId?: string;
  sourceBlockIndex?: number;
}

interface OpenAIImageEditRequestOptions extends OpenAIImageGenerationRequestOptions {
  images: ResolvedEditImage[];
}

async function callOpenAIImageGeneration(options: OpenAIImageGenerationRequestOptions): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  const timeout = setTimeout(() => controller.abort(new Error(`Image generation request timed out after ${options.timeoutMs}ms`)), options.timeoutMs);
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });

  try {
    const response = await fetch(`${options.baseUrl}/images/generations`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify(buildOpenAIImageRequestBody(options.input)),
      signal: controller.signal,
    });

    const text = await response.text();
    const body = text ? parseJsonObject(text) : {};
    if (!response.ok || body.error) {
      throw new Error(`OpenAI image generation HTTP ${response.status}: ${openAIErrorMessage(body) ?? text.slice(0, 1000)}`);
    }
    return body;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}

async function callOpenAIImageEdit(options: OpenAIImageEditRequestOptions): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  const timeout = setTimeout(() => controller.abort(new Error(`Image edit request timed out after ${options.timeoutMs}ms`)), options.timeoutMs);
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });

  try {
    const form = new FormData();
    for (const image of options.images) {
      form.append("image[]", base64ToBlob(image.base64, image.mimeType), image.filename);
    }
    for (const [key, value] of Object.entries(buildOpenAIImageRequestBody(options.input))) {
      if (value !== undefined) form.append(key, String(value));
    }

    const response = await fetch(`${options.baseUrl}/images/edits`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${options.apiKey}`,
      },
      body: form,
      signal: controller.signal,
    });

    const text = await response.text();
    const body = text ? parseJsonObject(text) : {};
    if (!response.ok || body.error) {
      throw new Error(`OpenAI image edit HTTP ${response.status}: ${openAIErrorMessage(body) ?? text.slice(0, 1000)}`);
    }
    return body;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}

function buildOpenAIImageRequestBody(input: ImageGenerationToolInput & { model: string }): Record<string, unknown> {
  return dropUndefined({
    model: input.model,
    prompt: input.prompt,
    n: input.n ?? 1,
    size: input.size ?? "auto",
    quality: input.quality ?? "auto",
    output_format: input.outputFormat ?? "png",
    background: input.background ?? "auto",
    moderation: input.moderation ?? "auto",
  });
}

function imageGenerationTiming(startedAt: number, finishedAt = Date.now()): ImageGenerationToolTiming {
  const duration = Math.max(0, finishedAt - startedAt);
  return {
    startedAt,
    startedAtIso: new Date(startedAt).toISOString(),
    finishedAt,
    finishedAtIso: new Date(finishedAt).toISOString(),
    duration,
    elapsed: duration,
    durationMs: duration,
    elapsedMs: duration,
  };
}

function validateEditSources(input: ImageGenerationToolInput, messages: readonly Message[] | undefined): ResolvedEditImage[] {
  try {
    const sources = resolveImageEditSources(input, messages);
    if (!sources.length) throw new Error("requires a source image; provide image/images/imageRefs or a prior conversation image with useLatestImage=true");
    if (sources.length > 16) throw new Error("maximum 16 edit sources");
    for (const [index, source] of sources.entries()) {
      const meta = inspectImageBytes(decodeImageBase64(source.base64));
      if (meta.mimeType !== source.mimeType) throw new Error(`source ${index + 1} MIME does not match image bytes (${meta.mimeType})`);
    }
    return sources;
  } catch (error) { throw new Error(imageValidationError(input.model!, "edit sources", error instanceof Error ? error.message : String(error))); }
}

function resolveImageEditSources(input: ImageGenerationToolInput, messages: readonly Message[] | undefined): ResolvedEditImage[] {
  const explicit = [input.image, ...(input.images ?? [])].filter((image): image is ImageEditInputImage => !!image);
  const fromInput = explicit.map((image, index) => resolveInputImage(image, index));
  const fromRefs = resolveReferencedImages(messages, input.imageRefs ?? []);
  const shouldUseLatest = input.useLatestImage !== false && fromInput.length === 0 && fromRefs.length === 0 && (!input.imageRefs || input.imageRefs.length === 0);
  const latest = shouldUseLatest ? latestConversationImage(messages) : undefined;
  return [...fromInput, ...fromRefs, ...(latest ? [latest] : [])];
}

function resolveInputImage(image: ImageEditInputImage, index: number): ResolvedEditImage {
  if ([image.dataUrl, image.base64, image.data].filter(v => v !== undefined).length !== 1) throw new Error("provide exactly one of base64, data, or dataUrl");
  if (image.dataUrl !== undefined && !/^data:image\/(?:png|jpeg|webp);base64,/u.test(image.dataUrl)) throw new Error("dataUrl must be a PNG/JPEG/WebP base64 data URL");
  const parsed = parseImageData(image.dataUrl ?? image.base64 ?? image.data);
  const mimeType = image.mimeType?.trim() || parsed.mimeType;
  if (!parsed.base64) throw new Error(`image_create edit source image ${index + 1} is missing base64/data/dataUrl`);
  if (!mimeType) throw new Error(`image_create edit source image ${index + 1} is missing mimeType`);
  const bytes = decodeImageBase64(parsed.base64);
  const actual = inspectImageBytes(bytes);
  if (mimeType !== actual.mimeType || (parsed.mimeType && parsed.mimeType !== actual.mimeType)) throw new Error(`mimeType must match actual bytes (${actual.mimeType})`);
  return {
    index,
    base64: bytes.toString("base64"),
    mimeType,
    filename: image.name?.trim() || imageFilename(mimeType, index),
    label: image.label,
  };
}

function resolveReferencedImages(messages: readonly Message[] | undefined, refs: readonly string[]): ResolvedEditImage[] {
  if (refs.length === 0) return [];
  const imageBlocks = collectConversationImages(messages);
  const registry = getImageRegistryFromMessages(messages ?? []);
  return refs.map((ref, index) => {
    const found = findReferencedImage(imageBlocks, registry, ref);
    if (!found) throw new Error(`image_create could not find referenced image: ${ref}. Available imageRefs: ${formatAvailableImageRefs(registry)}`);
    return { ...found, filename: found.filename || imageFilename(found.mimeType, index) };
  });
}

function findReferencedImage(images: readonly ResolvedEditImage[], registry: ImageRegistry, ref: string): ResolvedEditImage | undefined {
  const registryResolution = resolveImageRefResult(registry, ref);
  if (registryResolution.status === "ambiguous") throw new Error(`image_create image reference is ambiguous: ${ref}. Use a registry ID such as img_1.`);
  if (registryResolution.status === "resolved") {
    return findCollectedImage(images, registryResolution.entry) ?? resolvedRegistryImage(registryResolution.entry);
  }

  const rawRef = ref.trim().toLowerCase();
  const exactIdentity = images.filter((image) => image.imageId?.toLowerCase() === rawRef);
  if (exactIdentity.length === 1) return exactIdentity[0];
  if (exactIdentity.length > 1) throw new Error(`image_create image reference is ambiguous: ${ref}`);

  const normalizedRef = canonicalizeImageRef(ref);
  if (!normalizedRef) return undefined;
  const labelMatches = images.filter((image) => canonicalizeImageRef(image.label ?? "") === normalizedRef || canonicalizeImageRef(image.filename) === normalizedRef);
  if (labelMatches.length === 1) return labelMatches[0];
  if (labelMatches.length > 1) throw new Error(`image_create image reference is ambiguous: ${ref}. Use a registry ID such as img_1.`);

  const numericRef = parseImageRefNumber(normalizedRef);
  if (numericRef !== undefined) return images[numericRef - 1];
  return undefined;
}

function findCollectedImage(images: readonly ResolvedEditImage[], entry: ImageEntry): ResolvedEditImage | undefined {
  if (entry.imageId) return images.find((image) => image.imageId === entry.imageId);
  return images.find((image) => image.sourceMessageId === entry.sourceMessageId && image.sourceBlockIndex === entry.sourceBlockIndex);
}

function resolvedRegistryImage(entry: ImageEntry): ResolvedEditImage | undefined {
  const storedData = loadImageData(entry);
  const parsed = parseImageData(storedData);
  if (!parsed.base64) return undefined;
  return {
    index: entry.sourceBlockIndex ?? 0,
    imageId: entry.imageId,
    base64: normalizeBase64ImageData(parsed.base64),
    mimeType: entry.mimeType || parsed.mimeType || "image/png",
    filename: imageFilename(entry.mimeType || parsed.mimeType || "image/png", entry.sourceBlockIndex ?? 0),
    label: entry.label,
    storagePath: entry.storagePath,
    sourceMessageId: entry.sourceMessageId,
    sourceBlockIndex: entry.sourceBlockIndex,
  };
}

function formatSourceImageRef(image: ResolvedEditImage): string {
  return image.imageId || image.label?.trim() || image.filename || String(image.index + 1);
}

function formatAvailableImageRefs(registry: ImageRegistry): string {
  const refs = registry.images.map((entry) => entry.id).slice(-10);
  return refs.length > 0 ? refs.join(", ") : "none";
}

function latestConversationImage(messages: readonly Message[] | undefined): ResolvedEditImage | undefined {
  const images = collectConversationImages(messages);
  return images[images.length - 1];
}

function collectConversationImages(messages: readonly Message[] | undefined): ResolvedEditImage[] {
  if (!messages) return [];
  const images: ResolvedEditImage[] = [];
  for (const message of messages) {
    for (const [sourceBlockIndex, block] of message.blocks.entries()) {
      if (block.type !== "image") continue;
      const resolvedData = resolveImageBlockDataSync(block);
      const parsed = parseImageData(resolvedData);
      const mimeType = block.mimeType || parsed.mimeType;
      const base64 = parsed.base64;
      if (!base64 || !mimeType) continue;
      images.push({
        index: images.length,
        imageId: block.imageId,
        base64: normalizeBase64ImageData(base64),
        mimeType,
        filename: imageFilename(mimeType, images.length),
        label: block.label,
        storagePath: block.storage?.path,
        sourceMessageId: message.id,
        sourceBlockIndex,
      });
    }
  }
  return images;
}

function parseImageData(value: string | undefined): { base64?: string; mimeType?: string } {
  if (!value) return {};
  const match = /^data:([^;,]+);base64,(.*)$/su.exec(value.trim());
  if (match) return { mimeType: match[1], base64: match[2] };
  return { base64: value };
}


function normalizeBase64ImageData(value: string): string {
  return value.replace(/^data:[^;,]+;base64,/su, "").replace(/\s+/gu, "");
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  return new Blob([Buffer.from(normalizeBase64ImageData(base64), "base64")], { type: mimeType });
}

function imageFilename(mimeType: string, index: number): string {
  const subtype = mimeType.split("/")[1]?.split(";")[0]?.trim() || "png";
  const extension = subtype === "jpeg" ? "jpg" : subtype.replace(/[^a-z0-9]/giu, "") || "png";
  return `image-${index + 1}.${extension}`;
}

function normalizeImageRef(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[。.!?]+$/gu, "")
    .replace(/\s+/gu, " ");
}

function parseImageRefNumber(normalizedRef: string): number | undefined {
  const match = /^(?:\[?(?:img|gen)#?|image(?:\s+|-)?)?(\d+)\]?$/iu.exec(normalizedRef);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function canonicalizeImageRef(value: string): string {
  const normalized = normalizeImageRef(value).replace(/[。？！?!]+$/gu, "");
  if (!normalized || /[./\\]/u.test(normalized)) return normalized;

  const numericRef = parseImageRefNumber(normalized);
  return numericRef !== undefined ? `[img#${numericRef}]` : normalized;
}

function stripFileExtension(filename: string): string {
  return filename.replace(/\.[^.]+$/u, "");
}

async function persistGeneratedImages(
  images: ImageGenerationResult[],
  input: ImageGenerationToolInput,
  context: ToolUseContext,
): Promise<ImageGenerationResult[]> {
  if (images.length === 0) return images;

  const outputFs = dockerEnabled() ? executionFs : fs;
  const outputDir = resolveGeneratedImageOutputDir(input, context);
  await outputFs.mkdir(outputDir, { recursive: true });
  const allocatedLabels = new Set<string>();

  return Promise.all(images.map(async (image, offset) => {
    const extension = extensionForMimeType(image.mimeType);
    const requestedBase = images.length === 1 ? input.semanticName : `${input.semanticName}-${offset + 1}`;
    const label = uniqueGeneratedImageLabel(requestedBase, context.messages, allocatedLabels);
    let binaryPath = path.resolve(
      input.outputPath && images.length === 1
        ? uniqueOutputPath(dockerEnabled() ? path.posix.resolve(executionCwd(context.appState.snapshot().cwd), input.outputPath) : input.outputPath, label, extension)
        : uniqueOutputPath(path.join(outputDir, `${sanitizeFilename(label)}.${extension}`), label, extension),
    );
    await outputFs.mkdir(path.dirname(binaryPath), { recursive: true });
    // Exclusive creation also prevents collisions between concurrently running tool calls.
    for (;;) {
      try {
        await outputFs.writeFile(binaryPath, Buffer.from(normalizeBase64ImageData(image.base64), "base64"), { flag: "wx" });
        break;
      } catch (error) {
        if (!isRecord(error) || error.code !== "EEXIST") throw error;
        binaryPath = uniqueOutputPath(binaryPath, label, extension);
      }
    }

    const storagePath = dockerEnabled()
      ? path.join(context.session?.sessionDir || getNeoctlHome(), "generated", "images", `${randomUUID()}.base64.txt`)
      : `${binaryPath}.base64.txt`;
    if (dockerEnabled()) await fs.mkdir(path.dirname(storagePath), { recursive: true });
    await fs.writeFile(storagePath, normalizeBase64ImageData(image.base64), "utf8");

    return {
      ...image,
      label,
      path: binaryPath,
      storagePath,
    };
  }));
}

function resolveGeneratedImageOutputDir(input: ImageGenerationToolInput, context: ToolUseContext): string {
  if (dockerEnabled()) {
    const cwd = executionCwd(context.appState.snapshot().cwd);
    return input.outputPath?.trim() ? path.posix.dirname(path.posix.resolve(cwd, input.outputPath)) : input.outputDir?.trim() ? path.posix.resolve(cwd, input.outputDir) : path.posix.join(cwd, "generated", "images");
  }
  if (input.outputPath?.trim()) return path.dirname(path.resolve(input.outputPath.trim()));
  if (input.outputDir?.trim()) return path.resolve(input.outputDir.trim());
  if (context.session?.sessionDir) return path.join(context.session.sessionDir, "generated", "images");
  return path.join(getNeoctlHome(), "generated", context.agentId || "main", "images");
}

function uniqueGeneratedImageLabel(baseName: string, messages: readonly Message[] | undefined, allocated: Set<string>): string {
  const base = semanticNameSlug(baseName) || "generated-image";
  const existing = collectExistingImageLabels(messages);
  let candidate = base;
  let suffix = 2;
  while (existing.has(candidate.toLowerCase()) || allocated.has(candidate.toLowerCase())) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  allocated.add(candidate.toLowerCase());
  return candidate;
}

function collectExistingImageLabels(messages: readonly Message[] | undefined): Set<string> {
  const labels = new Set<string>();
  for (const message of messages ?? []) {
    for (const block of message.blocks) {
      if (block.type !== "image") continue;
      if (block.label?.trim()) labels.add(block.label.trim().toLowerCase());
    }
  }
  return labels;
}

function uniqueOutputPath(requestedPath: string, label: string, extension: string): string {
  const resolved = path.resolve(requestedPath.trim());
  const directory = path.dirname(resolved);
  const ext = `.${extension}`;
  const base = sanitizeFilename(label);
  let candidate = path.join(directory, `${base}${ext}`);
  let suffix = 2;
  const exists = dockerEnabled() ? executionExistsSync : existsSync;
  while (exists(candidate) || exists(`${candidate}.base64.txt`)) {
    candidate = path.join(directory, `${base}-${suffix}${ext}`);
    suffix += 1;
  }
  return candidate;
}

function extensionForMimeType(mimeType: string): string {
  const subtype = mimeType.split("/")[1]?.split(";")[0]?.trim().toLowerCase() || "png";
  if (subtype === "jpeg") return "jpg";
  return subtype.replace(/[^a-z0-9]/giu, "") || "png";
}

function sanitizeFilename(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_")
    .replace(/[. ]+$/gu, "")
    .slice(0, 120) || "image";
}

function semanticNameSlug(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "";
  const normalized = trimmed
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .replace(/-{2,}/gu, "-");
  const slug = [...normalized].slice(0, 80).join("");
  if (!slug || isGenericImageName(slug) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(slug)) return "";
  return slug;
}

function isGenericImageName(value: string): boolean {
  return /^(?:(?:image|img|picture|photo|output|result|generated|generation|gen|edit|edited|final|new|untitled|file|pic)(?:-?\d+)?|(?:图片|图像|照片|输出|结果|生成图|最终图)\d*)$/iu.test(value);
}

function createImageGenerationToolResultMessage(result: ToolResult, toolUseId: string): Message | undefined {
  const output = result.output;
  const blocks: Message["blocks"] = [{
    type: "tool_result",
    toolUseId,
    name: "image_create",
    ok: result.ok,
    output: compactImageGenerationOutput(output),
  }];

  if (result.ok && isImageGenerationToolOutput(output)) {
    for (const image of output.images) {
      blocks.push({
        type: "image",
        mimeType: image.mimeType,
        data: image.storagePath ? "" : image.base64,
        label: image.label ?? `gen#${image.index + 1}`,
        storage: image.storagePath ? { path: image.storagePath, format: "base64" } : undefined,
      });
    }
  }

  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    role: "tool_result",
    createdAt: new Date().toISOString(),
    blocks,
    metadata: result.ok ? { generatedImages: true, tool: "image_create" } : undefined,
  };
}

function compactImageGenerationOutput(output: unknown): unknown {
  if (!isImageGenerationToolOutput(output)) return output;
  return {
    ...output,
    images: output.images.map((image) => ({
      ...image,
      base64: `[base64 image omitted from model context; image ${image.index}, ${image.mimeType}]`,
      dataUrl: `[data URL omitted from model context; image ${image.index}, ${image.mimeType}]`,
    })),
  };
}

function isImageGenerationToolOutput(value: unknown): value is ImageGenerationToolOutput {
  return isRecord(value) && value.provider === "openai" && Array.isArray(value.images);
}

function extractGeneratedImages(response: Record<string, unknown>, warnings: ImageWarning[]): ImageGenerationResult[] {
  const data = Array.isArray(response.data) ? response.data : [];
  return data.flatMap((item, index): ImageGenerationResult[] => {
    try {
      if (!isRecord(item)) throw new Error("Expected an image object");
      const encoded = stringFrom(item.b64_json ?? item.image_base64 ?? item.base64_json ?? item.base64);
      if (!encoded) throw new Error("Missing base64 payload; URL-only responses are not supported");
      const bytes = decodeImageBase64(encoded);
      const metadata = inspectImageBytes(bytes);
      const base64 = bytes.toString("base64");
      return [{ index, ...metadata, base64, dataUrl: `data:${metadata.mimeType};base64,${base64}`, revisedPrompt: stringFrom(item.revised_prompt) }];
    } catch (error) {
      warnings.push({ code: "INVALID_OUTPUT_IMAGE", field: `data[${index}]`, message: error instanceof Error ? error.message : String(error) });
      return [];
    }
  });
}

function resolveApiKey(configured?: string): string | undefined {
  return configured?.trim() || process.env.OPENAI_IMAGE_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim() || undefined;
}

export function normalizeImageBaseUrl(value: string): string {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Image base URL must be an HTTP(S) base URL without credentials, query, or fragment");
  const base = value.replace(/\/+$/, "");
  return base.endsWith("/v1") ? base : `${base}/v1`;
}

function parsePositiveNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text);
    return isRecord(value) ? value : { value };
  } catch {
    return { text };
  }
}

function openAIErrorMessage(body: Record<string, unknown>): string | undefined {
  const error = isRecord(body.error) ? body.error : undefined;
  return stringFrom(error?.message);
}

function compactRawResponse(response: Record<string, unknown>): unknown {
  const data = Array.isArray(response.data) ? response.data : undefined;
  return {
    ...response,
    data: data?.map((item) => {
      if (!isRecord(item)) return item;
      return {
        ...item,
        b64_json: item.b64_json ? "[base64 image omitted]" : undefined,
        image_base64: item.image_base64 ? "[base64 image omitted]" : undefined,
        base64_json: item.base64_json ? "[base64 image omitted]" : undefined,
        base64: item.base64 ? "[base64 image omitted]" : undefined,
      };
    }),
  };
}

function dropUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function stringFrom(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

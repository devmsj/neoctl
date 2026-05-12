import { readFileSync } from "node:fs";
import type { Tool, ToolResult } from "../tool.js";
import type { Message } from "../../types/messages.js";

export type ImageGenerationSize = "auto" | "1024x1024" | "1536x1024" | "1024x1536";
export type ImageGenerationQuality = "auto" | "low" | "medium" | "high";
export type ImageGenerationFormat = "png" | "jpeg" | "webp";
export type OpenAIImageGenerationResponseFormat = ImageGenerationFormat | "jpg";
export type ImageGenerationBackground = "auto" | "transparent" | "opaque";
export type ImageGenerationModeration = "auto" | "low";
export type OpenAIImageModel = "gpt-image-1";
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
}

export interface ImageGenerationResult {
  index: number;
  mimeType: string;
  base64: string;
  dataUrl: string;
  revisedPrompt?: string;
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
  size: ImageGenerationSize;
  quality: ImageGenerationQuality;
  outputFormat: ImageGenerationFormat;
  background: ImageGenerationBackground;
  returnedImages: number;
  sourceImages?: number;
  imageRefs?: string[];
  images: ImageGenerationResult[];
  raw?: unknown;
}

export interface CreateOpenAIImageGenerationToolOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
}

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com";
export const DEFAULT_OPENAI_IMAGE_MODEL: OpenAIImageModel = "gpt-image-1";
const DEFAULT_IMAGE_MODEL = DEFAULT_OPENAI_IMAGE_MODEL;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_IMAGES = 4;
const SUPPORTED_IMAGE_MODELS: readonly OpenAIImageModel[] = [DEFAULT_OPENAI_IMAGE_MODEL];
const SUPPORTED_MODEL_LIST = SUPPORTED_IMAGE_MODELS.join(", ");

/**
 * OpenAI-only image generation tool backed by the Images API.
 *
 * The tool is intentionally exposed only when MODEL_PROVIDER=openai. Other providers
 * should not receive a drawable tool definition; the default system prompt tells the
 * model that image generation is unavailable in that configuration.
 */
export function createOpenAIImageGenerationTool(options: CreateOpenAIImageGenerationToolOptions = {}): Tool<ImageGenerationToolInput> {
  return {
    name: "image2",
    description: `Generate or edit images with OpenAI's Images API. Stable tool name: image2. Defaults to model ${DEFAULT_IMAGE_MODEL}. Use mode=generate for new images and mode=edit to modify existing images. Edit mode accepts explicit image/image(s), imageRefs for prior conversation images, or falls back to the latest prior image. Return generated/edited image data URLs in the tool result for the UI to display. This tool is available only when MODEL_PROVIDER=openai; with other providers, state that this model does not have a drawing/editing tool.`,
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["generate", "edit"], description: "Operation mode. generate creates a new image; edit modifies existing image(s). Defaults to generate." },
        prompt: { type: "string", description: "Detailed image prompt/instruction. For edit mode, describe exactly how to modify the source image(s)." },
        model: { type: "string", enum: [...SUPPORTED_IMAGE_MODELS], description: `Optional OpenAI Images API model. Defaults to OPENAI_IMAGE_MODEL or ${DEFAULT_IMAGE_MODEL}. Supported by this tool: ${SUPPORTED_MODEL_LIST}.` },
        size: { type: "string", enum: ["auto", "1024x1024", "1536x1024", "1024x1536"], description: `${DEFAULT_IMAGE_MODEL} output image size. Supported values: auto, 1024x1024, 1536x1024, 1024x1536. Defaults to auto.` },
        quality: { type: "string", enum: ["auto", "low", "medium", "high"], description: `${DEFAULT_IMAGE_MODEL} rendering quality. Supported values: auto, low, medium, high. Defaults to auto.` },
        outputFormat: { type: "string", enum: ["png", "jpeg", "webp"], description: `${DEFAULT_IMAGE_MODEL} returned image format. Supported values: png, jpeg, webp. Defaults to png.` },
        background: { type: "string", enum: ["auto", "transparent", "opaque"], description: `${DEFAULT_IMAGE_MODEL} background handling. Supported values: auto, transparent, opaque. Defaults to auto.` },
        moderation: { type: "string", enum: ["auto", "low"], description: `${DEFAULT_IMAGE_MODEL} moderation setting. Supported values: auto, low. Defaults to auto.` },
        n: { type: "integer", description: `${DEFAULT_IMAGE_MODEL} number of output images, 1-${MAX_IMAGES}. Defaults to 1.` },
        image: { type: "object", description: "Single source image for mode=edit. Provide base64/data/dataUrl plus mimeType when not using a dataUrl.", additionalProperties: true },
        images: { type: "array", description: "Multiple source images for mode=edit.", items: { type: "object", additionalProperties: true } },
        imageRefs: { type: "array", description: "Labels of prior conversation image blocks to edit, e.g. Generated image 1 or [img#1].", items: { type: "string" } },
        useLatestImage: { type: "boolean", description: "In edit mode, use the latest prior conversation image when no explicit source image or imageRefs are provided. Defaults to true." },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    metadata: {
      readOnly: false,
      concurrent: true,
      visible: true,
      maxResultSizeChars: 24000,
    },
    validate(input) {
      const record = input as Partial<ImageGenerationToolInput>;
      return {
        mode: record.mode ?? "generate",
        prompt: record.prompt ?? "",
        model: record.model,
        size: record.size ?? "auto",
        quality: record.quality ?? "auto",
        outputFormat: record.outputFormat ?? "png",
        background: record.background ?? "auto",
        moderation: record.moderation ?? "auto",
        n: record.n ?? 1,
        image: record.image,
        images: record.images,
        imageRefs: record.imageRefs,
        useLatestImage: record.useLatestImage ?? true,
      };
    },
    validateInput(input) {
      const model = input.model?.trim() || options.model?.trim() || process.env.OPENAI_IMAGE_MODEL?.trim() || DEFAULT_IMAGE_MODEL;
      if (!isImageToolMode(input.mode)) return { ok: false, message: image2ValidationError(model, "mode", "must be generate or edit") };
      if (!input.prompt.trim()) return { ok: false, message: image2ValidationError(model, "prompt", "cannot be empty") };
      if (!isSupportedImageModel(model)) return { ok: false, message: image2ValidationError(model, "model", `is not supported by image2. Supported OpenAI Images API models: ${SUPPORTED_MODEL_LIST}`) };
      if (!isImageSize(input.size)) return { ok: false, message: image2ValidationError(model, "size", "must be auto, 1024x1024, 1536x1024, or 1024x1536") };
      if (!isImageQuality(input.quality)) return { ok: false, message: image2ValidationError(model, "quality", "must be auto, low, medium, or high") };
      if (!isImageFormat(input.outputFormat)) return { ok: false, message: image2ValidationError(model, "outputFormat", "must be png, jpeg, or webp") };
      if (!isImageBackground(input.background)) return { ok: false, message: image2ValidationError(model, "background", "must be auto, transparent, or opaque") };
      if (!isImageModeration(input.moderation)) return { ok: false, message: image2ValidationError(model, "moderation", "must be auto or low") };
      const count = input.n ?? 1;
      if (!Number.isInteger(count) || count < 1 || count > MAX_IMAGES) return { ok: false, message: image2ValidationError(model, "n", `must be between 1 and ${MAX_IMAGES}`) };
      if (input.images !== undefined && (!Array.isArray(input.images) || input.images.length === 0)) return { ok: false, message: image2ValidationError(model, "images", "must be a non-empty array when provided") };
      if (input.imageRefs !== undefined && (!Array.isArray(input.imageRefs) || input.imageRefs.some((ref) => !ref.trim()))) return { ok: false, message: image2ValidationError(model, "imageRefs", "must contain non-empty strings") };
      return { ok: true, value: { ...input, model, n: count } };
    },
    isConcurrencySafe() {
      return true;
    },
    async call(input, context, callOptions): Promise<ToolResult> {
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

      const baseUrl = stripTrailingSlash(options.baseUrl?.trim() || process.env.OPENAI_IMAGE_BASE_URL?.trim() || process.env.OPENAI_BASE_URL?.trim() || DEFAULT_OPENAI_BASE_URL);
      const model = input.model?.trim() || DEFAULT_IMAGE_MODEL;
      const timeoutMs = options.timeoutMs ?? parsePositiveNumber(process.env.OPENAI_IMAGE_TIMEOUT_MS) ?? parsePositiveNumber(process.env.MODEL_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS;

      const mode = input.mode ?? "generate";
      callOptions.onProgress?.({ toolName: "image2", message: `${mode === "edit" ? "Editing" : "Generating"} image with OpenAI ${model}` });
      const startedAt = Date.now();

      try {
        const editSources = mode === "edit" ? resolveImageEditSources(input, context.messages) : [];
        if (mode === "edit" && editSources.length === 0) {
          throw new Error("image2 mode=edit requires a source image. Provide image/images/imageRefs, attach an image, or keep useLatestImage enabled with a prior image in the conversation.");
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
        const images = extractGeneratedImages(response, input.outputFormat ?? "png");
        const timing = imageGenerationTiming(startedAt);
        const output: ImageGenerationToolOutput = {
          ...timing,
          provider: "openai",
          mode,
          model,
          prompt: input.prompt,
          size: input.size ?? "auto",
          quality: input.quality ?? "auto",
          outputFormat: input.outputFormat ?? "png",
          background: input.background ?? "auto",
          returnedImages: images.length,
          sourceImages: mode === "edit" ? editSources.length : undefined,
          imageRefs: mode === "edit" ? editSources.map((source) => formatSourceImageRef(source)).filter((label): label is string => Boolean(label)) : undefined,
          images,
          raw: compactRawResponse(response),
        };
        return {
          ok: images.length > 0,
          output,
          summary: images.length ? `${images.length} image(s) ${mode === "edit" ? "edited" : "generated"} in ${timing.duration}ms` : `OpenAI returned no image data after ${timing.duration}ms`,
        };
      } catch (error) {
        return {
          ok: false,
          output: {
            ...imageGenerationTiming(startedAt),
            provider: "openai",
            mode,
            model,
            prompt: input.prompt,
            error: error instanceof Error ? error.message : String(error),
          },
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
  base64: string;
  mimeType: string;
  filename: string;
  label?: string;
  storagePath?: string;
}

interface OpenAIImageEditRequestOptions extends OpenAIImageGenerationRequestOptions {
  images: ResolvedEditImage[];
}

async function callOpenAIImageGeneration(options: OpenAIImageGenerationRequestOptions): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  const timeout = setTimeout(() => controller.abort(new Error(`Image generation request timed out after ${options.timeoutMs}ms`)), options.timeoutMs);
  options.signal?.addEventListener("abort", abort, { once: true });

  try {
    const response = await fetch(`${options.baseUrl}/v1/images/generations`, {
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
    if (!response.ok) {
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
  options.signal?.addEventListener("abort", abort, { once: true });

  try {
    const form = new FormData();
    for (const image of options.images) {
      form.append("image[]", base64ToBlob(image.base64, image.mimeType), image.filename);
    }
    for (const [key, value] of Object.entries(buildOpenAIImageRequestBody(options.input))) {
      if (value !== undefined) form.append(key, String(value));
    }

    const response = await fetch(`${options.baseUrl}/v1/images/edits`, {
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
    if (!response.ok) {
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
    background: input.background === "auto" ? undefined : input.background,
    moderation: input.moderation === "auto" ? undefined : input.moderation,
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

function resolveImageEditSources(input: ImageGenerationToolInput, messages: readonly Message[] | undefined): ResolvedEditImage[] {
  const explicit = [input.image, ...(input.images ?? [])].filter((image): image is ImageEditInputImage => !!image);
  const fromInput = explicit.map((image, index) => resolveInputImage(image, index));
  const fromRefs = resolveReferencedImages(messages, input.imageRefs ?? []);
  const shouldUseLatest = input.useLatestImage !== false && fromInput.length === 0 && fromRefs.length === 0 && (!input.imageRefs || input.imageRefs.length === 0);
  const latest = shouldUseLatest ? latestConversationImage(messages) : undefined;
  return [...fromInput, ...fromRefs, ...(latest ? [latest] : [])];
}

function resolveInputImage(image: ImageEditInputImage, index: number): ResolvedEditImage {
  const parsed = parseImageData(image.dataUrl ?? image.base64 ?? image.data);
  const mimeType = image.mimeType?.trim() || parsed.mimeType;
  if (!parsed.base64) throw new Error(`image2 edit source image ${index + 1} is missing base64/data/dataUrl`);
  if (!mimeType) throw new Error(`image2 edit source image ${index + 1} is missing mimeType`);
  return {
    index,
    base64: normalizeBase64ImageData(parsed.base64),
    mimeType,
    filename: image.name?.trim() || imageFilename(mimeType, index),
    label: image.label,
  };
}

function resolveReferencedImages(messages: readonly Message[] | undefined, refs: readonly string[]): ResolvedEditImage[] {
  if (!messages || refs.length === 0) return [];
  const imageBlocks = collectConversationImages(messages);
  return refs.map((ref, index) => {
    const found = findReferencedImage(imageBlocks, ref);
    if (!found) throw new Error(`image2 could not find referenced image: ${ref}. Available imageRefs: ${formatAvailableImageRefs(imageBlocks)}`);
    return { ...found, filename: found.filename || imageFilename(found.mimeType, index) };
  });
}

function findReferencedImage(images: readonly ResolvedEditImage[], ref: string): ResolvedEditImage | undefined {
  const normalizedRef = normalizeImageRef(ref);
  if (!normalizedRef) return undefined;

  // Labels can repeat across user turns (for example every tab/paste cycle can reuse [img#1]).
  // Prefer the most recent matching label/filename so edits target the image the user likely means.
  for (let i = images.length - 1; i >= 0; i -= 1) {
    const image = images[i];
    if (normalizeImageRef(image.label ?? "") === normalizedRef) return image;
    if (normalizeImageRef(image.filename) === normalizedRef) return image;
  }

  const numericRef = parseImageRefNumber(normalizedRef);
  if (numericRef !== undefined) return images[numericRef - 1];
  return undefined;
}

function formatSourceImageRef(image: ResolvedEditImage): string | undefined {
  const ref = image.label?.trim() || image.filename || String(image.index + 1);
  return image.storagePath ? `${ref} (${image.storagePath})` : ref;
}

function formatAvailableImageRefs(images: readonly ResolvedEditImage[]): string {
  if (images.length === 0) return "none";
  return images
    .map(formatSourceImageRef)
    .filter((ref): ref is string => Boolean(ref))
    .slice(-10)
    .join(", ");
}

function latestConversationImage(messages: readonly Message[] | undefined): ResolvedEditImage | undefined {
  const images = collectConversationImages(messages);
  return images[images.length - 1];
}

function collectConversationImages(messages: readonly Message[] | undefined): ResolvedEditImage[] {
  if (!messages) return [];
  const images: ResolvedEditImage[] = [];
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type !== "image") continue;
      const parsed = parseImageData(block.data);
      const mimeType = block.mimeType || parsed.mimeType;
      const base64 = parsed.base64 || readStoredImageDataSync(block.storage?.path);
      if (!base64 || !mimeType) continue;
      images.push({
        index: images.length,
        base64: normalizeBase64ImageData(base64),
        mimeType,
        filename: imageFilename(mimeType, images.length),
        label: block.label,
        storagePath: block.storage?.path,
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

function readStoredImageDataSync(filepath: string | undefined): string | undefined {
  if (!filepath) return undefined;
  try {
    return readFileSync(filepath, "utf8");
  } catch {
    return undefined;
  }
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
  const match = /^(?:\[?img#?|image(?:\s+|-)?)?(\d+)\]?$/iu.exec(normalizedRef);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function createImageGenerationToolResultMessage(result: ToolResult, toolUseId: string): Message | undefined {
  const output = result.output;
  const blocks: Message["blocks"] = [{
    type: "tool_result",
    toolUseId,
    name: "image2",
    ok: result.ok,
    output: compactImageGenerationOutput(output),
  }];

  if (result.ok && isImageGenerationToolOutput(output)) {
    for (const image of output.images) {
      blocks.push({ type: "image", mimeType: image.mimeType, data: image.base64, label: `Generated image ${image.index + 1}` });
    }
  }

  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    role: "tool_result",
    createdAt: new Date().toISOString(),
    blocks,
    metadata: result.ok ? { generatedImages: true, tool: "image2" } : undefined,
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

function extractGeneratedImages(response: Record<string, unknown>, format: OpenAIImageGenerationResponseFormat): ImageGenerationResult[] {
  const data = Array.isArray(response.data) ? response.data : [];
  return data.flatMap((item, index): ImageGenerationResult[] => {
    if (!isRecord(item)) return [];
    const base64 = stringFrom(item.b64_json ?? item.image_base64 ?? item.base64_json ?? item.base64);
    if (!base64) return [];
    const mimeType = `image/${format === "jpg" ? "jpeg" : format}`;
    return [{
      index,
      mimeType,
      base64,
      dataUrl: `data:${mimeType};base64,${base64}`,
      revisedPrompt: stringFrom(item.revised_prompt),
    }];
  });
}

function resolveApiKey(configured?: string): string | undefined {
  return configured?.trim() || process.env.OPENAI_IMAGE_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim() || undefined;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
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

function isImageToolMode(value: unknown): value is ImageToolMode {
  return value === "generate" || value === "edit";
}

function isSupportedImageModel(value: string): value is OpenAIImageModel {
  return (SUPPORTED_IMAGE_MODELS as readonly string[]).includes(value);
}

function image2ValidationError(model: string, field: string, reason: string): string {
  return `image2 validation failed for model ${model}: ${field} ${reason}.`;
}

function isImageSize(value: unknown): value is ImageGenerationSize {
  return value === "auto" || value === "1024x1024" || value === "1536x1024" || value === "1024x1536";
}

function isImageQuality(value: unknown): value is ImageGenerationQuality {
  return value === "auto" || value === "low" || value === "medium" || value === "high";
}

function isImageFormat(value: unknown): value is ImageGenerationFormat {
  return value === "png" || value === "jpeg" || value === "webp";
}

function isImageBackground(value: unknown): value is ImageGenerationBackground {
  return value === "auto" || value === "transparent" || value === "opaque";
}

function isImageModeration(value: unknown): value is ImageGenerationModeration {
  return value === "auto" || value === "low";
}

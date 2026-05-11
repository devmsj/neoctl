import type { Tool, ToolResult } from "../tool.js";
import type { Message } from "../../types/messages.js";

export type ImageGenerationSize = "auto" | "1024x1024" | "1536x1024" | "1024x1536";
export type ImageGenerationQuality = "auto" | "low" | "medium" | "high";
export type ImageGenerationFormat = "png" | "jpeg" | "webp";
export type OpenAIImageGenerationResponseFormat = ImageGenerationFormat | "jpg";
export type ImageGenerationBackground = "auto" | "transparent" | "opaque";
export type ImageGenerationModeration = "auto" | "low";

export interface ImageGenerationToolInput {
  prompt: string;
  model?: string;
  size?: ImageGenerationSize;
  quality?: ImageGenerationQuality;
  outputFormat?: ImageGenerationFormat;
  background?: ImageGenerationBackground;
  moderation?: ImageGenerationModeration;
  n?: number;
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
  model: string;
  prompt: string;
  size: ImageGenerationSize;
  quality: ImageGenerationQuality;
  outputFormat: ImageGenerationFormat;
  background: ImageGenerationBackground;
  returnedImages: number;
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
const DEFAULT_IMAGE_MODEL = "gpt-image-1";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_IMAGES = 4;

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
    aliases: ["draw_image", "generate_image"],
    description: "Generate images with OpenAI's Images API. Use this when the user asks you to draw, create, generate, or render an image. Return the generated image data URLs in the tool result for the UI to display. This tool is available only when MODEL_PROVIDER=openai; with other providers, state that this model does not have a drawing tool.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Detailed image prompt. Include subject, style, composition, colors, text to render, aspect ratio intent, and any safety-preserving constraints." },
        model: { type: "string", description: `Optional OpenAI image model. Defaults to OPENAI_IMAGE_MODEL or ${DEFAULT_IMAGE_MODEL}.` },
        size: { type: "string", enum: ["auto", "1024x1024", "1536x1024", "1024x1536"], description: "Output image size. Use 1024x1024 for square, 1536x1024 for landscape, 1024x1536 for portrait. Defaults to auto." },
        quality: { type: "string", enum: ["auto", "low", "medium", "high"], description: "Rendering quality. Defaults to auto." },
        outputFormat: { type: "string", enum: ["png", "jpeg", "webp"], description: "Returned image format. Defaults to png." },
        background: { type: "string", enum: ["auto", "transparent", "opaque"], description: "Background handling for supported models. Defaults to auto." },
        moderation: { type: "string", enum: ["auto", "low"], description: "OpenAI image moderation setting for supported models. Defaults to auto." },
        n: { type: "integer", description: `Number of images to generate, 1-${MAX_IMAGES}. Defaults to 1.` },
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
        prompt: record.prompt ?? "",
        model: record.model,
        size: record.size ?? "auto",
        quality: record.quality ?? "auto",
        outputFormat: record.outputFormat ?? "png",
        background: record.background ?? "auto",
        moderation: record.moderation ?? "auto",
        n: record.n ?? 1,
      };
    },
    validateInput(input) {
      if (!input.prompt.trim()) return { ok: false, message: "image2.prompt cannot be empty" };
      if (input.model !== undefined && !input.model.trim()) return { ok: false, message: "image2.model cannot be empty" };
      if (!isImageSize(input.size)) return { ok: false, message: "image2.size must be auto, 1024x1024, 1536x1024, or 1024x1536" };
      if (!isImageQuality(input.quality)) return { ok: false, message: "image2.quality must be auto, low, medium, or high" };
      if (!isImageFormat(input.outputFormat)) return { ok: false, message: "image2.outputFormat must be png, jpeg, or webp" };
      if (!isImageBackground(input.background)) return { ok: false, message: "image2.background must be auto, transparent, or opaque" };
      if (!isImageModeration(input.moderation)) return { ok: false, message: "image2.moderation must be auto or low" };
      const count = input.n ?? 1;
      if (!Number.isInteger(count) || count < 1 || count > MAX_IMAGES) return { ok: false, message: `image2.n must be between 1 and ${MAX_IMAGES}` };
      return { ok: true, value: { ...input, n: count } };
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
      const model = input.model?.trim() || options.model?.trim() || process.env.OPENAI_IMAGE_MODEL?.trim() || DEFAULT_IMAGE_MODEL;
      const timeoutMs = options.timeoutMs ?? parsePositiveNumber(process.env.OPENAI_IMAGE_TIMEOUT_MS) ?? parsePositiveNumber(process.env.MODEL_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS;

      callOptions.onProgress?.({ toolName: "image2", message: `Generating image with OpenAI ${model}` });
      const startedAt = Date.now();

      try {
        const response = await callOpenAIImageGeneration({
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
          model,
          prompt: input.prompt,
          size: input.size ?? "auto",
          quality: input.quality ?? "auto",
          outputFormat: input.outputFormat ?? "png",
          background: input.background ?? "auto",
          returnedImages: images.length,
          images,
          raw: compactRawResponse(response),
        };
        return {
          ok: images.length > 0,
          output,
          summary: images.length ? `${images.length} image(s) generated in ${timing.duration}ms` : `OpenAI returned no image data after ${timing.duration}ms`,
        };
      } catch (error) {
        return {
          ok: false,
          output: {
            ...imageGenerationTiming(startedAt),
            provider: "openai",
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

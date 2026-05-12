import { readFileSync } from "node:fs";
import path from "node:path";
import { supportsImageInput } from "../../model/context-window.js";
import type { ModelGateway, ModelStreamEvent, ModelUsage, ReasoningConfig } from "../../model/model-gateway.js";
import { createToolResultMessage, type Message, type MessageBlock } from "../../types/messages.js";
import type { Tool, ToolResult, ToolUseContext } from "../tool.js";

export interface VisionToolInput {
  /** Question/instruction for the vision-capable model. */
  prompt: string;
  /** Prior conversation image labels/refs/paths, e.g. [img#1], image 1, Generated image 1, or a storage.path. */
  imageRefs?: string[];
  /** Use the latest prior conversation image when imageRefs is omitted. Defaults to true. */
  useLatestImage?: boolean;
  /** Optional model override. Defaults to the current main-loop model. */
  model?: string;
  /** Optional max output tokens for the vision analysis response. */
  maxOutputTokens?: number;
}

export interface VisionToolOutput {
  provider: "model-gateway";
  model?: string;
  prompt: string;
  imageRefs: string[];
  sourceImages: number;
  images: Array<{
    index: number;
    label?: string;
    mimeType: string;
    filename: string;
    storagePath?: string;
  }>;
  text: string;
  durationMs: number;
  usage?: ModelUsage;
}

export interface CreateVisionToolOptions {
  modelGateway?: ModelGateway;
  model?: string;
  timeoutMs?: number;
}

interface ResolvedVisionImage {
  index: number;
  base64: string;
  mimeType: string;
  filename: string;
  label?: string;
  storagePath?: string;
  storageFormat?: "base64" | "data-url";
}

const DEFAULT_TIMEOUT_MS = 120_000;

export function createVisionTool(options: CreateVisionToolOptions = {}): Tool<VisionToolInput> {
  return {
    name: "vision",
    description: "Inspect, describe, OCR, or answer questions about images from the current/prior conversation using the current vision-capable model. Accepts imageRefs such as [img#1], image 1, Generated image 1, filenames, or stored image paths; if omitted, defaults to the latest prior image. This tool is visible only when the current model is not known to lack image input support.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Question/instruction for visual analysis, OCR, object identification, chart reading, etc." },
        imageRefs: { type: "array", description: "Labels, numeric refs, filenames, or storage paths of prior conversation images, e.g. [img#1], image 1, Generated image 1, or C:\\...\\image.base64.txt.", items: { type: "string" } },
        useLatestImage: { type: "boolean", description: "When imageRefs is omitted, use the latest prior conversation image. Defaults to true." },
        model: { type: "string", description: "Optional model override. Defaults to the current main-loop model; the model must support image input." },
        maxOutputTokens: { type: "integer", description: "Optional maximum output tokens for the vision response." },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    metadata: {
      readOnly: true,
      concurrent: true,
      visible: true,
      maxResultSizeChars: 24000,
    },
    isEnabled(context) {
      if (!context) return false;
      const model = resolveVisionModel(undefined, context, options);
      return Boolean(model) && supportsImageInput(model) === true;
    },
    validate(input) {
      const record = input as Partial<VisionToolInput>;
      return {
        prompt: record.prompt ?? "",
        imageRefs: record.imageRefs,
        useLatestImage: record.useLatestImage ?? true,
        model: record.model,
        maxOutputTokens: record.maxOutputTokens,
      };
    },
    validateInput(input, context) {
      if (!input.prompt.trim()) return { ok: false, message: "vision prompt cannot be empty" };
      if (input.imageRefs !== undefined && (!Array.isArray(input.imageRefs) || input.imageRefs.some((ref) => !ref.trim()))) {
        return { ok: false, message: "vision imageRefs must contain non-empty strings" };
      }
      if (input.maxOutputTokens !== undefined && (!Number.isInteger(input.maxOutputTokens) || input.maxOutputTokens <= 0)) {
        return { ok: false, message: "vision maxOutputTokens must be a positive integer" };
      }
      const model = resolveVisionModel(input, context, options);
      if (!model) return { ok: false, message: "vision requires a configured current model or a model parameter" };
      if (supportsImageInput(model) !== true) {
        return { ok: false, message: `vision requires a model that is explicitly marked as supporting image input; ${model} is not marked imageInput=true in model metadata` };
      }
      return { ok: true, value: { ...input, model } };
    },
    isConcurrencySafe() {
      return true;
    },
    async call(input, context, callOptions): Promise<ToolResult> {
      const gateway = context.options?.modelGateway ?? options.modelGateway;
      if (!gateway) {
        return { ok: false, output: { error: "vision requires a model gateway in tool context" } };
      }

      const model = resolveVisionModel(input, context, options);
      const timeoutMs = options.timeoutMs ?? parsePositiveNumber(process.env.VISION_TIMEOUT_MS) ?? parsePositiveNumber(process.env.MODEL_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS;
      const startedAt = Date.now();

      try {
        const images = resolveVisionImages(input, context.messages);
        if (images.length === 0) {
          const available = formatAvailableImageRefs(collectConversationImages(context.messages));
          throw new Error(`vision requires at least one source image. Provide imageRefs or keep useLatestImage enabled. Available imageRefs: ${available}`);
        }

        callOptions.onProgress?.({ toolName: "vision", message: `Inspecting ${images.length} image(s) with ${model ?? "current model"}` });
        const result = await callVisionModel({
          gateway,
          model,
          prompt: input.prompt,
          images,
          timeoutMs,
          maxOutputTokens: input.maxOutputTokens,
          reasoning: normalizeReasoning(context.options?.reasoning),
          signal: context.abortSignal,
        });
        const durationMs = Date.now() - startedAt;
        const output: VisionToolOutput = {
          provider: "model-gateway",
          model,
          prompt: input.prompt,
          imageRefs: images.map((image) => formatSourceImageRef(image)).filter((ref): ref is string => Boolean(ref)),
          sourceImages: images.length,
          images: images.map((image) => ({
            index: image.index,
            label: image.label,
            mimeType: image.mimeType,
            filename: image.filename,
            storagePath: image.storagePath,
          })),
          text: result.text,
          durationMs,
          usage: result.usage,
        };
        return {
          ok: result.text.trim().length > 0,
          output,
          summary: result.text.trim() ? `vision inspected ${images.length} image(s) in ${durationMs}ms` : `vision returned no text after ${durationMs}ms`,
        };
      } catch (error) {
        return {
          ok: false,
          output: {
            provider: "model-gateway",
            model,
            error: error instanceof Error ? error.message : String(error),
            durationMs: Date.now() - startedAt,
          },
        };
      }
    },
    mapResult(result) {
      const output = result.output;
      if (!isVisionToolOutput(output)) return output;
      return {
        ...output,
        images: output.images.map((image) => ({
          index: image.index,
          label: image.label,
          mimeType: image.mimeType,
          filename: image.filename,
          storagePath: image.storagePath,
        })),
      };
    },
    renderToolResultMessage(result, request) {
      if (!request) return undefined;
      const output = this.mapResult ? this.mapResult(result, request) : result.output;
      return createToolResultMessage(request, result.ok, output);
    },
  };
}

export const visionTool = createVisionTool();

function resolveVisionModel(input: Partial<VisionToolInput> | undefined, context: ToolUseContext, options: CreateVisionToolOptions): string | undefined {
  return input?.model?.trim() || options.model?.trim() || context.options?.mainLoopModel?.trim() || process.env.MODEL?.trim() || process.env.OPENAI_MODEL?.trim();
}

function resolveVisionImages(input: VisionToolInput, messages: readonly Message[] | undefined): ResolvedVisionImage[] {
  const refs = input.imageRefs ?? [];
  if (refs.length > 0) return resolveReferencedImages(messages, refs);
  if (input.useLatestImage === false) return [];
  const latest = latestConversationImage(messages);
  return latest ? [latest] : [];
}

function resolveReferencedImages(messages: readonly Message[] | undefined, refs: readonly string[]): ResolvedVisionImage[] {
  if (!messages || refs.length === 0) return [];
  const imageBlocks = collectConversationImages(messages);
  return refs.map((ref, index) => {
    const found = findReferencedImage(imageBlocks, ref);
    if (!found) throw new Error(`vision could not find referenced image: ${ref}. Available imageRefs: ${formatAvailableImageRefs(imageBlocks)}`);
    return { ...found, filename: found.filename || imageFilename(found.mimeType, index) };
  });
}

function findReferencedImage(images: readonly ResolvedVisionImage[], ref: string): ResolvedVisionImage | undefined {
  const normalizedRef = normalizeImageRef(ref);
  if (!normalizedRef) return undefined;

  for (let i = images.length - 1; i >= 0; i -= 1) {
    const image = images[i];
    const candidates = [
      image.label,
      image.filename,
      image.storagePath,
      image.storagePath ? path.basename(image.storagePath) : undefined,
    ];
    if (candidates.some((candidate) => normalizeImageRef(candidate ?? "") === normalizedRef)) return image;
  }

  const numericRef = parseImageRefNumber(normalizedRef);
  if (numericRef !== undefined) return images[numericRef - 1];
  return undefined;
}

function formatSourceImageRef(image: ResolvedVisionImage): string | undefined {
  const ref = image.label?.trim() || image.filename || String(image.index + 1);
  return image.storagePath ? `${ref} (${image.storagePath})` : ref;
}

function formatAvailableImageRefs(images: readonly ResolvedVisionImage[]): string {
  if (images.length === 0) return "none";
  return images
    .map(formatSourceImageRef)
    .filter((ref): ref is string => Boolean(ref))
    .slice(-10)
    .join(", ");
}

function latestConversationImage(messages: readonly Message[] | undefined): ResolvedVisionImage | undefined {
  const images = collectConversationImages(messages);
  return images[images.length - 1];
}

function collectConversationImages(messages: readonly Message[] | undefined): ResolvedVisionImage[] {
  if (!messages) return [];
  const images: ResolvedVisionImage[] = [];
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type !== "image") continue;
      const parsedInline = parseImageData(block.data);
      const stored = readStoredImageDataSync(block.storage?.path);
      const parsedStored = parseImageData(stored);
      const mimeType = block.mimeType || parsedInline.mimeType || parsedStored.mimeType;
      const base64 = parsedInline.base64 || parsedStored.base64;
      if (!base64 || !mimeType) continue;
      images.push({
        index: images.length,
        base64: normalizeBase64ImageData(base64),
        mimeType,
        filename: imageFilename(mimeType, images.length),
        label: block.label,
        storagePath: block.storage?.path,
        storageFormat: block.storage?.format,
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
    .replace(/\\/gu, "/")
    .replace(/\s+/gu, " ");
}

function parseImageRefNumber(normalizedRef: string): number | undefined {
  const match = /^(?:\[?img#?|image(?:\s+|-)?)?(\d+)\]?$/iu.exec(normalizedRef);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

async function callVisionModel(options: {
  gateway: ModelGateway;
  model?: string;
  prompt: string;
  images: readonly ResolvedVisionImage[];
  timeoutMs: number;
  maxOutputTokens?: number;
  reasoning?: ReasoningConfig | null;
  signal?: AbortSignal;
}): Promise<{ text: string; usage?: ModelUsage }> {
  const userMessage = createVisionUserMessage(options.prompt, options.images);
  const deltaParts: string[] = [];
  const messageParts: string[] = [];
  let usage: ModelUsage | undefined;

  for await (const event of options.gateway.stream({
    model: options.model,
    messages: [userMessage],
    systemPrompt: "You are a vision analysis tool. Answer the user's image question accurately and concisely. If text is visible in the image, transcribe it when relevant.",
    tools: [],
    stream: false,
    maxOutputTokens: options.maxOutputTokens,
    reasoning: options.reasoning,
    timeoutMs: options.timeoutMs,
    cancellation: options.signal,
  })) {
    collectVisionModelEvent(event, deltaParts, messageParts);
    if (event.type === "usage" || event.type === "response_completed" || event.type === "response_incomplete") usage = event.usage ?? usage;
    if (event.type === "error") throw event.error;
  }

  const messageText = messageParts.join("\n").trim();
  const deltaText = deltaParts.join("").trim();
  return { text: messageText || deltaText, usage };
}

function createVisionUserMessage(prompt: string, images: readonly ResolvedVisionImage[]): Message {
  const blocks: MessageBlock[] = [
    { type: "text", text: prompt },
    ...images.map((image): MessageBlock => ({
      type: "image",
      mimeType: image.mimeType,
      data: image.base64,
      label: image.label ?? image.filename,
      storage: image.storagePath && image.storageFormat ? { path: image.storagePath, format: image.storageFormat } : undefined,
    })),
  ];
  return {
    id: `vision-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    role: "user",
    createdAt: new Date().toISOString(),
    blocks,
  };
}

function collectVisionModelEvent(event: ModelStreamEvent, deltaParts: string[], messageParts: string[]): void {
  if (event.type === "assistant_delta") deltaParts.push(event.text);
  if (event.type === "assistant_message") {
    const text = event.message.blocks
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (text) messageParts.push(text);
  }
}

function normalizeReasoning(value: unknown): ReasoningConfig | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== "object") return undefined;
  return value as ReasoningConfig;
}

function parsePositiveNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function isVisionToolOutput(value: unknown): value is VisionToolOutput {
  return !!value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).provider === "model-gateway" && typeof (value as Record<string, unknown>).text === "string";
}

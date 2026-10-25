import { executionReadFileSync as readFileSync, executionStatSync as statSync } from "../../execution/filesystem.js";
import { dockerEnabled, executionCwd } from "../../execution/docker.js";
import path from "node:path";
import { supportsImageInput } from "../../model/context-window.js";
import { getContextImageStore, imageRegistryForContext, resolveContextImage } from "../../core/session-images.js";
import { resolveImageRefResult, formatImageRegistryForContext, loadImageData } from "../../core/image-registry.js";
import type { Message, MessageBlock } from "../../types/messages.js";
import type { ImageRetention } from "../../core/image-notes.js";
import type { Tool, ToolResult, ToolUseContext } from "../tool.js";

export interface LoadImageToolInput {
  /** Image references: ids like "img_1", labels, numeric refs like "image 1", storage paths, or external file paths. */
  imageRefs?: string[];
  mode?: "inspect" | "list";
  offset?: number;
  limit?: number;
  /** Optional question/context about what to look for in the image(s). Included as text alongside images. */
  prompt?: string;
  /** How long the loaded image pixels should remain directly visible in model context. */
  retention?: ImageRetention;
  /** For while_relevant, number of assistant turns to keep sending pixels unless reloaded. */
  ttlTurns?: number;
}

interface LoadedImageInfo {
  id: string;
  imageId?: string;
  alias?: string;
  label?: string;
  mimeType: string;
  origin: string;
  storagePath?: string;
}

export interface LoadImageToolOutput {
  loadedImages: LoadedImageInfo[];
  failedRefs: string[];
  prompt?: string;
  retention?: ImageRetention;
  ttlTurns?: number;
}

const SUPPORTED_EXTENSIONS: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
};

const MAX_FILE_SIZE = 20 * 1024 * 1024;

function isExternalFilePath(ref: string): boolean {
  const trimmed = ref.trim();
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return true;
  if (trimmed.startsWith("/") || trimmed.startsWith("~")) return true;
  if (trimmed.startsWith("./") || trimmed.startsWith("..") || trimmed.startsWith(".\\")) return true;
  const ext = path.extname(trimmed).toLowerCase();
  return ext in SUPPORTED_EXTENSIONS;
}

function loadExternalImage(filePath: string): { base64: string; mimeType: string; label: string } | { error: string } {
  const resolved = path.resolve(filePath);
  const ext = path.extname(resolved).toLowerCase();
  const mimeType = SUPPORTED_EXTENSIONS[ext];
  if (!mimeType) {
    return { error: `Unsupported image format: ${ext}. Supported: ${Object.keys(SUPPORTED_EXTENSIONS).join(", ")}` };
  }
  try {
    const stat = statSync(resolved);
    if (!stat.isFile()) return { error: `Not a file: ${resolved}` };
    if (stat.size > MAX_FILE_SIZE) return { error: `File too large: ${(stat.size / 1024 / 1024).toFixed(1)}MB (max ${MAX_FILE_SIZE / 1024 / 1024}MB)` };
    const buffer = readFileSync(resolved);
    return {
      base64: buffer.toString("base64"),
      mimeType,
      label: path.basename(resolved),
    };
  } catch (err) {
    return { error: `Cannot read file: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function createLoadImageTool(): Tool<LoadImageToolInput> {
  return {
    name: "image_inspect",
    description:
      "When a historical image is not visible in the active context, load its pixels before description, OCR or visual analysis. Use IDs/labels from the image registry; context compaction retains references, not visual facts. " +
      "Use mode=list (no imageRefs required) to discover persistent session image IDs with offset/limit pagination. Inspect results return reusable IDs; retention only controls pixel visibility. Load one or more images into the current context for direct visual inspection by the model. " +
      "Supports two sources: (1) conversation history images via ids (img_1), labels, or numeric refs; " +
      "(2) external files via absolute or relative file paths (e.g. ./screenshot.png, C:\\images\\photo.jpg). " +
      "Supported formats: PNG, JPEG, GIF, WebP, BMP, SVG. Max file size: 20MB. " +
      "The loaded images become visible to you in the next message. " +
      "This tool is available only when the current model supports image input.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["inspect", "list"], description: "inspect loads pixels; list discovers persistent session references without loading pixels." },
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        imageRefs: {
          type: "array",
          items: { type: "string" },
          description: "Image references: registry ids (img_1), labels, numeric refs (image 1, [img#2]), or file paths (./photo.png, /abs/path/img.jpg, C:\\images\\pic.png).",
        },
        prompt: {
          type: "string",
          description: "Optional analysis context or question about the image(s). Will be shown alongside the images.",
        },
        retention: {
          type: "string",
          enum: ["next_turn", "while_relevant", "pinned"],
          description: "Model-chosen pixel retention. Use next_turn for one-off inspection/OCR, while_relevant for multi-turn visual work such as UI design, and pinned only for explicit long-lived references.",
        },
        ttlTurns: {
          type: "number",
          description: "For while_relevant retention, number of assistant turns to keep the image pixels directly visible. Defaults to 4, range 1-12.",
        },
      },
      required: [],
      additionalProperties: false,
    },
    metadata: {
      readOnly: true,
      concurrent: true,
      visible: true,
      maxResultSizeChars: 2000,
    },
    isEnabled(context) {
      if (!context) return false;
      const model = context.options?.mainLoopModel;
      return Boolean(model) && supportsImageInput(model) === true;
    },
    validate(input) {
      const record = input as Partial<LoadImageToolInput>;
      return {
        imageRefs: record.imageRefs ?? [],
        mode: record.mode, offset: record.offset, limit: record.limit,
        prompt: record.prompt,
        retention: record.retention,
        ttlTurns: record.ttlTurns,
      };
    },
    validateInput(input, context) {
      if (input.mode && input.mode !== "inspect" && input.mode !== "list") return { ok: false, message: "mode must be inspect or list" };
      if (input.offset !== undefined && (!Number.isInteger(input.offset) || input.offset < 0)) return { ok: false, message: "offset must be a non-negative integer" };
      if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)) return { ok: false, message: "limit must be an integer from 1 to 100" };
      if (input.mode === "list") return { ok: true, value: input };
      if (!input.imageRefs || input.imageRefs.length === 0) {
        return { ok: false, message: "imageRefs must contain at least one image reference" };
      }
      if (input.imageRefs.some((ref) => !ref.trim())) {
        return { ok: false, message: "imageRefs must contain non-empty strings" };
      }
      if (input.imageRefs.length > 10) {
        return { ok: false, message: "Cannot load more than 10 images at once to avoid context overflow" };
      }
      if (input.retention && !["next_turn", "while_relevant", "pinned"].includes(input.retention)) {
        return { ok: false, message: "retention must be one of: next_turn, while_relevant, pinned" };
      }
      if (input.ttlTurns !== undefined && (!Number.isFinite(input.ttlTurns) || input.ttlTurns < 1 || input.ttlTurns > 12)) {
        return { ok: false, message: "ttlTurns must be a number from 1 to 12" };
      }
      const model = context.options?.mainLoopModel;
      if (!model || supportsImageInput(model) !== true) {
        return { ok: false, message: "image_inspect requires a model that supports image input" };
      }
      return { ok: true, value: input };
    },
    isConcurrencySafe() {
      return true;
    },
    async call(input, context): Promise<ToolResult> {
      const imageStore = await getContextImageStore(context);
      const registry = imageRegistryForContext(context);
      if (input.mode === "list") {
        const offset = input.offset ?? 0;
        const limit = input.limit ?? 20;
        const images = registry.images.slice(offset, offset + limit).map(entry => ({
          id: entry.imageId ?? entry.id, alias: entry.id, label: entry.label, mimeType: entry.mimeType, origin: entry.origin,
          available: Boolean(loadImageData(entry)),
        }));
        return { ok: true, output: { images, total: registry.images.length, offset, nextOffset: offset + images.length < registry.images.length ? offset + images.length : null } };
      }
      const loadedImages: LoadedImageInfo[] = [];
      const failedRefs: string[] = [];
      const imageBlocks: MessageBlock[] = [];

      for (const ref of input.imageRefs ?? []) {
        const explicitPath = /[\\/]/u.test(ref) && path.extname(ref).toLowerCase() in SUPPORTED_EXTENSIONS;
        const resolution = explicitPath ? { status: "not-found" as const } : resolveImageRefResult(registry, ref);
        if (resolution.status === "ambiguous") {
          failedRefs.push(`${ref} (ambiguous; use one of: ${resolution.candidates.map((entry) => entry.imageId ?? entry.id).join(", ")})`);
          continue;
        }
        if (resolution.status === "resolved") {
          const entry = resolution.entry;
          let base64: string;
          try { base64 = resolveContextImage(context, ref).data; }
          catch (error) { failedRefs.push(error instanceof Error ? error.message : String(error)); continue; }
          const rawBase64 = base64.replace(/^data:[^;,]+;base64,/su, "").replace(/\s+/gu, "");
          imageBlocks.push({
            type: "image",
            imageId: entry.imageId,
            imageAlias: entry.id,
            mimeType: entry.mimeType,
            data: rawBase64,
            label: entry.label ?? entry.id,
            storage: entry.storagePath && entry.storageFormat
              ? { path: entry.storagePath, format: entry.storageFormat, contentHash: entry.contentHash }
              : undefined,
          });
          loadedImages.push({
            id: entry.imageId ?? entry.id,
            imageId: entry.imageId, alias: entry.id,
            label: entry.label,
            mimeType: entry.mimeType,
            origin: entry.origin,
            storagePath: entry.storagePath,
          });
          continue;
        }

        if (isExternalFilePath(ref)) {
          const externalPath = dockerEnabled() ? path.posix.resolve(executionCwd(context.appState.snapshot().cwd), ref) : ref;
          const result = loadExternalImage(externalPath);
          if ("error" in result) {
            failedRefs.push(`${ref} (${result.error})`);
            continue;
          }
          const resolvedPath = path.resolve(externalPath);
          const block = await imageStore.importFile(result.base64, result.mimeType, resolvedPath, result.label);
          imageBlocks.push(block);
          loadedImages.push({
            id: block.imageId!, imageId: block.imageId, alias: block.imageAlias,
            label: result.label, mimeType: result.mimeType, origin: "external", storagePath: block.storage?.path,
          });
          continue;
        }

        failedRefs.push(ref);
      }

      if (loadedImages.length === 0) {
        const available = formatImageRegistryForContext(registry);
        return {
          ok: false,
          output: {
            error: `Could not load any images. Failed refs: ${failedRefs.join(", ")}`,
            availableImages: available || "No images found in conversation history.",
          },
        };
      }

      const retention = input.retention ?? "next_turn";
      const ttlTurns = retention === "while_relevant" ? Math.round(input.ttlTurns ?? 4) : undefined;
      const textParts: string[] = [];
      if (input.prompt) textParts.push(input.prompt);
      textParts.push(`Loaded ${loadedImages.length} image(s): ${loadedImages.map((i) => i.label ?? i.id).join(", ")}`);
      textParts.push(`Image pixel retention: ${retention}${ttlTurns ? ` for ${ttlTurns} turn(s)` : ""}. The model chose this retention; reload or change retention if the visual context is still needed.`);
      if (failedRefs.length > 0) textParts.push(`Failed to load: ${failedRefs.join(", ")}`);

      const newMessage: Message = {
        id: `load-image-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        role: "user",
        createdAt: new Date().toISOString(),
        blocks: [
          { type: "text", text: textParts.join("\n") },
          ...imageBlocks,
        ],
        isMeta: true,
        metadata: {
          loadedImages: true,
          imageRefs: input.imageRefs,
          imageRetention: retention,
          ...(ttlTurns ? { imageTtlTurns: ttlTurns } : {}),
          loadedImageLabels: loadedImages.map((image) => image.label ?? image.id),
        },
      };

      const output: LoadImageToolOutput = {
        loadedImages,
        failedRefs,
        prompt: input.prompt,
        retention,
        ttlTurns,
      };

      return {
        ok: true,
        output,
        summary: `Loaded ${loadedImages.length} image(s) into context for direct inspection`,
        newMessages: [await imageStore.persistMessage(newMessage)],
      };
    },
    renderToolResultMessage(result, request) {
      if (!request) return undefined;
      if (result.ok && typeof result.output === "object" && result.output && "images" in result.output) {
        return { id: `image-list-${Date.now()}-${Math.random()}`, role: "tool_result", createdAt: new Date().toISOString(), blocks: [{ type: "tool_result", toolUseId: request.id, name: "image_inspect", ok: true, output: result.output }] };
      }
      const output = result.output as LoadImageToolOutput;
      const text = result.ok
        ? `Images loaded into context: ${output.loadedImages.map((i) => `${i.id}${i.alias ? ` (${i.alias})` : ""}: ${i.label ?? "image"}`).join(", ")}. You can now see them directly.${output.failedRefs.length > 0 ? ` Failed: ${output.failedRefs.join(", ")}` : ""}`
        : `Failed to load images: ${JSON.stringify(result.output)}`;
      return {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
        role: "tool_result" as const,
        createdAt: new Date().toISOString(),
        blocks: [{
          type: "tool_result" as const,
          toolUseId: request.id,
          name: "image_inspect",
          ok: result.ok,
          output: text,
        }],
      };
    },
  };
}

export const loadImageTool = createLoadImageTool();

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { supportsImageInput } from "../../model/context-window.js";
import { getImageRegistryFromMessages } from "../../core/message-pipeline.js";
import { resolveImageRef, formatImageRegistryForContext, loadImageData } from "../../core/image-registry.js";
import type { Message, MessageBlock } from "../../types/messages.js";
import type { Tool, ToolResult, ToolUseContext } from "../tool.js";

export interface LoadImageToolInput {
  /** Image references: ids like "img_1", labels, numeric refs like "image 1", storage paths, or external file paths. */
  imageRefs: string[];
  /** Optional question/context about what to look for in the image(s). Included as text alongside images. */
  prompt?: string;
}

interface LoadedImageInfo {
  id: string;
  label?: string;
  mimeType: string;
  origin: string;
  storagePath?: string;
}

export interface LoadImageToolOutput {
  loadedImages: LoadedImageInfo[];
  failedRefs: string[];
  prompt?: string;
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
    name: "load_image",
    aliases: ["view_image", "inspect_image"],
    description:
      "Load one or more images into the current context for direct visual inspection by the model. " +
      "Supports two sources: (1) conversation history images via ids (img_1), labels, or numeric refs; " +
      "(2) external files via absolute or relative file paths (e.g. ./screenshot.png, C:\\images\\photo.jpg). " +
      "Supported formats: PNG, JPEG, GIF, WebP, BMP, SVG. Max file size: 20MB. " +
      "The loaded images become visible to you in the next message. " +
      "This tool is available only when the current model supports image input.",
    inputSchema: {
      type: "object",
      properties: {
        imageRefs: {
          type: "array",
          items: { type: "string" },
          description: "Image references: registry ids (img_1), labels, numeric refs (image 1, [img#2]), or file paths (./photo.png, /abs/path/img.jpg, C:\\images\\pic.png).",
        },
        prompt: {
          type: "string",
          description: "Optional analysis context or question about the image(s). Will be shown alongside the images.",
        },
      },
      required: ["imageRefs"],
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
        prompt: record.prompt,
      };
    },
    validateInput(input, context) {
      if (!input.imageRefs || input.imageRefs.length === 0) {
        return { ok: false, message: "imageRefs must contain at least one image reference" };
      }
      if (input.imageRefs.some((ref) => !ref.trim())) {
        return { ok: false, message: "imageRefs must contain non-empty strings" };
      }
      if (input.imageRefs.length > 10) {
        return { ok: false, message: "Cannot load more than 10 images at once to avoid context overflow" };
      }
      const model = context.options?.mainLoopModel;
      if (!model || supportsImageInput(model) !== true) {
        return { ok: false, message: "load_image requires a model that supports image input" };
      }
      return { ok: true, value: input };
    },
    isConcurrencySafe() {
      return true;
    },
    async call(input, context): Promise<ToolResult> {
      const registry = getImageRegistryFromMessages(context.messages ?? []);
      const loadedImages: LoadedImageInfo[] = [];
      const failedRefs: string[] = [];
      const imageBlocks: MessageBlock[] = [];
      let externalCount = 0;

      for (const ref of input.imageRefs) {
        const entry = resolveImageRef(registry, ref);
        if (entry) {
          const base64 = loadImageData(entry);
          if (!base64) {
            failedRefs.push(`${ref} (storage unreadable: ${entry.storagePath ?? "no path"})`);
            continue;
          }
          const rawBase64 = base64.replace(/^data:[^;,]+;base64,/su, "").replace(/\s+/gu, "");
          imageBlocks.push({
            type: "image",
            mimeType: entry.mimeType,
            data: rawBase64,
            label: entry.label ?? entry.id,
            storage: entry.storagePath && entry.storageFormat
              ? { path: entry.storagePath, format: entry.storageFormat }
              : undefined,
          });
          loadedImages.push({
            id: entry.id,
            label: entry.label,
            mimeType: entry.mimeType,
            origin: entry.origin,
            storagePath: entry.storagePath,
          });
          continue;
        }

        if (isExternalFilePath(ref)) {
          const result = loadExternalImage(ref);
          if ("error" in result) {
            failedRefs.push(`${ref} (${result.error})`);
            continue;
          }
          externalCount += 1;
          const resolvedPath = path.resolve(ref);
          imageBlocks.push({
            type: "image",
            mimeType: result.mimeType,
            data: result.base64,
            label: result.label,
          });
          loadedImages.push({
            id: `ext_${externalCount}`,
            label: result.label,
            mimeType: result.mimeType,
            origin: "external",
            storagePath: resolvedPath,
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

      const textParts: string[] = [];
      if (input.prompt) textParts.push(input.prompt);
      textParts.push(`Loaded ${loadedImages.length} image(s): ${loadedImages.map((i) => i.label ?? i.id).join(", ")}`);
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
        metadata: { loadedImages: true, imageRefs: input.imageRefs },
      };

      const output: LoadImageToolOutput = {
        loadedImages,
        failedRefs,
        prompt: input.prompt,
      };

      return {
        ok: true,
        output,
        summary: `Loaded ${loadedImages.length} image(s) into context for direct inspection`,
        newMessages: [newMessage],
      };
    },
    renderToolResultMessage(result, request) {
      if (!request) return undefined;
      const output = result.output as LoadImageToolOutput;
      const text = result.ok
        ? `Images loaded into context: ${output.loadedImages.map((i) => i.label ?? i.id).join(", ")}. You can now see them directly.${output.failedRefs.length > 0 ? ` Failed: ${output.failedRefs.join(", ")}` : ""}`
        : `Failed to load images: ${JSON.stringify(result.output)}`;
      return {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
        role: "tool_result" as const,
        createdAt: new Date().toISOString(),
        blocks: [{
          type: "tool_result" as const,
          toolUseId: request.id,
          name: "load_image",
          ok: result.ok,
          output: text,
        }],
      };
    },
  };
}

export const loadImageTool = createLoadImageTool();

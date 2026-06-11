import { getImageRegistryFromMessages } from "../../core/message-pipeline.js";
import { resolveImageRef } from "../../core/image-registry.js";
import { writeImageNoteForStoragePath, type ImageNote, type ImageRetention } from "../../core/image-notes.js";
import type { Tool, ToolResult } from "../tool.js";

export interface ImageNoteItemInput {
  imageRef: string;
  caption?: string;
  purpose?: string;
  detectedText?: string[];
  tags?: string[];
  retention?: ImageRetention;
  ttlTurns?: number;
}

export interface ImageNoteToolInput extends Partial<ImageNoteItemInput> {
  /** Batch form. Prefer this when multiple unnamed images need notes in one annotation turn. */
  notes?: ImageNoteItemInput[];
}

export interface ImageNoteRecordOutput {
  imageRef: string;
  storagePath: string;
  note: ImageNote;
}

export interface ImageNoteToolOutput {
  recorded: ImageNoteRecordOutput[];
  failed: Array<{ imageRef: string; error: string }>;
}

export function createImageNoteTool(): Tool<ImageNoteToolInput> {
  return {
    name: "image_note",
    aliases: ["note_image", "annotate_image"],
    description:
      "Record concise semantic notes for one or more images the model has actually inspected. " +
      "Use this after seeing newly provided or loaded images when they may be referenced later. " +
      "Prefer the batch notes array when multiple unnamed images need notes. " +
      "Store factual captions, task purpose, visible text/OCR snippets, and retrieval tags. " +
      "Do not invent details or sensitive inferences.",
    inputSchema: {
      type: "object",
      properties: {
        imageRef: {
          type: "string",
          description: "Single-image compatibility form: image id, label, generated label, numeric ref, or storage-path suffix, e.g. img_1, gen#1, or screenshot.png.",
        },
        caption: {
          type: "string",
          description: "Single-image compatibility form: one factual sentence describing visible image content. Do not include uncertain or sensitive inferences.",
        },
        purpose: {
          type: "string",
          description: "Single-image compatibility form: why this image matters for the current task, based on the user request or conversation.",
        },
        detectedText: {
          type: "array",
          items: { type: "string" },
          description: "Single-image compatibility form: short visible text/OCR snippets from the image. Include only text you can actually see.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Single-image compatibility form: short retrieval tags such as ui, login, error, mockup, checkout.",
        },
        retention: {
          type: "string",
          enum: ["next_turn", "while_relevant", "pinned"],
          description: "Single-image compatibility form: decide how long this image's pixels should remain directly visible. Use next_turn for one-off, while_relevant for active multi-turn visual work, pinned only for explicit long-lived references.",
        },
        ttlTurns: {
          type: "number",
          description: "Single-image compatibility form: for while_relevant, assistant turns to keep pixels visible, 1-12.",
        },
        notes: {
          type: "array",
          description: "Batch form for recording notes for multiple images in one call.",
          items: {
            type: "object",
            properties: {
              imageRef: { type: "string", description: "Image id/label/ref to annotate." },
              caption: { type: "string", description: "One factual sentence describing visible image content." },
              purpose: { type: "string", description: "Why this image matters for the current task." },
              detectedText: { type: "array", items: { type: "string" }, description: "Visible text/OCR snippets." },
              tags: { type: "array", items: { type: "string" }, description: "Short retrieval tags." },
              retention: { type: "string", enum: ["next_turn", "while_relevant", "pinned"], description: "Pixel retention decision for this image." },
              ttlTurns: { type: "number", description: "For while_relevant, assistant turns to keep pixels visible, 1-12." },
            },
            required: ["imageRef"],
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    metadata: {
      readOnly: false,
      concurrent: false,
      visible: true,
      maxResultSizeChars: 1000,
    },
    validate(input) {
      const record = input as Partial<ImageNoteToolInput>;
      return {
        imageRef: record.imageRef,
        caption: record.caption,
        purpose: record.purpose,
        detectedText: Array.isArray(record.detectedText) ? record.detectedText : undefined,
        tags: Array.isArray(record.tags) ? record.tags : undefined,
        retention: record.retention,
        ttlTurns: record.ttlTurns,
        notes: Array.isArray(record.notes) ? record.notes.map(normalizeNoteItemInput) : undefined,
      };
    },
    validateInput(input) {
      const notes = normalizeNotes(input);
      if (notes.length === 0) return { ok: false, message: "Provide either imageRef plus note fields, or a non-empty notes array" };
      if (notes.length > 10) return { ok: false, message: "Cannot record more than 10 image notes at once" };
      for (const note of notes) {
        if (!note.imageRef.trim()) return { ok: false, message: "imageRef is required for every note" };
        const hasNote = Boolean(note.caption?.trim() || note.purpose?.trim() || note.detectedText?.length || note.tags?.length || note.retention);
        if (!hasNote) return { ok: false, message: `Provide at least one semantic field or retention decision for ${note.imageRef}` };
        if (note.detectedText && note.detectedText.some((item) => !item.trim())) return { ok: false, message: "detectedText entries must be non-empty strings" };
        if (note.tags && note.tags.some((tag) => !tag.trim())) return { ok: false, message: "tags must be non-empty strings" };
        if (note.retention && !isImageRetention(note.retention)) return { ok: false, message: "retention must be one of: next_turn, while_relevant, pinned" };
        if (note.ttlTurns !== undefined && (!Number.isFinite(note.ttlTurns) || note.ttlTurns < 1 || note.ttlTurns > 12)) return { ok: false, message: "ttlTurns must be a number from 1 to 12" };
      }
      return { ok: true, value: input };
    },
    isConcurrencySafe() {
      return false;
    },
    async call(input, context): Promise<ToolResult> {
      const registry = getImageRegistryFromMessages(context.messages ?? []);
      const recorded: ImageNoteRecordOutput[] = [];
      const failed: ImageNoteToolOutput["failed"] = [];

      for (const noteInput of normalizeNotes(input)) {
        const entry = resolveImageRef(registry, noteInput.imageRef);
        if (!entry) {
          failed.push({ imageRef: noteInput.imageRef, error: `Image not found: ${noteInput.imageRef}` });
          continue;
        }
        if (!entry.storagePath) {
          failed.push({ imageRef: noteInput.imageRef, error: `Image ${entry.id} has no stored payload path; cannot persist a note` });
          continue;
        }
        const note = await writeImageNoteForStoragePath(entry.storagePath, {
          caption: noteInput.caption,
          purpose: noteInput.purpose,
          detectedText: noteInput.detectedText,
          tags: noteInput.tags,
          retention: noteInput.retention,
          ttlTurns: noteInput.ttlTurns,
        });
        recorded.push({ imageRef: entry.id, storagePath: entry.storagePath, note });
      }

      const output: ImageNoteToolOutput = { recorded, failed };
      return {
        ok: recorded.length > 0 && failed.length === 0,
        output,
        summary: `Recorded ${recorded.length} image note(s)${failed.length ? `, ${failed.length} failed` : ""}`,
      };
    },
    renderToolResultMessage(result, request) {
      if (!request) return undefined;
      return {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
        role: "tool_result",
        createdAt: new Date().toISOString(),
        blocks: [{ type: "tool_result", toolUseId: request.id, name: request.name, ok: result.ok, output: result.output }],
      };
    },
  };
}

function normalizeNoteItemInput(value: unknown): ImageNoteItemInput {
  const record = value as Partial<ImageNoteItemInput>;
  return {
    imageRef: record.imageRef ?? "",
    caption: record.caption,
    purpose: record.purpose,
    detectedText: Array.isArray(record.detectedText) ? record.detectedText : undefined,
    tags: Array.isArray(record.tags) ? record.tags : undefined,
    retention: record.retention,
    ttlTurns: record.ttlTurns,
  };
}

function isImageRetention(value: unknown): value is ImageRetention {
  return value === "next_turn" || value === "while_relevant" || value === "pinned";
}

function normalizeNotes(input: ImageNoteToolInput): ImageNoteItemInput[] {
  if (input.notes?.length) return input.notes.map(normalizeNoteItemInput);
  if (!input.imageRef) return [];
  return [normalizeNoteItemInput(input)];
}

export const imageNoteTool = createImageNoteTool();

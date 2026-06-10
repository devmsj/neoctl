import { readImageNoteForStoragePathSync } from "./image-notes.js";

export function imageNeedsSemanticNotePrompt(block: { label?: string; storage?: { path: string; format: string } }): boolean {
  if (!block.storage?.path) return false;
  if (!isGenericImageLabel(block.label)) return false;
  const note = readImageNoteForStoragePathSync(block.storage.path);
  return !note?.caption && !note?.purpose && !note?.detectedText?.length && !note?.tags?.length;
}

export function imageSemanticNotePrompt(label?: string): string {
  const ref = label?.trim() || "this image";
  return `${ref}: unnamed image; if it matters for this task, first use image_note to record its meaning so it is not lost after context compaction.`;
}

function isGenericImageLabel(label: string | undefined): boolean {
  const value = label?.trim().toLowerCase();
  if (!value) return true;
  return /^\[?img[#_ -]?\d+\]?$/iu.test(value) || /^image\s*\d*$/iu.test(value) || /^clipboard[-_ ]?\d*$/iu.test(value);
}

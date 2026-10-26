import path from "node:path";
import type { Message } from "../types/messages.js";

export interface DisplayFileAttachment { kind: "file"; name: string; absolutePath: string; mimeType: string; size: number; url: string }
// Recover display metadata from the existing transcript, never mutate model history.
export function messageFileAttachments(message: Message): DisplayFileAttachment[] {
  if (message.role !== "user" || message.isMeta) return [];
  const text = message.blocks.filter(b => b.type === "text").map(b => b.text).join("\n");
  const files: DisplayFileAttachment[] = [];
  for (const manifest of text.matchAll(/<<ATTACHMENT_MANIFEST>>([\s\S]*?)<<\/ATTACHMENT_MANIFEST>>/gu)) {
    for (const m of manifest[1]!.matchAll(/^- file\d+: (.*)\r?\n  path: (.*)\r?\n  mimeType: (.*)\r?\n  size: (\d+) bytes/gmu)) {
      const absolutePath = m[2]!.trim();
      if (!path.isAbsolute(absolutePath)) continue;
      files.push({ kind: "file", name: m[1]!.trim(), absolutePath, mimeType: m[3]!.trim(), size: Number(m[4]), url: `/api/message-files/${encodeURIComponent(message.id)}/${files.length}` });
    }
  }
  return files;
}

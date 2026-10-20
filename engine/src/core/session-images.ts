import fs from "node:fs/promises";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import type { Message, ImageMessageBlock } from "../types/messages.js";
import { persistMessageImages, resolveImageBlockDataSync } from "./image-storage.js";
import { buildImageRegistry, resolveImageRefResult, loadImageData, type ImageEntry, type ImageRegistry } from "./image-registry.js";
import { getImageRegistryFromMessages } from "./message-pipeline.js";

/** Session-owned resource catalog. Context compaction and pixel retention never own its lifetime. */
export class SessionImageStore {
  private registry: ImageRegistry = { images: [] };
  private queue: Promise<unknown> = Promise.resolve();
  private latestImageId?: string;
  private catalogStamp?: string;
  private transactionView?: { registry: ImageRegistry; latestImageId?: string };
  private constructor(private readonly sessionDir?: string, private readonly agentId?: string) {}

  static async open(sessionDir?: string, agentId?: string): Promise<SessionImageStore> {
    const store = new SessionImageStore(sessionDir, agentId);
    if (!sessionDir) return store;
    await store.exclusive(async () => {
      if (!(await store.reload())) await store.migrateTranscript();
    });
    return store;
  }

  snapshot(): ImageRegistry {
    // Other engines can open the same session. Never resolve against a stale catalog.
    if (this.transactionView) return cloneRegistry(this.transactionView.registry);
    if (this.sessionDir) {
      const filename = path.join(this.sessionDir, "image-resources.json");
      try {
        const stat = statSync(filename);
        const stamp = `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
        if (stamp !== this.catalogStamp) {
          this.readCatalog(JSON.parse(readFileSync(filename, "utf8")));
          this.catalogStamp = stamp;
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return cloneRegistry(this.registry);
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      const release = this.sessionDir ? await this.lock() : async () => {};
      try {
        await this.reload();
        this.transactionView = { registry: this.registry, latestImageId: this.latestImageId };
        try { return await work(); }
        catch (error) {
          this.registry = this.transactionView.registry;
          this.latestImageId = this.transactionView.latestImageId;
          this.catalogStamp = undefined;
          throw error;
        }
        finally { this.transactionView = undefined; }
      } finally { await release(); }
    });
    this.queue = result.catch(() => undefined);
    return result;
  }

  latestRef(): string | undefined {
    const registry = this.snapshot();
    const latest = this.transactionView ? this.transactionView.latestImageId : this.latestImageId;
    return latest ?? registry.images.at(-1)?.imageId ?? registry.images.at(-1)?.id;
  }

  private readCatalog(saved: { version?: number; images?: ImageEntry[]; latestImageId?: string }): void {
    if (saved.version !== 1 || !Array.isArray(saved.images)) throw new Error("Invalid session image catalog");
    const aliases = new Set<string>();
    for (const entry of saved.images) {
      if (!entry || typeof entry.id !== "string" || !entry.id || aliases.has(entry.id.toLowerCase()) || typeof entry.imageId !== "string" || !entry.imageId || typeof entry.mimeType !== "string") throw new Error("Invalid session image identity or duplicate alias");
      aliases.add(entry.id.toLowerCase());
    }
    this.registry = { images: saved.images };
    this.latestImageId = saved.latestImageId;
  }

  private async reload(): Promise<boolean> {
    if (!this.sessionDir) return false;
    try {
      this.readCatalog(JSON.parse(await fs.readFile(path.join(this.sessionDir, "image-resources.json"), "utf8")));
      this.catalogStamp = undefined;
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  private async lock(): Promise<() => Promise<void>> {
    await fs.mkdir(this.sessionDir!, { recursive: true });
    const filename = path.join(this.sessionDir!, "image-resources.lock");
    const deadline = Date.now() + 15000;
    for (;;) {
      try {
        const handle = await fs.open(filename, "wx");
        try { await handle.writeFile(JSON.stringify({ pid: process.pid }), "utf8"); }
        catch (error) { await handle.close(); await fs.rm(filename, { force: true }); throw error; }
        return async () => { await handle.close(); await fs.rm(filename, { force: true }); };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        // Serialize stale-lock recovery too: two recoverers must never unlink a new writer's lock.
        const recoveryPath = `${filename}.recovery`;
        let recovery;
        try {
          recovery = await fs.open(recoveryPath, "wx");
          const owner = JSON.parse(await fs.readFile(filename, "utf8"));
          if (Number.isInteger(owner.pid) && owner.pid > 0) {
            try { process.kill(owner.pid, 0); }
            catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") await fs.rm(filename, { force: true }); }
          }
        } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; }
        finally { if (recovery) { await recovery.close(); await fs.rm(recoveryPath, { force: true }); } }
        if (Date.now() >= deadline) throw new Error("Session image catalog is locked; retry after the other writer finishes");
        await delay(25);
      }
    }
  }

  /** Compatibility for direct tool hosts with no transcript-backed catalog. */
  seedLegacyRegistry(registry: ImageRegistry): Promise<void> {
    return this.exclusive(async () => {
      if (this.registry.images.length || !registry.images.length) return;
      this.registry = { images: registry.images.map(entry => ({ ...entry, imageId: entry.imageId ?? `image_${randomUUID()}`, persistentAlias: true })) };
      this.latestImageId = this.registry.images.at(-1)?.imageId;
      await this.save();
    });
  }

  /** Commit payload + catalog before exposing the normalized message to any consumer. */
  persistMessage(message: Message, options: { touch?: boolean } = {}): Promise<Message> {
    if (!message.blocks.some(block => block.type === "image")) return Promise.resolve(message);
    return this.exclusive(async () => {
      // Restore legacy source occurrences before assigning a new resource identity.
      const sourceBlocks = message.blocks.map((block, index) => {
        if (block.type !== "image" || block.imageId) return block;
        const known = this.registry.images.find(entry => entry.sourceMessageId === message.id && entry.sourceBlockIndex === index);
        return known?.imageId ? { ...block, imageId: known.imageId } : block;
      });
      const blocks = await persistMessageImages(sourceBlocks, { sessionDir: this.sessionDir, agentId: this.agentId });
      const normalized: Message = {
        ...message,
        blocks,
        metadata: {
          ...message.metadata,
          imageRetention: message.metadata?.imageRetention ?? (message.role === "user" && !message.isMeta ? "pinned" : "while_relevant"),
          ...(message.metadata?.imageRetention ? {} : { imageTtlTurns: 4 }),
        },
      };
      const next = { images: this.registry.images.map(entry => ({ ...entry })) };
      for (const [index, block] of normalized.blocks.entries()) {
        if (block.type !== "image") continue;
        let entry = next.images.find(item => item.imageId === block.imageId);
        if (entry && entry.contentHash && entry.contentHash !== block.storage?.contentHash) {
          throw new Error(`Image identity conflict: ${block.imageId}`);
        }
        if (entry) {
          entry.storagePath = block.storage?.path;
          entry.storageFormat = block.storage?.format;
          entry.contentHash = block.storage?.contentHash;
        } else {
          entry = buildImageRegistry([{ ...normalized, blocks: [block] }]).images[0]!;
          entry.id = nextAlias(next);
          entry.persistentAlias = true;
          entry.sourceBlockIndex = index;
          next.images.push(entry);
        }
        normalized.blocks[index] = { ...block, imageAlias: entry.id };
        if (options.touch !== false || !this.latestImageId) this.latestImageId = block.imageId;
      }
      this.registry = next;
      await this.save();
      return normalized;
    });
  }

  /** Re-inspecting unchanged content from the same path reuses identity; a changed file is a new version. */
  importFile(data: string, mimeType: string, sourcePath: string, label: string): Promise<ImageMessageBlock> {
    return this.exclusive(async () => {
      const contentHash = createHash("sha256").update(Buffer.from(data, "base64")).digest("hex");
      const existing = this.registry.images.find(entry => entry.sourcePath === sourcePath && entry.contentHash === contentHash);
      if (existing && loadImageData(existing)) { this.latestImageId = existing.imageId; await this.save(); return blockFromEntry(existing); }
      const imageId = existing?.imageId ?? `image_${randomUUID()}`;
      const [block] = await persistMessageImages([{ type: "image", imageId, data, mimeType, label }], { sessionDir: this.sessionDir, agentId: this.agentId });
      if (block.type !== "image") throw new Error("Expected image payload");
      const entry = buildImageRegistry([{ id: `resource-${imageId}`, role: "user", createdAt: new Date().toISOString(), blocks: [block], isMeta: true }]).images[0]!;
      entry.id = existing?.id ?? nextAlias(this.registry);
      entry.persistentAlias = true;
      entry.origin = "tool";
      entry.sourcePath = sourcePath;
      this.latestImageId = imageId;
      this.registry = { images: existing ? this.registry.images.map(item => item === existing ? entry : item) : [...this.registry.images, entry] };
      await this.save();
      return { ...block, imageAlias: entry.id };
    });
  }

  private async save(): Promise<void> {
    if (!this.sessionDir) return;
    await fs.mkdir(this.sessionDir, { recursive: true });
    const filename = path.join(this.sessionDir, "image-resources.json");
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temporary, "wx");
      try { await handle.writeFile(JSON.stringify({ version: 1, ...this.registry, latestImageId: this.latestImageId }), "utf8"); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(temporary, filename);
      // The rename is the commit point. A later stat failure must not roll back a committed catalog.
      this.catalogStamp = undefined;
    } finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
  }

  /** Legacy migration: preserve checkpoint aliases and repair by exact source occurrence, never by label. */
  private async migrateTranscript(): Promise<void> {
    const filename = path.join(this.sessionDir!, "transcript.jsonl");
    try { await fs.access(filename); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const sources = new Map<string, ImageEntry>();
    let boundary: ImageRegistry = { images: [] };
    const lines = createInterface({ input: createReadStream(filename, { encoding: "utf8" }), crlfDelay: Infinity });
    let interruptedLine = false;
    for await (const line of lines) {
      if (!line.trim()) continue;
      if (interruptedLine) throw new Error("Corrupt session transcript: invalid JSON before the final record");
      let record;
      try { record = JSON.parse(line); } catch { interruptedLine = true; continue; }
      if (record.type === "message" && record.message) {
        const message = record.message as Message;
        // Old inline-only transcripts also need durable payloads; existing stored files stay read-only.
        const blocks = await Promise.all(message.blocks.map(async block => block.type === "image" && !block.storage?.path && block.data
          ? (await persistMessageImages([block], { sessionDir: this.sessionDir, agentId: this.agentId }))[0]
          : block));
        for (const entry of buildImageRegistry([{ ...message, blocks }]).images) sources.set(occurrenceKey(entry), entry);
      }
      if (record.type === "compact" && Array.isArray(record.replacementMessages)) {
        const checkpoint = record.replacementMessages.find((message: Message) => message.metadata?.imageRegistry)?.metadata?.imageRegistry;
        if (checkpoint?.images) boundary = checkpoint;
      }
    }
    const images = boundary.images.map(entry => {
      const original = sources.get(occurrenceKey(entry));
      return original ? { ...entry, imageId: original.imageId ?? entry.imageId, storagePath: original.storagePath ?? entry.storagePath, storageFormat: original.storageFormat ?? entry.storageFormat, contentHash: original.contentHash ?? entry.contentHash } : { ...entry };
    });
    const covered = new Set(images.map(occurrenceKey));
    // Also recover sources omitted by a broken checkpoint, after reserving every historical alias.
    for (const entry of sources.values()) {
      if (covered.has(occurrenceKey(entry))) continue;
      const identity = entry.imageId && images.find(image => image.imageId === entry.imageId);
      if (identity) continue;
      const id = entry.persistentAlias ? entry.id : nextAlias({ images });
      if (images.some(image => image.id === id)) throw new Error(`Conflicting historical image alias: ${id}`);
      images.push({ ...entry, id });
      covered.add(occurrenceKey(entry));
    }
    this.registry = { images: images.map(entry => ({ ...entry, imageId: entry.imageId ?? `image_${randomUUID()}`, persistentAlias: true })) };
    const latestSource = [...sources.values()].at(-1);
    this.latestImageId = this.registry.images.find(entry => latestSource && occurrenceKey(entry) === occurrenceKey(latestSource))?.imageId ?? this.registry.images.at(-1)?.imageId;
    await this.save();
  }
}

function cloneRegistry(registry: ImageRegistry): ImageRegistry { return { images: registry.images.map(entry => ({ ...entry })) }; }

function occurrenceKey(entry: ImageEntry): string { return `${entry.sourceMessageId}:${entry.sourceBlockIndex ?? 0}`; }
function nextAlias(registry: ImageRegistry): string {
  return `img_${registry.images.reduce((max, entry) => Math.max(max, Number(/^img_(\d+)$/.exec(entry.id)?.[1] ?? 0)), 0) + 1}`;
}

export function blockFromEntry(entry: ImageEntry): ImageMessageBlock {
  return { type: "image", imageId: entry.imageId, imageAlias: entry.id, mimeType: entry.mimeType, label: entry.label, data: "", storage: entry.storagePath ? { path: entry.storagePath, format: entry.storageFormat ?? "base64", contentHash: entry.contentHash } : undefined };
}

export function imageRegistryForContext(context: { imageStore?: SessionImageStore; messages?: readonly Message[] }): ImageRegistry {
  return context.imageStore?.snapshot() ?? getImageRegistryFromMessages(context.messages ?? []);
}

/** One reference grammar and one payload path shared by inspect, edit and notes. */
export function resolveContextImage(context: { imageStore?: SessionImageStore; messages?: readonly Message[] }, ref: string): { entry: ImageEntry; data: string } {
  const registry = imageRegistryForContext(context);
  const resolution = resolveImageRefResult(registry, ref);
  if (resolution.status === "not-found") throw new Error(`Unknown image reference: ${ref}. Available imageRefs: ${registry.images.slice(-10).map(entry => entry.id).join(", ") || "none"}. Use image_inspect mode=list to discover session images.`);
  if (resolution.status === "ambiguous") throw new Error(`Image reference is ambiguous: ${ref}. Use one of: ${resolution.candidates.map(entry => entry.imageId ?? entry.id).join(", ")}`);
  const entry = resolution.entry;
  let data = loadImageData(entry);
  if (!data && !entry.storagePath) {
    for (const message of context.messages ?? []) {
      for (const [index, block] of message.blocks.entries()) {
        if (block.type === "image" && (entry.imageId ? block.imageId === entry.imageId : message.id === entry.sourceMessageId && index === entry.sourceBlockIndex)) data = resolveImageBlockDataSync(block);
      }
    }
  }
  if (!data) throw new Error(`Image payload unavailable: ${ref} (reference exists; payload missing, unreadable or corrupt). Re-import the original file; do not substitute another image.`);
  return { entry, data };
}

// Direct tool hosts may omit the query-owned store. Share initialization per host context,
// including concurrent calls, without a global cross-session singleton.
const contextStores = new WeakMap<object, Promise<SessionImageStore>>();
export function getContextImageStore(context: { imageStore?: SessionImageStore; session?: { sessionDir: string }; agentId?: string; messages?: readonly Message[] }): Promise<SessionImageStore> {
  if (context.imageStore) return Promise.resolve(context.imageStore);
  let pending = contextStores.get(context);
  if (!pending) {
    pending = (async () => {
      const store = await SessionImageStore.open(context.session?.sessionDir, context.agentId);
      await store.seedLegacyRegistry(getImageRegistryFromMessages(context.messages ?? []));
      const messages: Message[] = [];
      for (const message of context.messages ?? []) messages.push(await store.persistMessage(message, { touch: false }));
      context.messages = messages;
      context.imageStore = store;
      return store;
    })();
    contextStores.set(context, pending);
    void pending.catch(() => contextStores.delete(context));
  }
  return pending;
}

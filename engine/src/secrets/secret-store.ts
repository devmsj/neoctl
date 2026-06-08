import fs from "node:fs/promises";
import path from "node:path";
import { getNeoctlHome } from "../paths.js";
import { createDefaultKdf, decryptSecret, deriveSecretKey, encryptSecret, type SecretKdfConfig } from "./secret-crypto.js";
import { SecretEmptyError, SecretNotFoundError, type SecretMetadata, type SecretResolver } from "./secret-types.js";

interface StoredSecretBase extends SecretMetadata {
  ciphertext?: string;
  iv?: string;
  tag?: string;
}

interface SecretFile {
  version: 1;
  kdf: SecretKdfConfig;
  items: Record<string, StoredSecretBase>;
}

export interface SecretStoreOptions {
  filePath?: string;
  passphrase?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function validateKey(key: string): string {
  const trimmed = key.trim();
  if (!/^[A-Za-z0-9_.:@/-]{1,128}$/.test(trimmed)) {
    throw new Error("Secret key must be 1-128 chars and contain only letters, numbers, _, -, ., :, @, or /.");
  }
  return trimmed;
}

function metadata(entry: StoredSecretBase): SecretMetadata {
  return {
    key: entry.key,
    status: entry.status,
    length: entry.length,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    requestedBy: entry.requestedBy,
    requestReason: entry.requestReason,
  };
}

export class SecretStore implements SecretResolver {
  private constructor(
    private readonly filePath: string,
    private readonly passphrase: string | undefined,
    private file: SecretFile,
  ) {}

  static async open(options: SecretStoreOptions = {}): Promise<SecretStore> {
    const filePath = options.filePath ?? path.join(getNeoctlHome(), "secrets.json");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    let file: SecretFile | undefined;
    try {
      const raw = await fs.readFile(filePath, "utf8");
      file = JSON.parse(raw) as SecretFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    file ??= { version: 1, kdf: createDefaultKdf(), items: {} };
    return new SecretStore(filePath, options.passphrase, file);
  }

  async list(): Promise<SecretMetadata[]> {
    return Object.values(this.file.items).map(metadata).sort((a, b) => a.key.localeCompare(b.key));
  }

  async info(key: string): Promise<SecretMetadata | undefined> {
    const entry = this.file.items[validateKey(key)];
    return entry ? metadata(entry) : undefined;
  }

  async requestEmpty(key: string, options: { reason?: string; requestedBy?: "agent" | "user" } = {}): Promise<SecretMetadata> {
    const normalized = validateKey(key);
    const existing = this.file.items[normalized];
    if (existing) {
      if (options.reason && !existing.requestReason) existing.requestReason = options.reason;
      existing.requestedBy ??= options.requestedBy;
      existing.updatedAt = nowIso();
      await this.save();
      return metadata(existing);
    }
    const timestamp = nowIso();
    const entry: StoredSecretBase = {
      key: normalized,
      status: "empty",
      length: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      requestedBy: options.requestedBy,
      requestReason: options.reason,
    };
    this.file.items[normalized] = entry;
    await this.save();
    return metadata(entry);
  }

  async getPlaintext(key: string): Promise<string> {
    const entry = this.requireEntry(key);
    if (entry.status === "empty") return "";
    return this.decryptEntry(entry);
  }

  async setPlaintext(key: string, value: string): Promise<SecretMetadata> {
    const normalized = validateKey(key);
    const timestamp = nowIso();
    const existing = this.file.items[normalized];
    const encrypted = encryptSecret(value, this.key());
    const entry: StoredSecretBase = {
      key: normalized,
      status: "set",
      length: value.length,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      requestedBy: existing?.requestedBy,
      requestReason: existing?.requestReason,
      ...encrypted,
    };
    this.file.items[normalized] = entry;
    await this.save();
    return metadata(entry);
  }

  async delete(key: string): Promise<boolean> {
    const normalized = validateKey(key);
    const existed = Boolean(this.file.items[normalized]);
    delete this.file.items[normalized];
    if (existed) await this.save();
    return existed;
  }

  async rename(oldKey: string, newKey: string): Promise<SecretMetadata> {
    const oldNormalized = validateKey(oldKey);
    const newNormalized = validateKey(newKey);
    if (this.file.items[newNormalized]) throw new Error(`Secret "${newNormalized}" already exists.`);
    const entry = this.requireEntry(oldNormalized);
    delete this.file.items[oldNormalized];
    const renamed = { ...entry, key: newNormalized, updatedAt: nowIso() };
    this.file.items[newNormalized] = renamed;
    await this.save();
    return metadata(renamed);
  }

  async resolve(key: string): Promise<string> {
    return this.resolveForTool(key);
  }

  async resolveForTool(key: string): Promise<string> {
    const entry = this.requireEntry(key);
    if (entry.status === "empty") throw new SecretEmptyError(entry.key);
    return this.decryptEntry(entry);
  }

  private requireEntry(key: string): StoredSecretBase {
    const normalized = validateKey(key);
    const entry = this.file.items[normalized];
    if (!entry) throw new SecretNotFoundError(normalized);
    return entry;
  }

  private decryptEntry(entry: StoredSecretBase): string {
    if (!entry.ciphertext || !entry.iv || !entry.tag) throw new SecretEmptyError(entry.key);
    return decryptSecret({ ciphertext: entry.ciphertext, iv: entry.iv, tag: entry.tag }, this.key());
  }

  private key(): Buffer {
    return deriveSecretKey({ kdf: this.file.kdf, passphrase: this.passphrase });
  }

  private async save(): Promise<void> {
    const tmp = `${this.filePath}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(this.file, null, 2)}\n`, "utf8");
    await fs.rename(tmp, this.filePath);
  }
}

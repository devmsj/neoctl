import fs from "node:fs/promises";
import path from "node:path";
import {
  normalizeSkillDescriptor,
  requireSkillName,
  type MutableSkillCatalog,
  type SkillCatalog,
  type SkillDescriptor,
  type SkillSourceInfo,
  type SkillUpdatePatch,
  type SkillWriteOptions,
} from "./skill-tool.js";

const SKILL_FILE_NAME = "SKILL.md";

export interface FileSystemSkillCatalogOptions {
  roots: readonly SkillRoot[];
  createRoot?: string;
}

export interface SkillRoot {
  root: string;
  kind?: SkillSourceInfo["kind"];
  plugin?: string;
  readonly?: boolean;
}

interface SkillLocation {
  root: SkillRoot;
  directory: string;
  file: string;
}

export class FileSystemSkillCatalog implements MutableSkillCatalog {
  private readonly roots: SkillRoot[];
  private readonly createRoot: string;

  constructor(options: FileSystemSkillCatalogOptions | readonly string[]) {
    if (isRootList(options)) {
      this.roots = options.map((root) => ({ root, kind: "filesystem" as const }));
      if (this.roots.length === 0) throw new Error("FileSystemSkillCatalog requires at least one root");
      this.createRoot = path.resolve(this.roots[0].root);
      return;
    }

    this.roots = options.roots.map((root) => ({ ...root }));
    if (this.roots.length === 0) throw new Error("FileSystemSkillCatalog requires at least one root");
    this.createRoot = path.resolve(options.createRoot ?? firstWritableRoot(this.roots).root);
  }

  async list(): Promise<SkillDescriptor[]> {
    const byName = new Map<string, SkillDescriptor>();
    for (const root of this.roots) {
      for (const location of await discoverSkillLocations(root)) {
        try {
          const skill = await readSkillFromLocation(location);
          if (skill.enabled === false) continue;
          if (!byName.has(skill.name)) byName.set(skill.name, skill);
        } catch {
          // Invalid plugin skills should not break the whole catalog. Use read/validate tooling for diagnostics.
        }
      }
    }
    return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  async get(name: string): Promise<SkillDescriptor | undefined> {
    const normalized = requireSkillName(name);
    for (const root of this.roots) {
      const direct = await readIfExists({ root, directory: path.join(path.resolve(root.root), normalized), file: path.join(path.resolve(root.root), normalized, SKILL_FILE_NAME) });
      if (direct) return direct;
      for (const location of await discoverSkillLocations(root)) {
        const skill = await readIfExists(location);
        if (skill?.name === normalized) return skill;
      }
    }
    return undefined;
  }

  async create(skill: SkillDescriptor, options: SkillWriteOptions = {}): Promise<SkillDescriptor> {
    const normalized = normalizeSkillDescriptor(skill, { requireEntrypoint: true });
    const root = this.resolveCreateRoot();
    const directory = path.join(root.root, normalized.name);
    const file = path.join(directory, SKILL_FILE_NAME);
    const exists = await pathExists(file);
    if (exists && !options.overwrite) throw new Error(`Skill already exists: ${normalized.name}`);
    await fs.mkdir(directory, { recursive: true });
    const now = new Date().toISOString();
    const stored = normalizeSkillDescriptor({
      ...normalized,
      source: sourceForLocation({ root, directory, file }),
      createdAt: normalized.createdAt ?? now,
      updatedAt: now,
    });
    await fs.writeFile(file, serializeSkillMarkdown(stored), "utf8");
    return stored;
  }

  async update(name: string, patch: SkillUpdatePatch): Promise<SkillDescriptor> {
    const normalizedName = requireSkillName(name);
    const location = await this.findWritableLocation(normalizedName);
    if (!location) throw new Error(`Unknown writable skill: ${normalizedName}`);
    const current = await readSkillFromLocation(location);
    const updated = normalizeSkillDescriptor({
      ...current,
      ...patch,
      name: normalizedName,
      source: current.source,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    });
    await fs.writeFile(location.file, serializeSkillMarkdown(updated), "utf8");
    return updated;
  }

  async delete(name: string): Promise<boolean> {
    const location = await this.findWritableLocation(requireSkillName(name));
    if (!location) return false;
    await fs.rm(location.directory, { recursive: true, force: true });
    return true;
  }

  private resolveCreateRoot(): SkillRoot {
    const root = this.roots.find((candidate) => path.resolve(candidate.root) === this.createRoot);
    if (!root) return { root: this.createRoot, kind: "filesystem" };
    if (root.readonly) throw new Error(`Skill root is readonly: ${root.root}`);
    return { ...root, root: path.resolve(root.root) };
  }

  private async findWritableLocation(name: string): Promise<SkillLocation | undefined> {
    for (const root of this.roots) {
      if (root.readonly) continue;
      const file = path.join(path.resolve(root.root), name, SKILL_FILE_NAME);
      if (await pathExists(file)) return { root: { ...root, root: path.resolve(root.root) }, directory: path.dirname(file), file };
    }
    return undefined;
  }
}

export class CompositeSkillCatalog implements SkillCatalog {
  constructor(private readonly catalogs: readonly SkillCatalog[]) {}

  async list(): Promise<SkillDescriptor[]> {
    const byName = new Map<string, SkillDescriptor>();
    for (const catalog of this.catalogs) {
      for (const skill of await catalog.list()) if (!byName.has(skill.name)) byName.set(skill.name, skill);
    }
    return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  async get(name: string): Promise<SkillDescriptor | undefined> {
    for (const catalog of this.catalogs) {
      const skill = await catalog.get(name);
      if (skill) return skill;
    }
    return undefined;
  }
}

export async function loadSkillFromMarkdownFile(file: string, root?: SkillRoot): Promise<SkillDescriptor> {
  const resolvedFile = path.resolve(file);
  return readSkillFromLocation({
    root: root ? { ...root, root: path.resolve(root.root) } : { root: path.dirname(path.dirname(resolvedFile)), kind: "filesystem" },
    directory: path.dirname(resolvedFile),
    file: resolvedFile,
  });
}

export function parseSkillMarkdown(markdown: string, fallbackName?: string): SkillDescriptor {
  const { frontmatter, body } = parseFrontmatter(markdown);
  const name = stringValue(frontmatter.name) ?? fallbackName;
  const descriptor: SkillDescriptor = {
    name: requireSkillName(name),
    title: stringValue(frontmatter.title),
    description: stringValue(frontmatter.description) ?? firstBodyLine(body) ?? requireSkillName(name),
    version: stringValue(frontmatter.version),
    entrypoint: body.trim(),
    execution: executionValue(frontmatter.execution) ?? "inline",
    allowedTools: stringListValue(frontmatter["allowed-tools"] ?? frontmatter.allowedTools),
    model: stringValue(frontmatter.model),
    effort: effortValue(frontmatter.effort ?? frontmatter["reasoning-effort"]),
    disableModelInvocation: booleanValue(frontmatter.disableModelInvocation ?? frontmatter["disable-model-invocation"]),
    tags: stringListValue(frontmatter.tags),
    argumentHint: stringValue(frontmatter["argument-hint"] ?? frontmatter.argumentHint),
    enabled: booleanValue(frontmatter.enabled) ?? true,
    trustLevel: trustLevelValue(frontmatter.trustLevel ?? frontmatter["trust-level"]),
    metadata: recordValue(frontmatter.metadata),
  };
  return normalizeSkillDescriptor(descriptor, { requireEntrypoint: true });
}

export function serializeSkillMarkdown(skill: SkillDescriptor): string {
  const frontmatter: Record<string, unknown> = {
    name: skill.name,
    title: skill.title,
    description: skill.description,
    version: skill.version,
    execution: skill.execution,
    "allowed-tools": skill.allowedTools,
    model: skill.model,
    effort: skill.effort,
    tags: skill.tags,
    "argument-hint": skill.argumentHint,
    enabled: skill.enabled,
    "trust-level": skill.trustLevel,
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
    metadata: skill.metadata,
  };
  return `---\n${serializeFrontmatter(frontmatter)}---\n\n${skill.entrypoint.trim()}\n`;
}

async function discoverSkillLocations(root: SkillRoot): Promise<SkillLocation[]> {
  const resolvedRoot = path.resolve(root.root);
  if (!(await pathExists(resolvedRoot))) return [];
  const entries = await fs.readdir(resolvedRoot, { withFileTypes: true });
  const locations: SkillLocation[] = [];
  const normalizedRoot = { ...root, root: resolvedRoot };
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const directory = path.join(resolvedRoot, entry.name);
    const file = path.join(directory, SKILL_FILE_NAME);
    if (await pathExists(file)) locations.push({ root: normalizedRoot, directory, file });
  }
  return locations;
}

async function readIfExists(location: SkillLocation): Promise<SkillDescriptor | undefined> {
  try {
    return await readSkillFromLocation(location);
  } catch {
    return undefined;
  }
}

async function readSkillFromLocation(location: SkillLocation): Promise<SkillDescriptor> {
  const raw = await fs.readFile(location.file, "utf8");
  const fallbackName = path.basename(location.directory);
  const parsed = parseSkillMarkdown(raw, fallbackName);
  return normalizeSkillDescriptor({
    ...parsed,
    source: sourceForLocation(location),
  });
}

function sourceForLocation(location: SkillLocation): SkillSourceInfo {
  return {
    kind: location.root.kind ?? "filesystem",
    root: path.resolve(location.root.root),
    path: location.file,
    plugin: location.root.plugin,
  };
}

function parseFrontmatter(markdown: string): { frontmatter: Record<string, unknown>; body: string } {
  if (!markdown.startsWith("---")) return { frontmatter: {}, body: markdown };
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(markdown);
  if (!match) return { frontmatter: {}, body: markdown };
  return { frontmatter: parseYamlLikeFrontmatter(match[1]), body: match[2] };
}

function parseYamlLikeFrontmatter(raw: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = raw.split(/\r?\n/);
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    index += 1;
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    const rest = match[2].trim();
    if (!rest) {
      const list: string[] = [];
      while (index < lines.length) {
        const child = lines[index];
        const listMatch = /^\s*-\s*(.*)$/.exec(child);
        if (!listMatch) break;
        list.push(unquote(listMatch[1].trim()));
        index += 1;
      }
      result[key] = list.length ? list : "";
      continue;
    }
    result[key] = parseScalar(rest);
  }
  return result;
}

function serializeFrontmatter(frontmatter: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === undefined || value === null || value === "" || Array.isArray(value) && value.length === 0) continue;
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${quoteIfNeeded(String(item))}`);
      continue;
    }
    if (typeof value === "object") {
      lines.push(`${key}: ${JSON.stringify(value)}`);
      continue;
    }
    lines.push(`${key}: ${quoteIfNeeded(String(value))}`);
  }
  return `${lines.join("\n")}\n`;
}

function parseScalar(value: string): unknown {
  const unquoted = unquote(value);
  if (unquoted === "true") return true;
  if (unquoted === "false") return false;
  if (value.startsWith("[") || value.startsWith("{")) {
    try {
      return JSON.parse(value);
    } catch {
      return unquoted;
    }
  }
  if (value.includes(",")) return value.split(",").map((item) => unquote(item.trim())).filter(Boolean);
  return unquoted;
}

function isRootList(options: FileSystemSkillCatalogOptions | readonly string[]): options is readonly string[] {
  return Array.isArray(options);
}

function firstWritableRoot(roots: readonly SkillRoot[]): SkillRoot {
  const root = roots.find((candidate) => !candidate.readonly);
  if (!root) throw new Error("FileSystemSkillCatalog requires at least one writable root for create operations");
  return root;
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function stringListValue(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return undefined;
}

function executionValue(value: unknown): "inline" | "fork" | undefined {
  return value === "inline" || value === "fork" ? value : undefined;
}

function effortValue(value: unknown): SkillDescriptor["effort"] {
  return value === "minimal" || value === "low" || value === "medium" || value === "high" ? value : undefined;
}

function trustLevelValue(value: unknown): SkillDescriptor["trustLevel"] {
  return value === "builtin" || value === "workspace" || value === "user" || value === "plugin" || value === "generated" || value === "remote" ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function firstBodyLine(body: string): string | undefined {
  return body.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1).replace(/\\"/g, '"');
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replace(/\\'/g, "'");
  return trimmed;
}

function quoteIfNeeded(value: string): string {
  if (/^[A-Za-z0-9_.\-/]+$/.test(value)) return value;
  return JSON.stringify(value);
}

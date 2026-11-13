import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isReasoningEffort, type ReasoningEffort } from "./model-gateway.js";
import { modelSettingsHome, atomicJson, locked } from "./settings-files.js";

export interface ModelMetadata {
  id: string;
  provider: string;
  protocols?: Array<"openai" | "anthropic">;
  modelIds: string[];
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  knowledgeCutoff?: string;
  reasoning?: boolean;
  reasoningEfforts?: ReasoningEffort[];
  imageInput?: boolean;
  source?: string;
  notes?: string;
}

export interface ModelCatalog {
  revision?: string;
  /** User removals survive bundled-data upgrades and reinstalls. */
  excludedModelIds?: string[];
  removedModelIds?: string[];
  appliedMigrations?: string[];
  updatedAt?: string;
  notes?: string[];
  sources?: Record<string, string>;
  models: ModelMetadata[];
}

export interface ContextWindowInfo {
  tokens?: number;
  source: "env" | "known" | "unknown";
  model?: ModelMetadata;
  catalogUpdatedAt?: string;
}

let cachedCatalog: ModelCatalog | undefined;
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

export function resolveContextWindowTokens(model: string | undefined, env: NodeJS.ProcessEnv = process.env): ContextWindowInfo {
  const override = parsePositiveInteger(env.MODEL_CONTEXT_WINDOW_TOKENS ?? env.OPENAI_CONTEXT_WINDOW_TOKENS);
  if (override) return { tokens: override, source: "env" };
  if (!model) return { source: "unknown", catalogUpdatedAt: loadModelCatalog().updatedAt };

  const catalog = loadModelCatalog();
  const metadata = findModelMetadata(model, catalog);
  if (!metadata?.contextWindowTokens) return { source: "unknown", catalogUpdatedAt: catalog.updatedAt };

  return {
    tokens: metadata.contextWindowTokens,
    source: "known",
    model: metadata,
    catalogUpdatedAt: catalog.updatedAt,
  };
}

export function findModelMetadata(model: string, catalog: ModelCatalog = loadModelCatalog()): ModelMetadata | undefined {
  const requestedModel = normalizeModelId(model);
  return catalog.models.find((entry) => normalizeModelId(entry.id) === requestedModel || entry.modelIds.some((modelId) => normalizeModelId(modelId) === requestedModel));
}

export function modelProtocols(model: ModelMetadata): Array<"openai" | "anthropic"> {
  // Migration only: preserve legacy provider classification until explicitly edited.
  return model.protocols ?? [model.provider === "anthropic" ? "anthropic" : "openai"];
}

export function supportsImageInput(model: string | undefined, catalog: ModelCatalog = loadModelCatalog()): boolean | undefined {
  if (!model) return undefined;
  return findModelMetadata(model, catalog)?.imageInput;
}

export function reasoningEffortsForModel(model: string | undefined, catalog: ModelCatalog = loadModelCatalog()): ReasoningEffort[] | undefined {
  if (!model) return undefined;
  const metadata = findModelMetadata(model, catalog);
  if (!metadata) return undefined;
  return metadata.reasoningEfforts ?? (metadata.reasoning ? [] : undefined);
}

export function supportsReasoningEffort(model: string | undefined, effort: ReasoningEffort, catalog: ModelCatalog = loadModelCatalog()): boolean | undefined {
  const efforts = reasoningEffortsForModel(model, catalog);
  if (!efforts) return undefined;
  return efforts.includes(effort);
}

export function loadModelCatalog(): ModelCatalog {
  const file = path.join(modelSettingsHome(), "model-metadata.json");
  if (!initializedFiles.has(file)) {
    const bundled = JSON.parse(readFileSync(findModelCatalogFile(), "utf8")) as ModelCatalog;
    locked(file, () => {
      const catalog = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as ModelCatalog : structuredClone(bundled);
      validateModelCatalog(catalog);
      const before = JSON.stringify(catalog);
      let changed = !existsSync(file);
      // New bundled entries may reference new sources; preserve user-owned values.
      for (const [key, url] of Object.entries(bundled.sources ?? {})) {
        if (!Object.hasOwn(catalog.sources ?? {}, key)) {
          (catalog.sources ??= {})[key] = url;
          changed = true;
        }
      }
      for (const entry of bundled.models) if (!catalog.models.some(m => normalizeModelId(m.id) === normalizeModelId(entry.id)) && !catalog.excludedModelIds?.some(id => normalizeModelId(id) === normalizeModelId(entry.id))) {
        // Preserve user-owned aliases when a later bundled entry is introduced.
        const aliases = new Set(catalog.models.flatMap(m => [m.id, ...m.modelIds].map(normalizeModelId)));
        if (aliases.has(normalizeModelId(entry.id))) continue;
        const modelIds = entry.modelIds.filter(id => !aliases.has(normalizeModelId(id)) && !catalog.removedModelIds?.some(removed => normalizeModelId(removed) === normalizeModelId(id)));
        if (modelIds.length) catalog.models.push({ ...entry, modelIds });
        changed = true;
      }
      // One-time upgrade of the old bundled ceiling; preserve custom limits and explicit edits.
      const migration = "claude-context-512k";
      if (!catalog.appliedMigrations?.includes(migration)) {
        for (const entry of bundled.models) {
          if (entry.provider !== "anthropic" || entry.contextWindowTokens !== 512_000) continue;
          const existing = catalog.models.find(m => normalizeModelId(m.id) === normalizeModelId(entry.id));
          if (catalog.excludedModelIds?.some(id => normalizeModelId(id) === normalizeModelId(entry.id))) continue;
          if (existing?.provider === "anthropic" && existing.contextWindowTokens === 256_000) {
            existing.contextWindowTokens = entry.contextWindowTokens;
          }
        }
        (catalog.appliedMigrations ??= []).push(migration);
        changed = true;
      }
      catalog.models.sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
      validateModelCatalog(catalog);
      if (changed || JSON.stringify(catalog) !== before || !catalog.revision) { catalog.revision = randomUUID(); atomicJson(file, catalog); }
    });
    initializedFiles.add(file);
  }
  // Read the small file on access: other CLI/Web processes observe saves immediately.
  const raw = readFileSync(file, "utf8");
  if (cachedSource !== file + raw) { const parsed = JSON.parse(raw) as ModelCatalog; validateModelCatalog(parsed); cachedCatalog = parsed; cachedSource = file + raw; }
  return cachedCatalog!;
}
const initializedFiles = new Set<string>();
let cachedSource = "";
export function validateModelCatalog(catalog: ModelCatalog): void {
  if (!catalog || !Array.isArray(catalog.models)) throw new Error("模型元数据格式无效。");
  for (const key of ["excludedModelIds", "removedModelIds", "appliedMigrations"] as const) if (catalog[key] !== undefined && (!Array.isArray(catalog[key]) || catalog[key]!.some(id => typeof id !== "string" || !id.trim()))) throw new Error("模型删除记录无效。");
  const owners = new Map<string, ModelMetadata>();
  for (const m of catalog.models) {
    for (const id of [m?.id, ...(Array.isArray(m?.modelIds) ? m.modelIds : [])]) {
      if (typeof id !== "string") continue;
      const key = normalizeModelId(id), owner = owners.get(key);
      if (owner && owner !== m) throw new Error("模型 ID 或别名重复，已被其他条目使用。");
      owners.set(key, m);
    }
  }
  const ids = new Set<string>(), aliases = new Set<string>();
  for (const m of catalog.models) {
    if (!m || typeof m.id !== "string" || !m.id.trim() || ids.has(normalizeModelId(m.id))) throw new Error("模型 ID 为空或重复。");
    ids.add(normalizeModelId(m.id));
    if (m.protocols !== undefined && (!Array.isArray(m.protocols) || !m.protocols.length || m.protocols.some(p => !["openai", "anthropic"].includes(p)) || new Set(m.protocols).size !== m.protocols.length)) throw new Error("模型兼容接口无效。");
    if (typeof m.provider !== "string" || !Array.isArray(m.modelIds) || !m.modelIds.length) throw new Error("模型缺少供应商或别名。");
    for (const alias of m.modelIds) { if (typeof alias !== "string" || !alias.trim() || aliases.has(alias.trim().toLowerCase())) throw new Error("模型别名为空或重复。"); aliases.add(alias.trim().toLowerCase()); }
    for (const key of ["contextWindowTokens", "maxOutputTokens"] as const) if (m[key] !== undefined && (!Number.isSafeInteger(m[key]) || m[key]! <= 0)) throw new Error("模型 Token 限制须为正整数。");
    for (const key of ["reasoning", "imageInput"] as const) if (m[key] !== undefined && typeof m[key] !== "boolean") throw new Error("模型能力须为布尔值。");
    if (m.reasoningEfforts !== undefined && (!Array.isArray(m.reasoningEfforts) || m.reasoningEfforts.some(v => !isReasoningEffort(v)) || new Set(m.reasoningEfforts).size !== m.reasoningEfforts.length)) throw new Error("推理档位无效。");
  }
}
export class ModelMetadataConflict extends Error {
  readonly status = 409;
}
export function modelMetadataIds(entry: ModelMetadata): string[] {
  return [...new Set([entry.id, ...entry.modelIds].map(normalizeModelId))];
}
/** Unknown custom models remain supported; explicitly removed IDs cannot bypass validation. */
export function assertModelNotRemoved(model: string, catalog = loadModelCatalog()): void {
  if (!findModelMetadata(model, catalog) && catalog.removedModelIds?.some(id => normalizeModelId(id) === normalizeModelId(model))) {
    throw new Error(`模型 ${model} 已被删除或移除别名，请重新选择模型。`);
  }
}
function checkRevision(catalog: ModelCatalog, revision?: string): void {
  if (revision !== undefined && catalog.revision !== revision) throw new ModelMetadataConflict("模型库已更新，请重新加载后操作。");
}
function originalIndex(catalog: ModelCatalog, original: ModelMetadata): number {
  const index = catalog.models.findIndex(m => normalizeModelId(m.id) === normalizeModelId(original.id));
  if (index < 0) throw new ModelMetadataConflict("模型条目已不存在，请重新加载。");
  if (JSON.stringify(catalog.models[index]) !== JSON.stringify(original)) throw new ModelMetadataConflict("模型条目已更新，请重新加载后操作。");
  return index;
}
function suppress(catalog: ModelCatalog, entry: ModelMetadata, removed: string[]): void {
  catalog.excludedModelIds = [...new Set([...(catalog.excludedModelIds ?? []), normalizeModelId(entry.id)])];
  catalog.removedModelIds = [...new Set([...(catalog.removedModelIds ?? []), ...removed])];
}
function commitCatalog(file: string, catalog: ModelCatalog): ModelCatalog {
  validateModelCatalog(catalog);
  catalog.models.sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
  catalog.revision = randomUUID();
  atomicJson(file, catalog); cachedSource = "";
  return catalog;
}
export function saveModelMetadata(entry: ModelMetadata, original?: ModelMetadata, revision?: string): ModelCatalog {
  loadModelCatalog();
  const file = path.join(modelSettingsHome(), "model-metadata.json");
  return locked(file, () => {
    const catalog = JSON.parse(readFileSync(file, "utf8")) as ModelCatalog;
    checkRevision(catalog, revision);
    entry = structuredClone(entry);
    if (typeof entry?.id === "string") entry.id = entry.id.trim();
    if (original) {
      const index = originalIndex(catalog, original);
      const retained = new Set(modelMetadataIds(entry));
      suppress(catalog, original, modelMetadataIds(original).filter(id => !retained.has(id)));
      catalog.models[index] = entry;
    } else {
      if (catalog.models.some(m => normalizeModelId(m.id) === normalizeModelId(entry.id))) throw new ModelMetadataConflict("模型 ID 已存在，请重新加载。");
      catalog.models.push(entry);
    }
    // Explicit recreation restores use, without letting bundled initialization resurrect removals.
    const restored = new Set(modelMetadataIds(entry));
    catalog.removedModelIds = catalog.removedModelIds?.filter(id => !restored.has(normalizeModelId(id)));
    return commitCatalog(file, catalog);
  });
}
export function deleteModelMetadata(original: ModelMetadata, revision?: string, beforeCommit?: () => void): ModelCatalog {
  loadModelCatalog();
  const file = path.join(modelSettingsHome(), "model-metadata.json");
  return locked(file, () => {
    const catalog = JSON.parse(readFileSync(file, "utf8")) as ModelCatalog;
    checkRevision(catalog, revision);
    if (!original || typeof original.id !== "string") throw new Error("请选择要删除的模型。");
    const index = originalIndex(catalog, original);
    suppress(catalog, catalog.models[index]!, modelMetadataIds(catalog.models[index]!));
    catalog.models.splice(index, 1);
    validateModelCatalog(catalog);
    beforeCommit?.();
    return commitCatalog(file, catalog);
  });
}

function findModelCatalogFile(): string {
  const candidates = [
    path.join(moduleDir, "model-metadata.json"),
    path.join(process.cwd(), "dist", "model", "model-metadata.json"),
    path.join(process.cwd(), "src", "model", "model-metadata.json"),
    path.join(path.dirname(process.execPath), "dist", "model", "model-metadata.json"),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`model-metadata.json not found in: ${candidates.join(", ")}`);
  return found;
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function normalizeModelId(model: string): string {
  return model.trim().toLowerCase();
}

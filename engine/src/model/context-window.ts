import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ReasoningEffort } from "./model-gateway.js";

export interface ModelMetadata {
  id: string;
  provider: string;
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
  return catalog.models.find((entry) => entry.modelIds.some((modelId) => normalizeModelId(modelId) === requestedModel));
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
  if (cachedCatalog) return cachedCatalog;
  const file = findModelCatalogFile();
  const raw = readFileSync(file, "utf8");
  cachedCatalog = JSON.parse(raw) as ModelCatalog;
  return cachedCatalog;
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

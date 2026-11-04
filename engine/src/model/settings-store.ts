import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readModelProviderConfig, type ModelProviderConfig } from "./config.js";
import { assertModelNotRemoved, findModelMetadata, loadModelCatalog, modelProtocols } from "./context-window.js";
import type { ReasoningEffort } from "./model-gateway.js";

import { modelSettingsHome, atomicJson, locked } from "./settings-files.js";
export type ApiProtocol = "openai" | "anthropic";
/** models: connection allowlist; a model is served only by connections that list it. */
export interface ApiConnection { id: string; name: string; kind: ApiProtocol; protocols?: ApiProtocol[]; baseUrl: string; key: string; models?: string[] }
export interface Composition {
  /** Priority list. When present, each slot uses the top-most enabled connection serving its model; slot api fields are derived. */
  order?: Array<{ id: string; enabled: boolean }>;
  main: { api: string; protocol?: "responses" | "messages"; model: string; effort: string; tokens?: string | number; timeout?: string | number; idle?: string | number; retries?: string | number };
  image: { api: string; model: string; timeout?: string | number };
  search: { api: string; model: string; context?: string; tokens?: string | number; timeout?: string | number; toolType: string; exa: boolean; exaUrl: string; exaTool: string; exaTimeout?: string | number };
}
export interface SettingsState { version: 1; revision: string; connections: ApiConnection[]; composition: Composition; applied?: { revision: string; connections: ApiConnection[]; composition: Composition } }
export const defaultComposition = (): Composition => ({
  main: { api: "", model: "", effort: "high" }, image: { api: "", model: "gpt-image-2.5-sunburst" },
  search: { api: "", model: "gpt-4.1-mini", toolType: "web_search", exa: true, exaUrl: "https://mcp.exa.ai/mcp", exaTool: "web_search_exa" },
});
export function optionalInteger(value: unknown, label: string, min = 1): number | undefined {
  if (value === undefined || value === "" || value === null) return undefined;
  const n = Number(value); if (!Number.isSafeInteger(n) || n < min) throw new Error(`${label} 必须为不小于 ${min} 的整数。`); return n;
}
export function validUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("请输入 Base URL。");
  const url = new URL(value); if (!["http:", "https:"].includes(url.protocol)) throw new Error("地址必须使用 HTTP(S)。"); return value.trim();
}
export function connectionProtocols(a: ApiConnection): Array<"openai" | "anthropic"> { return a.protocols ?? [a.kind]; }
export const IMAGE_MODELS = ["gpt-image-2.5-sunburst", "gpt-image-2.5-flare", "gpt-image-2"];
const normalizeId = (id: string) => id.trim().toLowerCase();
function modelKeys(model: string): Set<string> { const m = findModelMetadata(model); return new Set((m ? [m.id, ...m.modelIds] : [model]).map(normalizeId)); }
/** Top-priority routing: first enabled connection that lists the model and shares a protocol with it. No failover. */
export function routeModel(model: string, c: Composition, connections: ApiConnection[], need?: ApiProtocol): { connection: ApiConnection; protocol: ApiProtocol } | undefined {
  if (!c.order || !model?.trim()) return undefined;
  const keys = modelKeys(model), m = findModelMetadata(model);
  const wanted: ApiProtocol[] | undefined = IMAGE_MODELS.includes(model.trim()) ? ["openai"] : m ? modelProtocols(m) : undefined;
  for (const o of c.order) {
    const a = o.enabled ? connections.find(x => x.id === o.id) : undefined;
    if (!a || !(a.models ?? []).some(id => keys.has(normalizeId(id)))) continue;
    const supported = connectionProtocols(a);
    const protocol = (wanted ?? [a.kind, ...supported]).find(p => supported.includes(p) && (!need || p === need));
    if (protocol) return { connection: a, protocol };
  }
  return undefined;
}
export function resolveComposition(c: Composition, connections: ApiConnection[]): Composition {
  if (!c.order) return c;
  const r = structuredClone(c), main = routeModel(r.main.model, r, connections);
  r.main.api = main?.connection.id ?? ""; if (main) r.main.protocol = main.protocol === "anthropic" ? "messages" : "responses"; else delete r.main.protocol;
  r.image.api = routeModel(r.image.model, r, connections, "openai")?.connection.id ?? "";
  r.search.api = routeModel(r.search.model, r, connections, "openai")?.connection.id ?? "";
  return r;
}
const enabledConnections = (c: Composition, connections: ApiConnection[]) => (c.order ?? []).filter(o => o.enabled).flatMap(o => connections.filter(a => a.id === o.id));
/** Legacy single-slot compositions become an explicit priority list; deterministic, so it can run on every read. */
export function migrateSettingsState(s: SettingsState): SettingsState {
  if (s.composition.order) return s;
  const comps = [s.composition, s.applied?.composition].filter(Boolean) as Composition[];
  const listed = new Map<string, string[]>();
  for (const c of comps) for (const slot of ["main", "image", "search"] as const) if (c[slot].api && c[slot].model.trim()) listed.set(c[slot].api, [...new Set([...(listed.get(c[slot].api) ?? []), c[slot].model.trim()])]);
  // First migration keeps the previous session model list (every library model of the connection's protocols);
  // an explicit api reference always means that connection serves the referenced model.
  const compatible = (a: ApiConnection) => [...loadModelCatalog().models.filter(m => modelProtocols(m).some(p => connectionProtocols(a).includes(p))).map(m => m.id), ...(connectionProtocols(a).includes("openai") ? IMAGE_MODELS : [])];
  const addModels = (a: ApiConnection) => { a.models = [...new Map([...(a.models ?? compatible(a)), ...(listed.get(a.id) ?? [])].map(id => [normalizeId(id), id])).values()]; };
  s.connections.forEach(addModels); s.applied?.connections.forEach(addModels);
  for (const c of comps) {
    const used = [c.main.api, c.image.api, c.search.api];
    c.order = s.connections.map(a => ({ id: a.id, enabled: used.includes(a.id) }));
    if (!c.image.api) c.image.model = ""; if (!c.search.api) c.search.model = "";
  }
  return s;
}
export function mainProvider(c: Composition, a: ApiConnection): "openai" | "anthropic" {
  if (c.main.protocol !== undefined && !["responses", "messages"].includes(c.main.protocol)) throw new Error("主模型接口无效。");
  const kind = c.main.protocol ? c.main.protocol === "messages" ? "anthropic" : "openai" : a.kind;
  if (!connectionProtocols(a).includes(kind)) throw new Error("连接不支持所选主模型接口。");
  return kind;
}
export function supportedEfforts(model: string, _kind?: string): ReasoningEffort[] {
  const m = findModelMetadata(model);
  return !m || m.reasoning === false ? [] : m.reasoningEfforts ?? [];
}
export function validateComposition(c: Composition, connections: ApiConnection[], requireMain = true): void {
  if (!c?.main || !c.image || !c.search) throw new Error("能力配置不完整。");
  if (c.order !== undefined) {
    if (!Array.isArray(c.order) || c.order.some(o => typeof o?.id !== "string" || typeof o.enabled !== "boolean") || new Set(c.order.map(o => o.id)).size !== c.order.length) throw new Error("API 优先级无效。");
    if (c.order.some(o => !connections.some(a => a.id === o.id))) throw new Error("API 配置不存在。");
    for (const slot of ["main", "image", "search"] as const) if (typeof c[slot].model !== "string") throw new Error("模型必须是字符串。");
    if (requireMain && !enabledConnections(c, connections).length) throw new Error("请至少启用一个 API。");
    if (requireMain && !c.main.model.trim()) throw new Error("请选择主模型。");
    const r = resolveComposition(c, connections), labels = { main: "主模型", image: "图片生成", search: "搜索" };
    for (const slot of ["main", "image", "search"] as const) if (c[slot].model.trim() && !r[slot].api && (slot !== "main" || requireMain)) throw new Error(`${labels[slot]}：没有已启用的 API 提供模型 ${c[slot].model}。`);
    c = r;
  }
  const byId = (id: string) => connections.find(a => a.id === id);
  for (const slot of ["main", "image", "search"] as const) {
    const b = c[slot]; if (typeof b.api !== "string" || typeof b.model !== "string") throw new Error("API 与模型必须是字符串。");
    if (b.api && !byId(b.api)) throw new Error("API 配置不存在。");
    if (b.api && slot !== "main" && !connectionProtocols(byId(b.api)!).includes("openai")) throw new Error("图片生成和 OpenAI 搜索只支持 OpenAI 兼容连接。");
    if (b.api) assertModelNotRemoved(b.model);
    if (b.api && !b.model.trim()) throw new Error("请输入模型 ID。");
    if (b.api && !byId(b.api)!.key.trim()) throw new Error("请填写 API Key。");
    optionalInteger(b.timeout, "请求超时");
  }
  if (requireMain && !c.main.api) throw new Error("请选择主模型 API。");
  const a = byId(c.main.api), m = findModelMetadata(c.main.model);
  if (a) {
    const kind = mainProvider(c, a);
    if (m && !modelProtocols(m).includes(kind)) throw new Error("模型不支持当前连接所选接口，请重新选择模型。");
    if (m?.reasoning !== false && !supportedEfforts(c.main.model, kind).includes(c.main.effort as ReasoningEffort)) throw new Error("请在模型库确认推理档位，并选择当前模型支持的推理强度。");
    const tokens = optionalInteger(c.main.tokens, "最大输出 Token");
    if (tokens && m?.maxOutputTokens && tokens > m.maxOutputTokens) throw new Error(`最大输出 Token 不能超过 ${m.maxOutputTokens}。`);
    if (kind === "anthropic" && !/claude-(?:opus-4-[678]|sonnet-4-6|(?:opus|sonnet|haiku|fable|mythos)-5|mythos-preview)/i.test(c.main.model) && ["low", "medium", "high"].includes(c.main.effort) && tokens && tokens <= 1024) throw new Error("启用旧版 Claude 推理时最大输出 Token 至少为 1025。");
  }
  optionalInteger(c.main.idle, "流式空闲超时"); optionalInteger(c.main.retries, "重试次数", 0);
  if ((c.image.api || c.image.model) && !["gpt-image-2.5-sunburst", "gpt-image-2.5-flare", "gpt-image-2"].includes(c.image.model)) throw new Error("不支持的图片模型。");
  if (typeof c.search.exa !== "boolean") throw new Error("Exa 开关无效。");
  if (c.search.context && !["low", "medium", "high"].includes(c.search.context)) throw new Error("搜索上下文档位无效。");
  optionalInteger(c.search.tokens, "搜索最大输出 Token"); optionalInteger(c.search.exaTimeout, "Exa 超时");
  if (!c.search.toolType?.trim() || !c.search.exaTool?.trim()) throw new Error("搜索工具名称不能为空。");
  validUrl(c.search.exaUrl);
}
export function compositionModelConfig(c: Composition, connections: ApiConnection[]): ModelProviderConfig | undefined {
  c = resolveComposition(c, connections);
  const a = connections.find(x => x.id === c.main.api); if (!a || !c.main.model.trim()) return undefined;
  return connectionModelConfig(c, a, mainProvider(c, a), c.main.model, true);
}
/** Session-level model switches reuse the main slot's transport limits on the model's own route. */
export function connectionModelConfig(c: Composition, a: ApiConnection, kind: ApiProtocol, model: string, main: boolean): ModelProviderConfig {
  const reasoningOff = findModelMetadata(model)?.reasoning === false;
  return { provider: kind, apiKey: a.key, baseUrl: a.baseUrl, model,
    defaultReasoning: reasoningOff ? null : main ? { effort: c.main.effort as ReasoningEffort } : undefined,
    defaultMaxOutputTokens: main ? optionalInteger(c.main.tokens, "Token") : undefined, timeoutMs: optionalInteger(c.main.timeout, "超时"),
    streamIdleTimeoutMs: optionalInteger(c.main.idle, "空闲超时"), maxRetries: optionalInteger(c.main.retries, "重试", 0),
    ...(kind === "openai" ? { openai: { endpoint: "responses" as const } } : {}),
  };
}
function pendingConnections(s: SettingsState): boolean {
  if (!s.applied) return true;
  if (s.applied.composition.order) return JSON.stringify(s.applied.connections) !== JSON.stringify(enabledConnections(s.applied.composition, s.connections));
  return s.applied.connections.some(a => JSON.stringify(a) !== JSON.stringify(s.connections.find(b => b.id === a.id)));
}
export class ModelSettingsStore {
  readonly file: string;
  constructor(home = modelSettingsHome()) { this.file = path.join(home, "model-settings.json"); }
  read(): SettingsState | undefined { return existsSync(this.file) ? migrateSettingsState(JSON.parse(readFileSync(this.file, "utf8")) as SettingsState) : undefined; }
  initialize(env: NodeJS.ProcessEnv = process.env): SettingsState {
    const current = this.read(); if (current) return current;
    return locked(this.file, () => {
      const existing = this.read(); if (existing) return existing;
      const connections: ApiConnection[] = [], composition = defaultComposition(), config = readModelProviderConfig(env);
      for (const kind of ["openai", "anthropic"] as const) {
        const prefix = kind.toUpperCase(), key = env[`${prefix}_API_KEY`];
        if (key) connections.push({ id: kind, name: kind === "openai" ? "连接 A" : "连接 B", kind, key, baseUrl: env[`${prefix}_BASE_URL`] || (kind === "openai" ? "https://api.openai.com" : "https://api.anthropic.com") });
      }
      if (config) composition.main = { api: config.provider, model: config.model, effort: config.defaultReasoning?.effort ?? "high", tokens: config.defaultMaxOutputTokens, timeout: config.timeoutMs, idle: config.streamIdleTimeoutMs, retries: config.maxRetries };
      if (connections.some(a => a.id === "openai")) {
        composition.image.api = "openai"; composition.image.model = env.OPENAI_IMAGE_MODEL || composition.image.model;
        composition.image.timeout = env.OPENAI_IMAGE_TIMEOUT_MS;
        composition.search.api = "openai"; composition.search.model = env.OPENAI_SEARCH_MODEL || env.WEB_SEARCH_OPENAI_MODEL || env.OPENAI_MODEL || composition.search.model;
      }
      if (env.OPENAI_IMAGE_API_KEY || env.OPENAI_IMAGE_BASE_URL) {
        const base = connections.find(a => a.id === "openai");
        connections.push({ id: "image", name: "图片连接", kind: "openai", key: env.OPENAI_IMAGE_API_KEY || base?.key || "", baseUrl: env.OPENAI_IMAGE_BASE_URL || base?.baseUrl || "https://api.openai.com" });
        composition.image.api = "image";
      }
      const searchKey = env.OPENAI_SEARCH_API_KEY || env.WEB_SEARCH_OPENAI_API_KEY;
      const searchUrl = env.OPENAI_SEARCH_BASE_URL || env.WEB_SEARCH_OPENAI_BASE_URL;
      if (searchKey || searchUrl) { const base = connections.find(a => a.id === "openai"); connections.push({ id: "search", name: "搜索连接", kind: "openai", key: searchKey || base?.key || "", baseUrl: searchUrl || base?.baseUrl || "https://api.openai.com" }); composition.search.api = "search"; }
      composition.search.context = env.OPENAI_SEARCH_CONTEXT_SIZE || env.WEB_SEARCH_OPENAI_CONTEXT_SIZE;
      composition.search.tokens = env.OPENAI_SEARCH_MAX_OUTPUT_TOKENS || env.WEB_SEARCH_OPENAI_MAX_OUTPUT_TOKENS;
      composition.search.timeout = env.SEARCH_TIMEOUT_MS || env.WEB_SEARCH_TIMEOUT_MS || env.OPENAI_SEARCH_TIMEOUT_MS || env.WEB_SEARCH_OPENAI_TIMEOUT_MS;
      composition.search.exaTimeout = env.SEARCH_TIMEOUT_MS || env.WEB_SEARCH_TIMEOUT_MS;
      composition.search.toolType = env.OPENAI_SEARCH_TOOL_TYPE || env.WEB_SEARCH_OPENAI_TOOL_TYPE || "web_search";
      composition.search.exaUrl = env.EXA_MCP_URL || env.WEB_SEARCH_EXA_MCP_URL || composition.search.exaUrl;
      composition.search.exaTool = env.EXA_MCP_TOOL_NAME || env.WEB_SEARCH_EXA_TOOL_NAME || composition.search.exaTool;
      if ((env.SEARCH_PROVIDER || env.WEB_SEARCH_PROVIDER) === "exa") composition.search.api = "";
      const state = migrateSettingsState({ version: 1, revision: randomUUID(), connections, composition });
      // Existing environment remains authoritative until the first explicit Apply.
      atomicJson(this.file, state); return state;
    });
  }
  mutate(revision: string, change: (s: SettingsState) => void): SettingsState {
    return locked(this.file, () => { const s = this.read(); if (!s || s.revision !== revision) throw new Error("配置已被更新，请重新加载后保存。"); change(s); migrateSettingsState(s); s.revision = randomUUID(); atomicJson(this.file, s); return s; });
  }
  saveConnection(revision: string, input: ApiConnection): SettingsState {
    return this.mutate(revision, s => {
      if (!["openai", "anthropic"].includes(input.kind) || !input.name?.trim()) throw new Error("名称或接口类型无效。");
      const protocols = input.protocols ?? [input.kind];
      if (!Array.isArray(protocols) || !protocols.length || protocols.some(p => !["openai", "anthropic"].includes(p)) || new Set(protocols).size !== protocols.length) throw new Error("请选择有效的兼容接口。");
      const old = s.connections.find(a => a.id === input.id);
      if (input.id && !old) throw new Error("API 配置已不存在。");
      const key = typeof input.key === "string" && input.key ? input.key : old?.key || "";
      if (!key.trim()) throw new Error("请输入 API Key。");
      if (input.models !== undefined && (!Array.isArray(input.models) || input.models.some(id => typeof id !== "string" || !id.trim() || id.length > 256))) throw new Error("可用模型无效。");
      const models = input.models === undefined ? old?.models ?? [] : [...new Map(input.models.map(id => [normalizeId(id), id.trim()])).values()];
      const connection: ApiConnection = { id: old?.id || randomUUID(), name: input.name.trim(), kind: protocols.includes(input.kind) ? input.kind : protocols[0], protocols, key, baseUrl: validUrl(input.baseUrl), models };
      if (old) s.connections[s.connections.indexOf(old)] = connection; else s.connections.push(connection);
    });
  }
  removeConnection(revision: string, id: string, beforeDelete?: () => void): SettingsState {
    return this.mutate(revision, s => {
      if (!s.connections.some(a => a.id === id)) throw new Error("API 配置已不存在。");
      beforeDelete?.();
      if (s.composition.order) {
        const appliedChanged = Boolean(s.applied?.composition.order?.some(o => o.id === id && o.enabled));
        for (const c of [s.composition, s.applied?.composition]) if (c?.order) c.order = c.order.filter(o => o.id !== id);
        s.connections = s.connections.filter(a => a.id !== id);
        if (s.applied) { s.applied.connections = s.applied.connections.filter(a => a.id !== id); s.applied.composition = resolveComposition(s.applied.composition, s.applied.connections); if (appliedChanged) s.applied.revision = randomUUID(); }
        s.composition = resolveComposition(s.composition, s.connections);
        return;
      }
      // Preserve an explicit empty configuration instead of reviving environment credentials on restart.
      if (!s.applied && [s.composition.main.api, s.composition.image.api, s.composition.search.api].includes(id)) s.applied = { revision: randomUUID(), composition: structuredClone(s.composition), connections: structuredClone(s.connections) };
      const appliedChanged = s.applied && [s.applied.composition.main.api, s.applied.composition.image.api, s.applied.composition.search.api].includes(id);
      for (const c of [s.composition, s.applied?.composition]) if (c) for (const slot of ["main", "image", "search"] as const) if (c[slot].api === id) { c[slot].api = ""; c[slot].model = ""; }
      s.connections = s.connections.filter(a => a.id !== id);
      if (s.applied) { s.applied.connections = s.applied.connections.filter(a => a.id !== id); if (appliedChanged) s.applied.revision = randomUUID(); }
    });
  }
  clearRemovedModels(ids: readonly string[]): void {
    const current = this.read(); if (!current) return;
    const wanted = new Set(ids.map(id => id.toLowerCase()));
    const references = (c: Composition | undefined) => c && [c.main, c.image, c.search].some(slot => wanted.has(slot.model.toLowerCase()));
    if (!references(current.composition) && !references(current.applied?.composition)) return;
    this.mutate(current.revision, s => {
      if (!s.applied && references(s.composition)) s.applied = { revision: randomUUID(), composition: structuredClone(s.composition), connections: structuredClone(s.connections) };
      const appliedChanged = references(s.applied?.composition);
      for (const c of [s.composition, s.applied?.composition]) if (c) for (const slot of ["main", "image", "search"] as const) if (wanted.has(c[slot].model.toLowerCase())) { c[slot].model = ""; if (slot !== "main") c[slot].api = ""; }
      for (const a of [...s.connections, ...(s.applied?.connections ?? [])]) if (a.models) a.models = a.models.filter(id => !wanted.has(normalizeId(id)));
      if (s.applied?.composition.order) s.applied.composition = resolveComposition(s.applied.composition, s.applied.connections);
      if (s.composition.order) s.composition = resolveComposition(s.composition, s.connections);
      if (s.applied && appliedChanged) s.applied.revision = randomUUID();
    });
  }
  apply(revision: string, c: Composition): SettingsState {
    return this.mutate(revision, s => {
      validateComposition(c, s.connections);
      if (c.order) {
        // Every connection must stay in the list; new ones the client did not know about stay disabled.
        const order = [...c.order, ...s.connections.filter(a => !c.order!.some(o => o.id === a.id)).map(a => ({ id: a.id, enabled: false }))];
        const resolved = resolveComposition({ ...structuredClone(c), order }, s.connections);
        s.composition = resolved;
        s.applied = { revision: randomUUID(), composition: structuredClone(resolved), connections: structuredClone(enabledConnections(resolved, s.connections)) };
        return;
      }
      s.composition = structuredClone(c); s.applied = { revision: randomUUID(), composition: structuredClone(c), connections: structuredClone(s.connections.filter(a => [c.main.api, c.image.api, c.search.api].includes(a.id))) };
    });
  }
  publicState(s = this.initialize()) {
    return { revision: s.revision, connections: s.connections.map(({ key, ...a }) => ({ ...a, hasKey: Boolean(key) })), composition: s.composition,
      appliedRevision: s.applied?.revision, pendingConnections: pendingConnections(s), catalog: loadModelCatalog(), metadataFile: path.join(path.dirname(this.file), "model-metadata.json") };
  }
}

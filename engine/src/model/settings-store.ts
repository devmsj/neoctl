import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readModelProviderConfig, type ModelProviderConfig } from "./config.js";
import { assertModelNotRemoved, findModelMetadata, loadModelCatalog, modelProtocols } from "./context-window.js";
import type { ReasoningEffort } from "./model-gateway.js";

import { modelSettingsHome, atomicJson, locked } from "./settings-files.js";
export interface ApiConnection { id: string; name: string; kind: "openai" | "anthropic"; protocols?: Array<"openai" | "anthropic">; baseUrl: string; key: string }
export interface Composition {
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
  if (!["gpt-image-2.5-sunburst", "gpt-image-2.5-flare", "gpt-image-2"].includes(c.image.model)) throw new Error("不支持的图片模型。");
  if (typeof c.search.exa !== "boolean") throw new Error("Exa 开关无效。");
  if (c.search.context && !["low", "medium", "high"].includes(c.search.context)) throw new Error("搜索上下文档位无效。");
  optionalInteger(c.search.tokens, "搜索最大输出 Token"); optionalInteger(c.search.exaTimeout, "Exa 超时");
  if (!c.search.toolType?.trim() || !c.search.exaTool?.trim()) throw new Error("搜索工具名称不能为空。");
  validUrl(c.search.exaUrl);
}
export function compositionModelConfig(c: Composition, connections: ApiConnection[]): ModelProviderConfig | undefined {
  const a = connections.find(x => x.id === c.main.api); if (!a) return undefined;
  const kind = mainProvider(c, a);
  return { provider: kind, apiKey: a.key, baseUrl: a.baseUrl, model: c.main.model,
    defaultReasoning: findModelMetadata(c.main.model)?.reasoning === false ? null : { effort: c.main.effort as ReasoningEffort },
    defaultMaxOutputTokens: optionalInteger(c.main.tokens, "Token"), timeoutMs: optionalInteger(c.main.timeout, "超时"),
    streamIdleTimeoutMs: optionalInteger(c.main.idle, "空闲超时"), maxRetries: optionalInteger(c.main.retries, "重试", 0),
    ...(kind === "openai" ? { openai: { endpoint: "responses" as const } } : {}),
  };
}
export class ModelSettingsStore {
  readonly file: string;
  constructor(home = modelSettingsHome()) { this.file = path.join(home, "model-settings.json"); }
  read(): SettingsState | undefined { return existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) as SettingsState : undefined; }
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
      const state: SettingsState = { version: 1, revision: randomUUID(), connections, composition };
      // Existing environment remains authoritative until the first explicit Apply.
      atomicJson(this.file, state); return state;
    });
  }
  mutate(revision: string, change: (s: SettingsState) => void): SettingsState {
    return locked(this.file, () => { const s = this.read(); if (!s || s.revision !== revision) throw new Error("配置已被更新，请重新加载后保存。"); change(s); s.revision = randomUUID(); atomicJson(this.file, s); return s; });
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
      const connection: ApiConnection = { id: old?.id || randomUUID(), name: input.name.trim(), kind: protocols.includes(input.kind) ? input.kind : protocols[0], protocols, key, baseUrl: validUrl(input.baseUrl) };
      if (old) s.connections[s.connections.indexOf(old)] = connection; else s.connections.push(connection);
    });
  }
  removeConnection(revision: string, id: string): SettingsState {
    return this.mutate(revision, s => { if ([s.composition, s.applied?.composition].some(c => c && [c.main.api, c.image.api, c.search.api].includes(id))) throw new Error("此 API 仍被引用，请先更换并应用。"); s.connections = s.connections.filter(a => a.id !== id); });
  }
  apply(revision: string, c: Composition): SettingsState {
    return this.mutate(revision, s => { validateComposition(c, s.connections); s.composition = structuredClone(c); s.applied = { revision: randomUUID(), composition: structuredClone(c), connections: structuredClone(s.connections.filter(a => [c.main.api, c.image.api, c.search.api].includes(a.id))) }; });
  }
  publicState(s = this.initialize()) {
    return { revision: s.revision, connections: s.connections.map(({ key, ...a }) => ({ ...a, hasKey: Boolean(key) })), composition: s.composition,
      appliedRevision: s.applied?.revision, pendingConnections: !s.applied || s.applied.connections.some(a => JSON.stringify(a) !== JSON.stringify(s.connections.find(b => b.id === a.id))), catalog: loadModelCatalog(), metadataFile: path.join(path.dirname(this.file), "model-metadata.json") };
  }
}

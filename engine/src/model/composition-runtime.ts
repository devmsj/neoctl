import { createSearchTool } from "../tools/builtins/search-tool.js";
import { createOpenAISearchProvider, createExaSearchProvider } from "../tools/builtins/search-providers.js";
import { createOpenAIImageGenerationTool } from "../tools/builtins/image-generation-tool.js";
import { compositionModelConfig, connectionModelConfig, connectionProtocols, optionalInteger, resolveComposition, routeModel, type ApiConnection, type Composition } from "./settings-store.js";
import { createModelGatewayFromConfig } from "./provider-factory.js";
import type { ModelGateway } from "./model-gateway.js";
import type { ModelProviderConfig } from "./config.js";
import type { ToolRegistry } from "../tools/registry.js";

/**
 * Main-model gateway for an applied composition. With a priority list, a session that switches
 * to another model is sent to that model's own top-most connection; requests never fail over.
 */
export function createCompositionGateway(c: Composition, connections: ApiConnection[]): { gateway: ModelGateway; config: ModelProviderConfig | undefined; heldConnections: () => string[] } {
  const resolved = resolveComposition(c, connections), config = compositionModelConfig(resolved, connections);
  const main = createModelGatewayFromConfig(config);
  const fixed = [resolved.image.api, resolved.search.api];
  if (!resolved.order || !config) return { gateway: main, config, heldConnections: () => [resolved.main.api, ...fixed] };
  const routes = new Map<string, ModelGateway>(), same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  let current = resolved.main.api;
  const select = (model = config.model): ModelGateway => {
    if (same(model, config.model)) { current = resolved.main.api; return main; }
    const route = routeModel(model, resolved, connections);
    if (!route) throw new Error(`没有已启用的 API 提供模型 ${model}，请在模型页为 API 添加该模型。`);
    current = route.connection.id;
    const key = route.connection.id + "\u0000" + route.protocol + "\u0000" + model.trim().toLowerCase();
    let routed = routes.get(key);
    if (!routed) { routed = createModelGatewayFromConfig(connectionModelConfig(resolved, route.connection, route.protocol, model, false)); routes.set(key, routed); }
    return routed;
  };
  const gateway: ModelGateway = {
    stream: request => select(request.model).stream(request),
    estimateInputTokens: request => select(request.model).estimateInputTokens?.(request),
    countInputTokens: async request => select(request.model).countInputTokens?.(request),
  };
  return { gateway, config, heldConnections: () => [current, ...fixed] };
}

export function compositionProviders(c: Composition, connections: ApiConnection[]) {
  c = resolveComposition(c, connections);
  const connection = (id: string) => { const a = connections.find(a => a.id === id); if (!a || !connectionProtocols(a).includes("openai")) throw new Error("需要 OpenAI 兼容连接。"); return a; };
  const openai = c.search.api ? (() => { const a = connection(c.search.api); return createOpenAISearchProvider({ apiKey: a.key, baseUrl: a.baseUrl, model: c.search.model, maxOutputTokens: optionalInteger(c.search.tokens, "搜索 Token"), searchContextSize: c.search.context as "low" | "medium" | "high" || undefined, timeoutMs: optionalInteger(c.search.timeout, "搜索超时"), toolType: c.search.toolType }); })() : undefined;
  const exa = c.search.exa ? createExaSearchProvider({ mcpUrl: c.search.exaUrl, toolName: c.search.exaTool, timeoutMs: optionalInteger(c.search.exaTimeout, "Exa 超时") }) : undefined;
  const image = c.image.api ? (() => { const a = connection(c.image.api); const tool = createOpenAIImageGenerationTool({ apiKey: a.key, baseUrl: a.baseUrl, model: c.image.model, timeoutMs: optionalInteger(c.image.timeout, "图片超时") ?? 360000 }); return { ...tool, description: String(tool.description).replace("Available only when MODEL_PROVIDER=openai.", "Uses the separately configured OpenAI-compatible Images connection.") }; })() : undefined;
  const search = openai || exa ? createSearchTool({
    description: openai ? "Search the web. OpenAI Responses is the default. " + (exa ? "Use provider=exa only when OpenAI is unavailable, results are incomplete, or the user explicitly requests Exa." : "Exa is disabled; do not request it.") : "Search the web using Exa MCP. OpenAI search is disabled. Use provider=exa or omit provider.",
    resolveProvider(name) { const selected = name?.trim().toLowerCase() || (openai ? "openai" : "exa"); const p = selected === "exa" ? exa : ["openai", "gpt"].includes(selected) ? openai : undefined; if (!p) throw new Error(`Search provider ${selected} is not configured.`); return p; },
  }) : undefined;
  return { openai, exa, image, search };
}
export function registerCompositionTools(tools: ToolRegistry, c: Composition, connections: ApiConnection[]): void {
  const providers = compositionProviders(c, connections);
  for (const name of ["image_create", "web_search"] as const) {
    const enabled = tools.isEnabled(name); tools.unregister(name);
    const tool = name === "image_create" ? providers.image : providers.search;
    if (tool) { tools.register(tool); if (enabled === false) tools.setEnabled(name, false); }
  }
}

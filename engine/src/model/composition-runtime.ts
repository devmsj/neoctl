import { createSearchTool } from "../tools/builtins/search-tool.js";
import { createOpenAISearchProvider, createExaSearchProvider } from "../tools/builtins/search-providers.js";
import { createOpenAIImageGenerationTool } from "../tools/builtins/image-generation-tool.js";
import { connectionProtocols, optionalInteger, type ApiConnection, type Composition } from "./settings-store.js";
import type { ToolRegistry } from "../tools/registry.js";

export function compositionProviders(c: Composition, connections: ApiConnection[]) {
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

export type SearchProviderName = "exa" | "openai" | "gpt" | (string & {});

export interface SearchToolInput {
  query: string;
  numResults: number;
  includeDomains?: string[];
  excludeDomains?: string[];
  startPublishedDate?: string;
  endPublishedDate?: string;
}

export interface WebSearchResult {
  title: string;
  url: string;
  published?: string;
  author?: string;
  highlights?: string[];
  text?: string;
  score?: number;
  raw?: Record<string, unknown>;
}

export interface SearchProviderResult {
  provider: string;
  query: string;
  results: WebSearchResult[];
  raw?: unknown;
}

export interface SearchProvider {
  readonly name: SearchProviderName;
  search(input: SearchToolInput, signal?: AbortSignal): Promise<SearchProviderResult>;
}

export interface SearchProviderConfig {
  provider?: string;
  exa?: ExaSearchProviderConfig;
  openai?: OpenAISearchProviderConfig;
}

export interface ExaSearchProviderConfig {
  mcpUrl?: string;
  toolName?: string;
  timeoutMs?: number;
}

export interface OpenAISearchProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  toolType?: string;
  searchContextSize?: "low" | "medium" | "high";
  maxOutputTokens?: number;
}

export const DEFAULT_SEARCH_PROVIDER = "openai";
export const DEFAULT_EXA_MCP_URL = "https://mcp.exa.ai/mcp";
export const DEFAULT_EXA_MCP_TOOL_NAME = "web_search_exa";
export const DEFAULT_OPENAI_SEARCH_MODEL = "gpt-4.1-mini";
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com";
export const DEFAULT_OPENAI_WEB_SEARCH_TOOL_TYPE = "web_search";
export const DEFAULT_SEARCH_TIMEOUT_MS = 120_000;

export class SearchProviderError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SearchProviderError";
  }
}

function resolveSearchProviderName(config: SearchProviderConfig, env: NodeJS.ProcessEnv): string {
  const explicit = config.provider ?? env.SEARCH_PROVIDER ?? env.WEB_SEARCH_PROVIDER;
  if (explicit?.trim()) return explicit.trim().toLowerCase();

  return DEFAULT_SEARCH_PROVIDER;
}

export function createSearchProvider(config: SearchProviderConfig = {}, env: NodeJS.ProcessEnv = process.env): SearchProvider {
  const provider = resolveSearchProviderName(config, env);
  switch (provider) {
    case "exa":
      return createExaSearchProvider({
        mcpUrl: config.exa?.mcpUrl ?? env.EXA_MCP_URL ?? env.WEB_SEARCH_EXA_MCP_URL,
        toolName: config.exa?.toolName ?? env.EXA_MCP_TOOL_NAME ?? env.WEB_SEARCH_EXA_TOOL_NAME,
        timeoutMs: config.exa?.timeoutMs ?? parseOptionalInteger(env.SEARCH_TIMEOUT_MS ?? env.WEB_SEARCH_TIMEOUT_MS),
      });
    case "openai":
    case "gpt":
      return createOpenAISearchProvider({
        apiKey: config.openai?.apiKey ?? env.OPENAI_SEARCH_API_KEY ?? env.WEB_SEARCH_OPENAI_API_KEY ?? env.OPENAI_API_KEY,
        baseUrl: config.openai?.baseUrl ?? env.OPENAI_SEARCH_BASE_URL ?? env.WEB_SEARCH_OPENAI_BASE_URL ?? env.OPENAI_BASE_URL,
        model: config.openai?.model ?? env.OPENAI_SEARCH_MODEL ?? env.WEB_SEARCH_OPENAI_MODEL ?? env.OPENAI_MODEL,
        toolType: config.openai?.toolType ?? env.OPENAI_SEARCH_TOOL_TYPE ?? env.WEB_SEARCH_OPENAI_TOOL_TYPE,
        searchContextSize: config.openai?.searchContextSize ?? parseOpenAISearchContextSize(env.OPENAI_SEARCH_CONTEXT_SIZE ?? env.WEB_SEARCH_OPENAI_CONTEXT_SIZE),
        maxOutputTokens: config.openai?.maxOutputTokens ?? parseOptionalInteger(env.OPENAI_SEARCH_MAX_OUTPUT_TOKENS ?? env.WEB_SEARCH_OPENAI_MAX_OUTPUT_TOKENS),
        timeoutMs: config.openai?.timeoutMs ?? parseOptionalInteger(env.SEARCH_TIMEOUT_MS ?? env.WEB_SEARCH_TIMEOUT_MS ?? env.OPENAI_SEARCH_TIMEOUT_MS ?? env.WEB_SEARCH_OPENAI_TIMEOUT_MS),
      });
    default:
      throw new SearchProviderError(
        `Unsupported search provider: ${provider}. Add a provider implementation and register it in createSearchProvider().`,
        provider,
      );
  }
}

export function createExaSearchProvider(config: ExaSearchProviderConfig = {}): SearchProvider {
  const mcpUrl = config.mcpUrl?.trim() || DEFAULT_EXA_MCP_URL;
  const toolName = config.toolName?.trim() || DEFAULT_EXA_MCP_TOOL_NAME;
  const timeoutMs = config.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS;

  return {
    name: "exa",
    async search(input, signal) {
      const response = await callExaMcpTool(mcpUrl, toolName, input, timeoutMs, signal);
      return {
        provider: "exa",
        query: input.query,
        results: extractExaResults(response),
        raw: response,
      };
    },
  };
}

export function createOpenAISearchProvider(config: OpenAISearchProviderConfig = {}): SearchProvider {
  const apiKey = config.apiKey?.trim();
  const baseUrl = stripTrailingSlash(config.baseUrl?.trim() || DEFAULT_OPENAI_BASE_URL);
  const model = config.model?.trim() || DEFAULT_OPENAI_SEARCH_MODEL;
  const toolType = config.toolType?.trim() || DEFAULT_OPENAI_WEB_SEARCH_TOOL_TYPE;
  const timeoutMs = config.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS;
  const searchContextSize = config.searchContextSize;
  const maxOutputTokens = config.maxOutputTokens ?? 1200;

  return {
    name: "openai",
    async search(input, signal) {
      if (!apiKey) throw new SearchProviderError("OpenAI search requires OPENAI_SEARCH_API_KEY or OPENAI_API_KEY", "openai");
      const response = await callOpenAIWebSearch({
        apiKey,
        baseUrl,
        model,
        toolType,
        searchContextSize,
        maxOutputTokens,
        timeoutMs,
        input,
        signal,
      });
      return {
        provider: "openai",
        query: input.query,
        results: extractOpenAIResults(response).slice(0, input.numResults),
        raw: response,
      };
    },
  };
}

async function callExaMcpTool(
  mcpUrl: string,
  toolName: string,
  input: SearchToolInput,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  const timeout = setTimeout(() => controller.abort(new Error(`Search request timed out after ${timeoutMs}ms`)), timeoutMs);
  signal?.addEventListener("abort", abort, { once: true });

  try {
    const response = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: toolName,
          arguments: buildExaArguments(input),
        },
      }),
      signal: controller.signal,
    });

    const text = await response.text();
    if (!response.ok) {
      throw new SearchProviderError(`Exa MCP HTTP ${response.status}: ${text.slice(0, 1000)}`, "exa");
    }

    return parseJsonRpcOrSseResponse(text);
  } catch (error) {
    if (error instanceof SearchProviderError) throw error;
    throw new SearchProviderError(error instanceof Error ? error.message : String(error), "exa", error);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

interface OpenAIWebSearchRequestOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  toolType: string;
  searchContextSize?: "low" | "medium" | "high";
  maxOutputTokens: number;
  timeoutMs: number;
  input: SearchToolInput;
  signal?: AbortSignal;
}

async function callOpenAIWebSearch(options: OpenAIWebSearchRequestOptions): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  const timeout = setTimeout(() => controller.abort(new Error(`Search request timed out after ${options.timeoutMs}ms`)), options.timeoutMs);
  options.signal?.addEventListener("abort", abort, { once: true });

  try {
    const response = await fetch(openAIResponsesUrl(options.baseUrl), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify(buildOpenAIWebSearchBody(options)),
      signal: controller.signal,
    });

    const text = await response.text();
    const body = text ? parseJsonObject(text, "openai") : {};
    if (!response.ok) {
      throw new SearchProviderError(`OpenAI search HTTP ${response.status}: ${openAIErrorMessage(body) ?? text.slice(0, 1000)}`, "openai");
    }
    return body;
  } catch (error) {
    if (error instanceof SearchProviderError) throw error;
    throw new SearchProviderError(error instanceof Error ? error.message : String(error), "openai", error);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}

function buildOpenAIWebSearchBody(options: OpenAIWebSearchRequestOptions): Record<string, unknown> {
  const tool = dropUndefined({
    type: options.toolType,
    search_context_size: options.searchContextSize,
  });
  return dropUndefined({
    model: options.model,
    input: buildOpenAIWebSearchPrompt(options.input),
    tools: [tool],
    tool_choice: "auto",
    max_output_tokens: options.maxOutputTokens,
    store: false,
  });
}

function buildOpenAIWebSearchPrompt(input: SearchToolInput): string {
  const constraints: string[] = [`Return up to ${input.numResults} highly relevant web results.`];
  if (input.includeDomains?.length) constraints.push(`Only include these domains when possible: ${input.includeDomains.join(", ")}.`);
  if (input.excludeDomains?.length) constraints.push(`Exclude these domains: ${input.excludeDomains.join(", ")}.`);
  if (input.startPublishedDate) constraints.push(`Prefer sources published on or after ${input.startPublishedDate}.`);
  if (input.endPublishedDate) constraints.push(`Prefer sources published on or before ${input.endPublishedDate}.`);
  constraints.push("For each result, cite the source URL and include a concise snippet.");
  return `Search the web for: ${input.query}\n\n${constraints.join("\n")}`;
}

function extractOpenAIResults(response: Record<string, unknown>): WebSearchResult[] {
  const output = Array.isArray(response.output) ? response.output : [];
  const results = new Map<string, WebSearchResult>();

  for (const item of output) {
    if (!isRecord(item) || item.type !== "message") continue;
    const messageText = extractOpenAIMessageText(item);
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      if (!isRecord(part)) continue;
      const annotations = Array.isArray(part.annotations) ? part.annotations : [];
      for (const annotation of annotations) {
        const citation = mapOpenAICitation(annotation, messageText);
        if (citation && !results.has(citation.url)) results.set(citation.url, citation);
      }
    }
  }

  if (results.size > 0) return [...results.values()];

  const text = output.map((item) => (isRecord(item) && item.type === "message" ? extractOpenAIMessageText(item) : "")).filter(Boolean).join("\n\n").trim();
  return text ? [{ title: "OpenAI web search summary", url: "https://openai.com/search", text, highlights: [text] }] : [];
}

function extractOpenAIMessageText(message: Record<string, unknown>): string {
  const content = Array.isArray(message.content) ? message.content : [];
  return content
    .map((part) => (isRecord(part) ? stringFrom(part.text) ?? stringFrom(part.output_text) ?? "" : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function mapOpenAICitation(annotation: unknown, messageText: string): WebSearchResult | undefined {
  if (!isRecord(annotation)) return undefined;
  const url = stringFrom(annotation.url);
  if (!url) return undefined;
  const title = stringFrom(annotation.title) ?? url;
  const start = typeof annotation.start_index === "number" ? annotation.start_index : undefined;
  const end = typeof annotation.end_index === "number" ? annotation.end_index : undefined;
  const snippet = start !== undefined && end !== undefined ? messageText.slice(Math.max(0, start), Math.max(start, end)).trim() : "";
  return {
    title,
    url,
    highlights: snippet ? [snippet] : undefined,
    text: snippet || messageText || undefined,
    raw: annotation,
  };
}

function openAIErrorMessage(body: Record<string, unknown>): string | undefined {
  const error = isRecord(body.error) ? body.error : undefined;
  return stringFrom(error?.message);
}

function buildExaArguments(input: SearchToolInput): Record<string, unknown> {
  const args: Record<string, unknown> = {
    query: input.query,
    numResults: input.numResults,
  };
  if (input.includeDomains?.length) args.includeDomains = input.includeDomains;
  if (input.excludeDomains?.length) args.excludeDomains = input.excludeDomains;
  if (input.startPublishedDate) args.startPublishedDate = input.startPublishedDate;
  if (input.endPublishedDate) args.endPublishedDate = input.endPublishedDate;
  return args;
}

function parseJsonRpcOrSseResponse(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) throw new SearchProviderError("Exa MCP returned an empty response", "exa");

  const dataMessages = trimmed
    .split(/\r?\n/u)
    .map((rawLine) => rawLine.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter((data) => data && data !== "[DONE]");

  if (dataMessages.length === 0) return parseJsonRpcMessage(trimmed);
  return parseJsonRpcMessage(dataMessages[0] ?? "{}");
}

function parseJsonRpcMessage(jsonText: string): Record<string, unknown> {
  const message = JSON.parse(jsonText) as Record<string, unknown>;
  if (isRecord(message.error)) {
    const errorMessage = typeof message.error.message === "string" ? message.error.message : JSON.stringify(message.error);
    throw new SearchProviderError(`Exa MCP error: ${errorMessage}`, "exa");
  }
  if (isRecord(message.result)) return message.result;
  return message;
}

function extractExaResults(response: Record<string, unknown>): WebSearchResult[] {
  const structured = extractStructuredExaResults(response);
  if (structured.length > 0) return structured;

  const text = extractMcpText(response);
  if (!text) return [];
  return parseExaTextResults(text);
}

function extractStructuredExaResults(response: Record<string, unknown>): WebSearchResult[] {
  const structuredContent = isRecord(response.structuredContent) ? response.structuredContent : undefined;
  const candidates = [
    response.results,
    response.documents,
    structuredContent?.results,
    structuredContent?.documents,
  ];

  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    const results = candidate.map(mapStructuredResult).filter((result): result is WebSearchResult => result !== undefined);
    if (results.length > 0) return results;
  }
  return [];
}

function mapStructuredResult(value: unknown): WebSearchResult | undefined {
  if (!isRecord(value)) return undefined;
  const url = stringFrom(value.url) ?? stringFrom(value.id);
  if (!url) return undefined;
  const title = stringFrom(value.title) ?? url;
  const highlights = arrayOfStrings(value.highlights ?? value.snippets ?? value.texts);
  return {
    title,
    url,
    published: stringFrom(value.publishedDate ?? value.published ?? value.date),
    author: stringFrom(value.author),
    highlights: highlights.length ? highlights : undefined,
    text: stringFrom(value.text ?? value.summary),
    score: typeof value.score === "number" ? value.score : undefined,
    raw: value,
  };
}

function extractMcpText(response: Record<string, unknown>): string {
  const content = response.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => (isRecord(item) && item.type === "text" && typeof item.text === "string" ? item.text.trim() : ""))
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function parseExaTextResults(text: string): WebSearchResult[] {
  return text
    .split(/\n---\n/u)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(parseExaTextEntry)
    .filter((result): result is WebSearchResult => result !== undefined);
}

function parseExaTextEntry(entry: string): WebSearchResult | undefined {
  const lines = entry.split(/\r?\n/u);
  const title = readLabel(lines, "Title") ?? "Untitled";
  const url = readLabel(lines, "URL");
  if (!url) return undefined;
  const published = normalizeOptionalLabel(readLabel(lines, "Published"));
  const author = normalizeOptionalLabel(readLabel(lines, "Author"));
  const highlights = readHighlights(lines);
  return {
    title,
    url,
    published,
    author,
    highlights: highlights.length ? highlights : undefined,
    text: highlights.join("\n"),
  };
}

function readLabel(lines: readonly string[], label: string): string | undefined {
  const prefix = `${label}:`;
  const line = lines.find((value) => value.startsWith(prefix));
  return line?.slice(prefix.length).trim();
}

function normalizeOptionalLabel(value: string | undefined): string | undefined {
  if (!value || value === "N/A") return undefined;
  return value;
}

function readHighlights(lines: readonly string[]): string[] {
  const start = lines.findIndex((line) => line.trim() === "Highlights:");
  if (start < 0) return [];
  return lines
    .slice(start + 1)
    .map((line) => line.trim())
    .filter((line) => line && line !== "[...]" && !line.startsWith("Title:") && !line.startsWith("URL:"));
}

function stringFrom(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function arrayOfStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function parseOptionalInteger(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseOpenAISearchContextSize(value: string | undefined): "low" | "medium" | "high" | undefined {
  if (value === "low" || value === "medium" || value === "high") return value;
  return undefined;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function openAIResponsesUrl(baseUrl: string): string {
  const normalized = stripTrailingSlash(baseUrl.trim());
  return `${normalized.endsWith("/v1") ? normalized : `${normalized}/v1`}/responses`;
}

function dropUndefined<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function parseJsonObject(text: string, provider: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (isRecord(parsed)) return parsed;
    throw new Error("JSON response was not an object");
  } catch (error) {
    throw new SearchProviderError(`Invalid JSON response: ${error instanceof Error ? error.message : String(error)}`, provider, error);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

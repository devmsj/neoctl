export type SearchProviderName = "exa" | (string & {});

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
}

export interface ExaSearchProviderConfig {
  mcpUrl?: string;
  toolName?: string;
  timeoutMs?: number;
}

export const DEFAULT_SEARCH_PROVIDER = "exa";
export const DEFAULT_EXA_MCP_URL = "https://mcp.exa.ai/mcp";
export const DEFAULT_EXA_MCP_TOOL_NAME = "web_search_exa";
export const DEFAULT_SEARCH_TIMEOUT_MS = 30_000;

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

export function createSearchProvider(config: SearchProviderConfig = {}, env: NodeJS.ProcessEnv = process.env): SearchProvider {
  const provider = (config.provider ?? env.SEARCH_PROVIDER ?? env.WEB_SEARCH_PROVIDER ?? DEFAULT_SEARCH_PROVIDER).trim().toLowerCase();
  switch (provider) {
    case "exa":
      return createExaSearchProvider({
        mcpUrl: config.exa?.mcpUrl ?? env.EXA_MCP_URL ?? env.WEB_SEARCH_EXA_MCP_URL,
        toolName: config.exa?.toolName ?? env.EXA_MCP_TOOL_NAME ?? env.WEB_SEARCH_EXA_TOOL_NAME,
        timeoutMs: config.exa?.timeoutMs ?? parseOptionalInteger(env.SEARCH_TIMEOUT_MS ?? env.WEB_SEARCH_TIMEOUT_MS),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

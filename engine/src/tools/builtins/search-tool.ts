import type { Tool, ToolResult } from "../tool.js";
import { createSearchProvider, type SearchProvider, type SearchToolInput, type WebSearchResult } from "./search-providers.js";

export interface WebSearchToolInput extends SearchToolInput {
  provider?: string;
}

export interface WebSearchToolOutput {
  query: string;
  provider: string;
  returnedResults: number;
  results: WebSearchResult[];
  truncated?: boolean;
  error?: string;
}

export interface CreateSearchToolOptions {
  provider?: SearchProvider;
}

const DEFAULT_NUM_RESULTS = 5;
const MAX_NUM_RESULTS = 10;
const MAX_HIGHLIGHTS_PER_RESULT = 6;
const MAX_HIGHLIGHT_CHARS = 800;
const MAX_TEXT_CHARS = 1600;

export function createSearchTool(options: CreateSearchToolOptions = {}): Tool<WebSearchToolInput> {
  return {
    name: "search",
    description: "Search the web for current information. OpenAI Responses web search is the default provider and inherits the configured OpenAI URL and API key. Use Exa's official MCP service only when OpenAI search is unavailable or only partially available for the requested queries. Use grep for local workspace text lookup. Do not explicitly select Exa unless the user requests it or OpenAI has failed or returned incomplete availability.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Web search query." },
        provider: { type: "string", description: "Optional backend provider name. OpenAI is the default. Select exa only when the user requests it or OpenAI search is unavailable or partially unavailable for the requested queries." },
        numResults: { type: "integer", description: `Maximum number of results to return, 1-${MAX_NUM_RESULTS}. Defaults to ${DEFAULT_NUM_RESULTS}.` },
        includeDomains: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of domains to include, such as openai.com.",
        },
        excludeDomains: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of domains to exclude.",
        },
        startPublishedDate: { type: "string", description: "Optional earliest published date filter, YYYY-MM-DD when supported by the provider." },
        endPublishedDate: { type: "string", description: "Optional latest published date filter, YYYY-MM-DD when supported by the provider." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    metadata: {
      readOnly: true,
      concurrent: true,
      visible: true,
      maxResultSizeChars: 24000,
      searchHint: "web search via provider backend",
    },
    validate(input) {
      const record = input as Partial<WebSearchToolInput>;
      return {
        query: record.query ?? "",
        provider: record.provider,
        numResults: record.numResults ?? DEFAULT_NUM_RESULTS,
        includeDomains: record.includeDomains,
        excludeDomains: record.excludeDomains,
        startPublishedDate: record.startPublishedDate,
        endPublishedDate: record.endPublishedDate,
      };
    },
    validateInput(input) {
      if (!input.query.trim()) return { ok: false, message: "search.query cannot be empty" };
      if (input.provider !== undefined && !input.provider.trim()) return { ok: false, message: "search.provider cannot be empty" };
      if (!Number.isInteger(input.numResults) || input.numResults < 1 || input.numResults > MAX_NUM_RESULTS) {
        return { ok: false, message: `search.numResults must be between 1 and ${MAX_NUM_RESULTS}` };
      }
      if (input.includeDomains?.some((domain) => !domain.trim())) return { ok: false, message: "search.includeDomains entries cannot be empty" };
      if (input.excludeDomains?.some((domain) => !domain.trim())) return { ok: false, message: "search.excludeDomains entries cannot be empty" };
      if (input.startPublishedDate !== undefined && !input.startPublishedDate.trim()) return { ok: false, message: "search.startPublishedDate cannot be empty" };
      if (input.endPublishedDate !== undefined && !input.endPublishedDate.trim()) return { ok: false, message: "search.endPublishedDate cannot be empty" };
      return { ok: true, value: input };
    },
    isConcurrencySafe() {
      return true;
    },
    async call(input, context, callOptions): Promise<ToolResult> {
      let provider: SearchProvider;
      try {
        provider = options.provider ?? createSearchProvider({ provider: input.provider }, process.env);
      } catch (error) {
        return {
          ok: false,
          output: {
            query: input.query,
            provider: input.provider?.trim() || "unknown",
            returnedResults: 0,
            results: [],
            error: error instanceof Error ? error.message : String(error),
          } satisfies WebSearchToolOutput,
        };
      }

      callOptions.onProgress?.({ toolName: "search", message: `Searching the web with ${provider.name}` });
      try {
        const providerResult = await provider.search(input, context.abortSignal);
        const output: WebSearchToolOutput = {
          query: input.query,
          provider: providerResult.provider,
          returnedResults: providerResult.results.length,
          results: normalizeResults(providerResult.results),
        };
        return { ok: true, output, summary: `${output.returnedResults} web result(s)` };
      } catch (error) {
        const providerName = provider.name;
        return {
          ok: false,
          output: {
            query: input.query,
            provider: providerName,
            returnedResults: 0,
            results: [],
            error: error instanceof Error ? error.message : String(error),
          } satisfies WebSearchToolOutput,
        };
      }
    },
    mapResult(result) {
      return shrinkSearchOutputForTransport(result.output, 21_000);
    },
  };
}

export const searchTool = createSearchTool();

function normalizeResults(results: readonly WebSearchResult[]): WebSearchResult[] {
  return results.map((result) => ({
    title: trimText(result.title, 400),
    url: result.url,
    published: result.published,
    author: result.author,
    score: result.score,
    highlights: result.highlights
      ?.map((highlight) => trimText(highlight, MAX_HIGHLIGHT_CHARS))
      .filter(Boolean)
      .slice(0, MAX_HIGHLIGHTS_PER_RESULT),
    text: result.text ? trimText(result.text, MAX_TEXT_CHARS) : undefined,
  }));
}

function shrinkSearchOutputForTransport(output: unknown, maxChars: number): unknown {
  if (!isSearchOutput(output)) return output;
  const serialized = JSON.stringify(output);
  if (serialized.length <= maxChars) return output;

  const shrunk: WebSearchToolOutput = {
    ...output,
    truncated: true,
    results: output.results.map((result) => ({
      title: trimText(result.title, 240),
      url: result.url,
      published: result.published,
      author: result.author,
      highlights: result.highlights?.slice(0, 3).map((highlight) => trimText(highlight, 300)),
      text: result.text ? trimText(result.text, 600) : undefined,
      score: result.score,
    })),
  };
  return JSON.stringify(shrunk).length <= maxChars
    ? shrunk
    : {
        ...shrunk,
        results: shrunk.results.slice(0, Math.max(1, Math.floor(shrunk.results.length / 2))),
      };
}

function isSearchOutput(value: unknown): value is WebSearchToolOutput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.query === "string" && typeof record.provider === "string" && Array.isArray(record.results);
}

function trimText(value: string, maxChars: number): string {
  const trimmed = value.trim();
  return trimmed.length <= maxChars ? trimmed : `${trimmed.slice(0, maxChars)}…`;
}

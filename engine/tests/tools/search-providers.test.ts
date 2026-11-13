import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createOpenAISearchProvider } from "../../src/tools/builtins/search-providers.js";

async function searchResponse(t: TestContext, output: unknown[], numResults = 5) {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ status: "completed", output }), {
    headers: { "Content-Type": "application/json" },
  }));
  return createOpenAISearchProvider({ apiKey: "test", model: "test-search" }).search({ query: "test", numResults });
}

function part(text: string, url: string, marker: string, title = "Source") {
  const start = text.indexOf(marker);
  assert(start >= 0);
  return { type: "output_text", text, annotations: [{ type: "url_citation", url, title, start_index: start, end_index: start + marker.length }] };
}

const message = (...content: unknown[]) => ({ type: "message", role: "assistant", content });

test("citation indices identify citation markers, not the search result body", async t => {
  const a = "([a.example](https://a.example))", b = "([b.example](https://b.example))";
  const first = `1. **First result**\n   This is the actual first source summary. ${a}`;
  const second = `2. **Second result**\n   This is the actual second source summary. ${b}`;
  const text = `${first}\n\n${second}`;
  const result = await searchResponse(t, [message({ ...part(text, "https://a.example", a), annotations: [
    ...part(text, "https://a.example", a).annotations,
    ...part(text, "https://b.example", b).annotations,
  ] })]);
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0]!.text, first);
  assert.deepEqual(result.results[0]!.highlights, [first]);
  assert.equal(result.results[1]!.text, second);
  assert(!result.results[0]!.text!.includes("second source"));
});

test("citation offsets are relative to each content part, without trimming or joining shifts", async t => {
  const marker = "[source]";
  const first = `  😀 第一段正文。 ${marker}\n\nOther paragraph.`;
  const second = `\n\n第二段正文。 ${marker}`;
  const result = await searchResponse(t, [message(part(first, "https://first.example", marker), part(second, "https://second.example", marker))]);
  assert.equal(result.results[0]!.text, `😀 第一段正文。 ${marker}`);
  assert.equal(result.results[1]!.text, `第二段正文。 ${marker}`);
});

test("missing or invalid citation offsets preserve available body instead of slicing unrelated text", async t => {
  for (const offsets of [{}, { start_index: -1, end_index: 2 }, { start_index: 99, end_index: 100 }, { start_index: 4, end_index: 2 }, { start_index: 0.5, end_index: 2 }]) {
    const text = "A useful source summary.";
    const result = await searchResponse(t, [message({ type: "output_text", text, annotations: [{ type: "url_citation", url: "https://a.example", ...offsets }] })]);
    assert.equal(result.results[0]!.text, text);
  }
});

test("uncited summaries, URL deduplication and result limits remain compatible", async t => {
  const summary = await searchResponse(t, [message({ type: "output_text", text: "Useful uncited summary." })]);
  assert.equal(summary.results[0]!.text, "Useful uncited summary.");
  const marker = "[source]", text = `Useful summary. ${marker}`;
  const cited = part(text, "https://a.example", marker);
  const result = await searchResponse(t, [message(cited, cited, part(text, "https://b.example", marker))], 1);
  assert.equal(result.results.length, 1);
});

test("CRLF paragraph boundaries preserve the full cited paragraph", async t => {
  const marker = "[source]";
  const text = `Introduction.\r\n \t\r\nA useful summary. ${marker}\r\n\r\nUnrelated paragraph.`;
  const result = await searchResponse(t, [message(part(text, "https://a.example", marker))]);
  assert.equal(result.results[0]!.text, `A useful summary. ${marker}`);
});

test("body-only fix leaves the configured request, optional budgets and provider endpoint unchanged", async t => {
  let request: Record<string, unknown> | undefined;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), "https://search.example/v1/responses");
    request = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ status: "completed", output: [] }));
  });
  await createOpenAISearchProvider({ apiKey: "test", model: "test-search", baseUrl: "https://search.example/v1/", searchContextSize: "high", maxOutputTokens: 2400 })
    .search({ query: "test", numResults: 3 });
  assert.equal(request?.model, "test-search");
  assert.equal(request?.tool_choice, "auto");
  assert.equal(request?.max_output_tokens, 2400);
  assert.equal(request?.store, false);
  assert.deepEqual(request?.tools, [{ type: "web_search", search_context_size: "high" }]);
  assert.equal(request?.reasoning, undefined);
});

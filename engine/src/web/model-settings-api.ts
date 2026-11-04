import { publishModelSettings, modelUsage, interruptModelUsers, connectionUsage, interruptConnectionUsers } from "../model/settings-sync.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ModelSettingsStore, compositionModelConfig, resolveComposition, validateComposition, type Composition } from "../model/settings-store.js";
import { saveModelMetadata, deleteModelMetadata, modelMetadataIds, loadModelCatalog, ModelMetadataConflict, supportsImageInput } from "../model/context-window.js";
import { createModelGatewayFromConfig } from "../model/provider-factory.js";
import { compositionProviders } from "../model/composition-runtime.js";
import { createTextMessage, type Message, type ToolUseRequest } from "../types/messages.js";
import { ToolRegistry } from "../tools/registry.js";
import { InMemoryAppState } from "../app/app-state.js";
import type { ModelRequest } from "../model/model-gateway.js";

export async function testModelComposition(c: Composition, connections: Parameters<typeof validateComposition>[1], selection: string[], imageConsent: boolean, signal?: AbortSignal) {
  if (!Array.isArray(selection)) throw new Error("检测项目无效。");
  c = structuredClone(c);
  const mainSelected = selection.includes("main") || selection.includes("vision");
  if (!mainSelected) c.main = { api: "", model: "", effort: "high" };
  if (!selection.includes("image")) c.image = { api: "", model: "" };
  if (!selection.includes("search")) c.search = { ...c.search, api: "", model: "", context: "", tokens: undefined, timeout: undefined, toolType: "web_search" };
  if (!selection.includes("exa")) c.search = { ...c.search, exa: false, exaUrl: "https://mcp.exa.ai/mcp", exaTool: "web_search_exa", exaTimeout: undefined };
  validateComposition(c, connections, mainSelected);
  c = resolveComposition(c, connections);
  if (selection.includes("image") && !imageConsent) throw new Error("请确认图片生成调用费用。");
  if (!selection.length || selection.some(s => !["main", "vision", "image", "search", "exa"].includes(s))) throw new Error("检测项目无效。");
  const providers = compositionProviders(c, connections), results = [];
  for (const id of [...new Set(selection)]) {
    const started = Date.now();
    try {
      signal?.throwIfAborted();
      let detail = "";
      if (id === "main" || id === "vision") {
        const config = compositionModelConfig(c, connections)!;
        const gateway = createModelGatewayFromConfig(config);
        const user = createTextMessage("user", id === "main" ? "Call the configuration_probe tool once with value 7. After receiving the tool result, reply with its value." : "Describe the supplied image in one sentence.");
        if (id === "vision") {
          if (supportsImageInput(c.main.model) !== true) throw new Error("当前主模型未配置图片输入能力。");
          user.blocks.push({ type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAcElEQVR4nO3PAQkAAAyEwO9feoshgnABdNvJ8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3M7AHH/PDiTEQiLgAAAABJRU5ErkJggg==" });
        }
        const tools = id === "main" ? [{ name: "configuration_probe", description: "Return the supplied value.", inputSchema: { type: "object", properties: { value: { type: "integer" } }, required: ["value"], additionalProperties: false } }] : [];
        const messages: Message[] = [user], uses: ToolUseRequest[] = [];
        const collectUse = (use: ToolUseRequest) => {
          const existing = uses.find(item => item.id === use.id);
          if (!existing) uses.push(use);
          else if (existing.name !== use.name || JSON.stringify(existing.input) !== JSON.stringify(use.input)) throw new Error("同一工具调用 ID 的内容不一致。");
        };
        const request: ModelRequest = { model: config.model, messages, tools, stream: true, cancellation: signal };
        let text = "", completed = false;
        for await (const event of gateway.stream(request)) {
          if (event.type === "error") throw event.error;
          if (event.type === "response_incomplete") throw new Error(`回复不完整：${event.reason}`);
          if (event.type === "assistant_message") {
            messages.push(event.message);
            // Messages adapters publish validated calls inside the completed message.
            for (const block of event.message.blocks) if (block.type === "tool_use") collectUse({ id: block.id, name: block.name, input: block.input });
          }
          if (event.type === "assistant_delta") text += event.text;
          if (event.type === "tool_use") collectUse(event.toolUse);
          if (event.type === "response_completed") completed = true;
        }
        if (id === "main") {
          if (!completed) throw new Error("工具调用流未完整结束。");
          if (!uses.length || uses.some(u => u.name !== "configuration_probe" || (u.input as { value?: unknown })?.value !== 7)) throw new Error("未返回预期工具调用，工具能力尚未通过。");
          for (const use of uses) {
            if (!messages.some(m => m.blocks.some(b => b.type === "tool_use" && b.id === use.id))) messages.push({ ...createTextMessage("assistant", ""), blocks: [{ type: "tool_use", ...use }] });
            messages.push({ ...createTextMessage("tool_result", ""), blocks: [{ type: "tool_result", toolUseId: use.id, name: use.name, ok: true, output: { value: 7 } }] });
          }
          text = ""; completed = false;
          for await (const event of gateway.stream({ ...request, messages })) {
            if (event.type === "error") throw event.error;
            if (event.type === "assistant_delta") text += event.text;
            if (event.type === "response_completed") completed = true;
            if (event.type === "response_incomplete") throw new Error("工具续轮回复不完整。");
          }
          if (!completed || !text.includes("7")) throw new Error("工具续轮未返回完整预期回复。");
          detail = "文本、流式输出与工具续轮通过";
        } else { if (!completed || !text.trim()) throw new Error("图片请求未返回完整文本回复。"); detail = text.slice(0, 400); }
      } else if (id === "search" || id === "exa") {
        const provider = id === "search" ? providers.openai : providers.exa;
        if (!provider) throw new Error("此搜索能力未启用。");
        const result = await provider.search({ query: "OpenAI API documentation", numResults: 2 }, signal);
        if (!result.results.some(r => /^https?:/.test(r.url) && r.url !== "https://openai.com/search")) throw new Error("未返回真实来源链接，不能确认搜索能力。");
        if (id === "search") { const raw = result.raw as { output?: Array<{ type?: string }> }; if (!raw?.output?.some(x => x.type === "web_search_call")) throw new Error("网关未提供 web_search 调用记录，不能确认原生搜索能力。"); }
        detail = `${result.results.length} 条结果；${result.results[0]?.url}`;
      } else {
        if (!providers.image) throw new Error("图片生成未启用。");
        const dir = await mkdtemp(path.join(tmpdir(), "neo-image-check-"));
        try {
          const context = { agentId: "configuration-test", tools: new ToolRegistry(), appState: new InMemoryAppState("configuration-test", dir), options: { mainLoopModel: c.main.model }, abortSignal: signal, emit() {} };
          const input = { mode: "generate" as const, semanticName: "连接检测蓝色圆形", prompt: "A simple blue circle on a white background.", model: c.image.model, n: 1, outputDir: dir };
          const result = await providers.image.call!(input, context, {});
          if (!result.ok) throw new Error(JSON.stringify(result.output));
          detail = "已生成图片并完成工具文件校验";
        } finally { await rm(dir, { recursive: true, force: true }); }
      }
      results.push({ id, ok: true, detail, durationMs: Date.now() - started });
    } catch (e) { results.push({ id, ok: false, detail: e instanceof Error ? e.message : String(e), durationMs: Date.now() - started }); }
  }
  return results;
}

export async function handleModelSettingsRequest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (!url.pathname.startsWith("/api/model-settings")) return false;
  const send = (data: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(data)); };
  const store = new ModelSettingsStore();
  try {
    if (req.method === "GET" && url.pathname === "/api/model-settings") { send(store.publicState()); return true; }
    if (req.method !== "POST") { send({ error: "not found" }, 404); return true; }
    let text = ""; for await (const chunk of req) { text += chunk.toString(); if (Buffer.byteLength(text) > 2_000_000) throw new Error("配置请求过大。"); }
    const body = JSON.parse(text || "{}");
    if (url.pathname.endsWith("/connection")) send(store.publicState(store.saveConnection(body.revision, body.connection)));
    else if (url.pathname.endsWith("/connection/usage")) {
      const state = store.initialize();
      if (!state.connections.some(c => c.id === body.id)) throw new ModelMetadataConflict("API 配置已不存在。");
      send({ revision: state.revision, usage: connectionUsage(body.id) });
    }
    else if (url.pathname.endsWith("/connection/delete")) {
      if (body.confirmed !== true) throw new Error("请确认删除 API。");
      const state = store.removeConnection(body.revision, body.id, () => {
        if (connectionUsage(body.id).running > 0 && body.interruptConfirmed !== true) throw new ModelMetadataConflict("有活动会话使用此 API，删除将打断会话，请重新确认。");
      });
      interruptConnectionUsers(body.id);
      send({ ...store.publicState(state), activation: publishModelSettings() });
    }
    else if (url.pathname.endsWith("/apply")) { const state = store.apply(body.revision, body.composition); send({ ...store.publicState(state), activation: publishModelSettings(true) }); }
    else if (url.pathname.endsWith("/metadata")) { saveModelMetadata(body.entry, body.original, body.catalogRevision); send({ ...store.publicState(), activation: publishModelSettings() }); }
    else if (url.pathname.endsWith("/metadata/usage")) {
      const catalog = loadModelCatalog();
      const entry = catalog.models.find(m => m.id === body.id);
      if (!entry) throw new ModelMetadataConflict("模型条目已不存在，请重新加载。");
      send({ usage: modelUsage(modelMetadataIds(entry)), original: entry, catalogRevision: catalog.revision });
    }
    else if (url.pathname.endsWith("/metadata/delete")) {
      if (body.confirmed !== true || typeof body.catalogRevision !== "string") throw new Error("请确认删除模型。");
      const ids = modelMetadataIds(body.original);
      deleteModelMetadata(body.original, body.catalogRevision, () => {
        if (modelUsage(ids).running > 0 && body.interruptConfirmed !== true) throw new ModelMetadataConflict("有会话占用该模型，删除会中断会话。请重新确认删除。");
      });
      store.clearRemovedModels(ids);
      interruptModelUsers(ids);
      send({ ...store.publicState(), activation: publishModelSettings() });
    }
    else if (url.pathname.endsWith("/test")) {
      const state = store.initialize(); if (state.revision !== body.revision) throw new Error("API 配置已更新，请重新加载后检测。");
      const controller = new AbortController(); const abort = () => { if (!res.writableEnded) controller.abort(); }; res.on("close", abort);
      const timeout = setTimeout(() => controller.abort(new Error("检测超时")), 600000);
      try { send({ results: await testModelComposition(body.composition, state.connections, body.selection, body.imageConsent === true, controller.signal) }); }
      finally { clearTimeout(timeout); res.off("close", abort); }
    } else send({ error: "not found" }, 404);
  } catch (e) { send({ error: e instanceof Error ? e.message : String(e) }, e instanceof ModelMetadataConflict ? 409 : 400); }
  return true;
}

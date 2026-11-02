import { findModelMetadata, modelProtocols } from "./context-window.js";
import type { ModelGateway } from "./model-gateway.js";
import { NotConfiguredModelGateway } from "./model-gateway.js";
import { AnthropicAdapter } from "./anthropic-adapter.js";
import { OpenAIAdapter } from "./openai-adapter.js";
import type { ModelProviderConfig, OpenAIProviderConfig } from "./config.js";
import { readModelProviderConfig } from "./config.js";

export function createModelGatewayFromConfig(config: ModelProviderConfig | undefined): ModelGateway {
  const gateway = createGateway(config);
  if (!config) return gateway;
  const stream = gateway.stream.bind(gateway);
  gateway.stream = (request) => {
    const model = request.model ?? config.model;
    const metadata = findModelMetadata(model);
    const reasoning = request.reasoning === undefined ? config.defaultReasoning : request.reasoning;
    if (metadata && !modelProtocols(metadata).includes(config.provider)) throw new Error(`模型 ${model} 不支持当前接口，请重新选择模型。`);
    if (metadata?.reasoning === false && reasoning?.effort) throw new Error(`模型 ${model} 已关闭推理，请重新选择推理设置。`);
    if (metadata?.reasoningEfforts && reasoning?.effort && !metadata.reasoningEfforts.includes(reasoning.effort)) throw new Error(`模型 ${model} 的档位 ${reasoning.effort} 已不可用，请重新选择。`);
    return stream(request);
  };
  return gateway;
}
function createGateway(config: ModelProviderConfig | undefined): ModelGateway {
  if (!config) return new NotConfiguredModelGateway();

  if (config.provider === "anthropic") return new AnthropicAdapter({
    ...config, apiVersion: config.anthropic?.apiVersion,
    thinkingBudgetTokens: config.anthropic?.thinkingBudgetTokens,
  });
  return createOpenAIGateway(config);
}

export function createModelGatewayFromProcessEnv(env: NodeJS.ProcessEnv = process.env): ModelGateway {
  return createModelGatewayFromConfig(readModelProviderConfig(env));
}

function createOpenAIGateway(config: OpenAIProviderConfig): ModelGateway {
  return new OpenAIAdapter({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
    endpoint: "responses",
    timeoutMs: config.timeoutMs,
    streamIdleTimeoutMs: config.streamIdleTimeoutMs,
    maxRetries: config.maxRetries,
    defaultMaxOutputTokens: config.defaultMaxOutputTokens,
    defaultReasoning: config.defaultReasoning,
  });
}

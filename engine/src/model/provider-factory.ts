import type { ModelGateway } from "./model-gateway.js";
import { NotConfiguredModelGateway } from "./model-gateway.js";
import { OpenAIAdapter } from "./openai-adapter.js";
import type { ModelProviderConfig, OpenAIProviderConfig } from "./config.js";
import { readModelProviderConfig } from "./config.js";

export function createModelGatewayFromConfig(config: ModelProviderConfig | undefined): ModelGateway {
  if (!config) return new NotConfiguredModelGateway();

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
    endpoint: config.openai?.endpoint,
    timeoutMs: config.timeoutMs,
    streamIdleTimeoutMs: config.streamIdleTimeoutMs,
    maxRetries: config.maxRetries,
    defaultMaxOutputTokens: config.defaultMaxOutputTokens,
    defaultReasoning: config.defaultReasoning,
  });
}

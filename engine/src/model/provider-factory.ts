import type { ModelGateway } from "./model-gateway";
import { NotConfiguredModelGateway } from "./model-gateway";
import { OpenAIAdapter } from "./openai-adapter";
import type { ModelProviderConfig, OpenAIProviderConfig } from "./config";
import { readModelProviderConfig } from "./config";

export function createModelGatewayFromConfig(config: ModelProviderConfig | undefined): ModelGateway {
  if (!config) return new NotConfiguredModelGateway();

  switch (config.provider) {
    case "openai":
      return createOpenAIGateway(config);
  }
}

export function createModelGatewayFromProcessEnv(env: NodeJS.ProcessEnv = process.env): ModelGateway {
  return createModelGatewayFromConfig(readModelProviderConfig(env));
}

function createOpenAIGateway(config: OpenAIProviderConfig): ModelGateway {
  return new OpenAIAdapter({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
    fallbackModel: config.fallbackModel,
    endpoint: config.openai?.endpoint,
    timeoutMs: config.timeoutMs,
    streamIdleTimeoutMs: config.streamIdleTimeoutMs,
    maxRetries: config.maxRetries,
    defaultMaxOutputTokens: config.defaultMaxOutputTokens,
    defaultReasoning: config.defaultReasoning,
  });
}

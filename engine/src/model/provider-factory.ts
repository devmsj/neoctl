import type { ModelGateway } from "./model-gateway.js";
import { NotConfiguredModelGateway } from "./model-gateway.js";
import { AnthropicAdapter } from "./anthropic-adapter.js";
import { DeepSeekAdapter } from "./deepseek-adapter.js";
import { KimiAdapter } from "./kimi-adapter.js";
import { OpenAIAdapter } from "./openai-adapter.js";
import type { AnthropicProviderConfig, DeepSeekProviderConfig, KimiProviderConfig, ModelProviderConfig, OpenAIProviderConfig } from "./config.js";
import { readModelProviderConfig } from "./config.js";

export function createModelGatewayFromConfig(config: ModelProviderConfig | undefined): ModelGateway {
  if (!config) return new NotConfiguredModelGateway();

  switch (config.provider) {
    case "openai":
      return createOpenAIGateway(config);
    case "anthropic":
      return createAnthropicGateway(config);
    case "deepseek":
      return createDeepSeekGateway(config);
    case "kimi":
      return createKimiGateway(config);
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

function createAnthropicGateway(config: AnthropicProviderConfig): ModelGateway {
  return new AnthropicAdapter({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
    fallbackModel: config.fallbackModel,
    anthropicVersion: config.anthropic?.version,
    timeoutMs: config.timeoutMs,
    streamIdleTimeoutMs: config.streamIdleTimeoutMs,
    maxRetries: config.maxRetries,
    defaultMaxOutputTokens: config.defaultMaxOutputTokens,
    defaultReasoning: config.defaultReasoning,
  });
}

function createDeepSeekGateway(config: DeepSeekProviderConfig): ModelGateway {
  return new DeepSeekAdapter({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
    fallbackModel: config.fallbackModel,
    timeoutMs: config.timeoutMs,
    streamIdleTimeoutMs: config.streamIdleTimeoutMs,
    maxRetries: config.maxRetries,
    defaultMaxOutputTokens: config.defaultMaxOutputTokens,
    defaultReasoning: config.defaultReasoning,
  });
}

function createKimiGateway(config: KimiProviderConfig): ModelGateway {
  return new KimiAdapter({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
    fallbackModel: config.fallbackModel,
    timeoutMs: config.timeoutMs,
    streamIdleTimeoutMs: config.streamIdleTimeoutMs,
    maxRetries: config.maxRetries,
    defaultMaxOutputTokens: config.defaultMaxOutputTokens,
    defaultReasoning: config.defaultReasoning,
  });
}

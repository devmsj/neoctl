import type { ModelGateway, ModelRequest, ModelStreamEvent } from "./model-gateway";

export interface ProviderCapabilities {
  streaming: boolean;
  functionTools: boolean;
  parallelToolCalls: boolean;
  structuredOutput: boolean;
  previousResponseId: boolean;
  imageInput: boolean;
  fileInput: boolean;
  reasoningConfig: boolean;
  builtInTools: boolean;
}

export interface ProviderAdapter extends ModelGateway {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  stream(request: ModelRequest): AsyncIterable<ModelStreamEvent>;
}

export interface ImageResultMetadata {
  model?: string;
  size?: string;
  quality?: string;
  outputFormat?: string;
  background?: string;
  prompt?: string;
  mode?: string;
  semanticName?: string;
  images: Array<{ label?: string; width?: number; height?: number; mimeType?: string; hasAlphaChannel?: boolean; hasTransparentPixels?: boolean }>;
}

/** Explicit allowlist: never send image payloads, credentials or local storage paths to UI metadata. */
export function imageResultMetadata(output: unknown): ImageResultMetadata | undefined {
  if (!output || typeof output !== "object" || Array.isArray(output)) return undefined;
  const data = output as Record<string, unknown>;
  if (!Array.isArray(data.images)) return undefined;
  const text = (value: unknown) => typeof value === "string" ? value : undefined;
  const dimension = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
  const flag = (value: unknown) => typeof value === "boolean" ? value : undefined;
  return {
    model: text(data.model), size: text(data.size), quality: text(data.quality), outputFormat: text(data.outputFormat),
    background: text(data.background), prompt: text(data.prompt), mode: text(data.mode), semanticName: text(data.semanticName),
    images: data.images.map(value => {
      const image = value && typeof value === "object" ? value as Record<string, unknown> : {};
      return { label: text(image.label), width: dimension(image.width), height: dimension(image.height), mimeType: text(image.mimeType), hasAlphaChannel: flag(image.hasAlphaChannel), hasTransparentPixels: flag(image.hasTransparentPixels) };
    }),
  };
}

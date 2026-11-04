import type { ModelGateway, ModelRequest } from "../model/model-gateway.js";
import type { ContextMetrics } from "../types/events.js";

/** Last counted input plus local growth; no learned ratios or usage-based calibration. */
export class ContextTokenCalibration {
  private anchor?: { model?: string; gateway: ModelGateway; offset: number };

  reset(): void { this.anchor = undefined; }

  apply(metrics: ContextMetrics, gateway: ModelGateway, request?: ModelRequest): ContextMetrics {
    const anchor = this.anchor;
    let tokens: number | undefined;
    if (request) {
      try { tokens = gateway.estimateInputTokens?.(request); } catch { /* Optional local estimate. */ }
    }
    if (anchor && anchor.model === metrics.model && anchor.gateway === gateway) tokens = (tokens ?? metrics.estimatedInputTokens) + anchor.offset;
    return this.withTokens(metrics, tokens);
  }

  async correct(metrics: ContextMetrics, gateway: ModelGateway, request: ModelRequest): Promise<ContextMetrics> {
    // Each request starts from its own local estimate, never a stale remote correction.
    let local: number | undefined;
    try { local = gateway.estimateInputTokens?.(request); } catch { /* Keep the existing estimate. */ }
    let tokens: number | undefined;
    try { tokens = await gateway.countInputTokens?.(request); } catch { /* Unsupported/broken counters are silent. */ }
    if (Number.isSafeInteger(tokens) && tokens! > 0 && !request.cancellation?.aborted) {
      this.anchor = { model: metrics.model, gateway, offset: tokens! - (local ?? metrics.estimatedInputTokens) };
      return this.withTokens(metrics, tokens);
    }
    this.reset();
    return this.withTokens(metrics, local);
  }

  private withTokens(metrics: ContextMetrics, tokens: number | undefined): ContextMetrics {
    if (!Number.isFinite(tokens) || tokens! < 0) return metrics;
    const estimatedInputTokens = Math.max(0, Math.ceil(tokens!));
    return { ...metrics, estimatedInputTokens, inputTokenSource: "estimate" as const,
      contextUsageRatio: metrics.contextWindowTokens ? estimatedInputTokens / metrics.contextWindowTokens : undefined };
  }
}

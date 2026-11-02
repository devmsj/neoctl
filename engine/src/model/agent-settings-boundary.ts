import { ModelSettingsStore, compositionModelConfig } from "./settings-store.js";
import { registerCompositionTools } from "./composition-runtime.js";
import { createModelGatewayFromConfig } from "./provider-factory.js";
import { LoggingModelGateway } from "./communication-logger.js";
import { registerSettingsConsumer, settingsGatewayRevision, trackSettingsGateway } from "./settings-sync.js";
import type { ModelGateway } from "./model-gateway.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { BeforeTurnUpdate } from "../core/query.js";

/** A child has its own boundary; it must not mutate the parent's active tool batch. */
export function agentSettingsBoundary(inheritedGateway?: ModelGateway) {
  const store = new ModelSettingsStore();
  let applied = store.read()?.applied;
  const inherited = settingsGatewayRevision(inheritedGateway);
  let revision = inherited ? inherited.revision : applied?.revision;
  let latest: BeforeTurnUpdate | undefined;
  const consumer = { active: false, isModelConfigurationBusy() { return this.active; }, refreshModelConfigurationIfIdle() {} };
  registerSettingsConsumer(consumer);
  return {
    start() { consumer.active = true; },
    stop() { consumer.active = false; },
    beforeTurn(): BeforeTurnUpdate | undefined {
      const next = store.read()?.applied;
      if (!next || next.revision === revision) return latest;
      const config = compositionModelConfig(next.composition, next.connections);
      if (!config) return latest;
      applied = next; revision = next.revision;
      const rawGateway = createModelGatewayFromConfig(config);
      const gateway = inheritedGateway instanceof LoggingModelGateway ? new LoggingModelGateway(rawGateway, inheritedGateway.logger) : rawGateway;
      latest = { modelGateway: trackSettingsGateway(gateway, next.revision), settings: { model: config.model, reasoning: config.defaultReasoning } };
      return latest;
    },
    tools(tools: ToolRegistry): ToolRegistry {
      if (!latest || !applied) return tools;
      const snapshot = tools.clone();
      registerCompositionTools(snapshot, applied.composition, applied.connections);
      return snapshot;
    },
  };
}

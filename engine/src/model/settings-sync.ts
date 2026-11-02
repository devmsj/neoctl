import { modelSettingsHome } from "./settings-files.js";

export interface SettingsConsumer {
  isModelConfigurationBusy(): boolean;
  refreshModelConfigurationIfIdle(): void;
}
const consumers = new Set<{ home: string; ref: WeakRef<SettingsConsumer> }>();
const listeners = new Set<{ home: string; ref: WeakRef<() => void> }>();
export function registerSettingsConsumer(consumer: SettingsConsumer): void {
  consumers.add({ home: modelSettingsHome(), ref: new WeakRef(consumer) });
}
export function observeModelSettings(listener: () => void): void {
  listeners.add({ home: modelSettingsHome(), ref: new WeakRef(listener) });
}
/** Only version/state notifications; no connection secrets cross the UI boundary. */
export function publishModelSettings(): { deferred: boolean; runningSessions: number } {
  const home = modelSettingsHome();
  let runningSessions = 0;
  for (const entry of consumers) {
    const consumer = entry.ref.deref();
    if (!consumer) { consumers.delete(entry); continue; }
    if (entry.home !== home) continue;
    if (consumer.isModelConfigurationBusy()) runningSessions++;
    else consumer.refreshModelConfigurationIfIdle();
  }
  for (const entry of listeners) {
    const listener = entry.ref.deref();
    if (!listener) listeners.delete(entry);
    else if (entry.home === home) listener();
  }
  return { deferred: runningSessions > 0, runningSessions };
}

// Keep the inherited provider revision with its gateway, including child-task handoff.
const gatewayRevisions = new WeakMap<object, string | undefined>();
export function trackSettingsGateway<T extends object>(gateway: T, revision: string | undefined): T {
  gatewayRevisions.set(gateway, revision);
  return gateway;
}
export function settingsGatewayRevision(gateway: object | undefined): { revision: string | undefined } | undefined {
  return gateway && gatewayRevisions.has(gateway) ? { revision: gatewayRevisions.get(gateway) } : undefined;
}

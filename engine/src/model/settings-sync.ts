import { modelSettingsHome } from "./settings-files.js";

export interface SettingsConsumer {
  isModelConfigurationBusy(): boolean;
  refreshModelConfigurationIfIdle(): void;
  getHeldModelIds?(): string[];
  interruptForModelRemoval?(): void;
}

/** Counts live holders in this service, including other isolated users and child threads. */
export function modelUsage(ids: readonly string[]): { holders: number; running: number } {
  const matches = matchingConsumers(ids);
  return { holders: matches.length, running: matches.filter(c => c.isModelConfigurationBusy()).length };
}
export function interruptModelUsers(ids: readonly string[]): void {
  for (const consumer of matchingConsumers(ids)) consumer.interruptForModelRemoval?.();
}
function matchingConsumers(ids: readonly string[]): SettingsConsumer[] {
  const wanted = new Set(ids.map(id => id.trim().toLowerCase()));
  const result: SettingsConsumer[] = [];
  for (const entry of consumers) {
    const consumer = entry.ref.deref();
    if (!consumer) { consumers.delete(entry); continue; }
    if (entry.home === modelSettingsHome() && consumer.getHeldModelIds?.().some(id => wanted.has(id.trim().toLowerCase()))) result.push(consumer);
  }
  return result;
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

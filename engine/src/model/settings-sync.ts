import { modelSettingsHome } from "./settings-files.js";

export interface SettingsConsumer {
  isModelConfigurationBusy(): boolean;
  refreshModelConfigurationIfIdle(): void;
  getHeldModelIds?(): string[];
  getHeldConnectionIds?(): string[];
  interruptForModelRemoval?(): void;
  restoreModelConfiguration?(): void;
}

/** Counts live holders in this service, including other isolated users and child threads. */
export function modelUsage(ids: readonly string[]): { holders: number; running: number } {
  const matches = matchingConsumers(ids);
  return { holders: matches.length, running: matches.filter(c => c.isModelConfigurationBusy()).length };
}
export function interruptModelUsers(ids: readonly string[]): void {
  for (const consumer of matchingConsumers(ids)) consumer.interruptForModelRemoval?.();
}
export function connectionUsage(id: string): { holders: number; running: number } {
  const matches = matchingConsumers([id], true);
  return { holders: matches.length, running: matches.filter(c => c.isModelConfigurationBusy()).length };
}
export function interruptConnectionUsers(id: string): void {
  for (const consumer of matchingConsumers([id], true)) consumer.interruptForModelRemoval?.();
}
function matchingConsumers(ids: readonly string[], connection = false): SettingsConsumer[] {
  const wanted = new Set(ids.map(id => id.trim().toLowerCase()));
  const result: SettingsConsumer[] = [];
  for (const entry of consumers) {
    const consumer = entry.ref.deref();
    if (!consumer) { consumers.delete(entry); continue; }
    if (entry.home === modelSettingsHome() && (connection ? consumer.getHeldConnectionIds?.() : consumer.getHeldModelIds?.())?.some(id => wanted.has(id.trim().toLowerCase()))) result.push(consumer);
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
export function publishModelSettings(restoreCleared = false): { deferred: boolean; runningSessions: number } {
  const home = modelSettingsHome();
  let runningSessions = 0;
  for (const entry of consumers) {
    const consumer = entry.ref.deref();
    if (!consumer) { consumers.delete(entry); continue; }
    if (entry.home !== home) continue;
    if (restoreCleared) consumer.restoreModelConfiguration?.();
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
const gatewayConnections = new WeakMap<object, () => string[]>();
export function settingsGatewayConnections(gateway: object): string[] { return gatewayConnections.get(gateway)?.().filter(Boolean) ?? []; }
/** connections may be live: a routed gateway holds whichever connection serves the session's current model. */
export function trackSettingsGateway<T extends object>(gateway: T, revision: string | undefined, connections: string[] | (() => string[]) = []): T {
  const list = connections;
  gatewayConnections.set(gateway, typeof list === "function" ? list : () => list);
  gatewayRevisions.set(gateway, revision);
  return gateway;
}
export function settingsGatewayRevision(gateway: object | undefined): { revision: string | undefined } | undefined {
  return gateway && gatewayRevisions.has(gateway) ? { revision: gatewayRevisions.get(gateway) } : undefined;
}

import { WebRuntimeRouter } from 'neoctl/web/index.js';

const INSTALL_KEY = Symbol.for('neoctl-web.runtime-router-idle-cleanup');
const routerTimers = new WeakMap();

export function installRuntimeRouterIdleCleanup(options = {}) {
  const prototype = WebRuntimeRouter.prototype;
  if (prototype[INSTALL_KEY]) return;
  prototype[INSTALL_KEY] = true;
  const idleMs = Math.max(60_000, Number(options.idleMs || process.env.NEO_RUNTIME_IDLE_MS || 15 * 60_000));
  const originalGet = prototype.get;

  prototype.get = function getWithIdleCleanup(scope = {}) {
    const result = originalGet.call(this, scope);
    const key = runtimeScopeKey(scope);
    if (key.startsWith('tab:')) scheduleCleanup(this, key, result, idleMs);
    return result;
  };
}

function scheduleCleanup(router, key, replPromise, idleMs) {
  let timers = routerTimers.get(router);
  if (!timers) {
    timers = new Map();
    routerTimers.set(router, timers);
  }
  clearTimeout(timers.get(key));
  const timer = setTimeout(async () => {
    timers.delete(key);
    if (router.repls?.get(key) !== replPromise) return;
    let repl;
    try { repl = await replPromise; } catch { return; }
    const active = repl.busy
      || repl.subscribers?.size > 0
      || repl.backgroundSessionRuns?.size > 0
      || Number(repl.backgroundTaskCount || 0) > 0;
    if (active) {
      scheduleCleanup(router, key, replPromise, idleMs);
      return;
    }
    router.repls.delete(key);
  }, idleMs);
  timer.unref?.();
  timers.set(key, timer);
}

function runtimeScopeKey(scope) {
  const tabId = String(scope?.tabId || '').trim();
  if (tabId) return `tab:${tabId}`;
  const sessionId = String(scope?.sessionId || '').trim();
  if (sessionId) return `session:${sessionId}`;
  return '__default__';
}

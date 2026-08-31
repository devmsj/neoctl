import { WebRuntimeRouter } from 'neoctl/web/index.js';

const INSTALL_KEY = Symbol.for('neoctl-web.runtime-router-session-hubs');
const routerTimers = new WeakMap();
const routerAccessTimes = new WeakMap();

export function installRuntimeRouterIdleCleanup(options = {}) {
  const prototype = WebRuntimeRouter.prototype;
  if (prototype[INSTALL_KEY]) return;
  prototype[INSTALL_KEY] = true;

  const idleMs = Math.max(60_000, positiveNumber(options.idleMs || process.env.NEO_RUNTIME_IDLE_MS, 15 * 60_000));
  const maxSessions = Math.max(1, positiveNumber(options.maxSessions || process.env.NEO_RUNTIME_MAX_SESSIONS, 64));
  const originalGet = prototype.get;

  prototype.get = function getSharedSessionRuntime(scope = {}) {
    const tabId = normalizeScopeValue(scope.tabId);
    const sessionId = normalizeScopeValue(scope.sessionId);
    const key = sessionId ? `session:${sessionId}` : tabId ? `tab:${tabId}` : '__default__';
    let result = this.repls?.get(key);

    if (!result && sessionId && tabId) {
      const tabKey = `tab:${tabId}`;
      const bootstrap = this.repls?.get(tabKey);
      if (bootstrap) {
        result = promoteBootstrapRuntime(this, originalGet, bootstrap, tabKey, key, sessionId);
        this.repls.set(key, result);
      }
    }

    if (!result) {
      result = originalGet.call(this, sessionId ? { sessionId } : tabId ? { tabId } : {});
    }

    touchRuntime(this, key);
    scheduleCleanup(this, key, result, idleMs);
    void enforceSessionLimit(this, maxSessions);
    return result;
  };
}

function promoteBootstrapRuntime(router, originalGet, bootstrap, tabKey, sessionKey, sessionId) {
  let promoted;
  promoted = bootstrap.then(async (repl) => {
    if (runtimeSessionId(repl) === sessionId) {
      if (router.repls?.get(tabKey) === bootstrap) router.repls.delete(tabKey);
      clearRuntimeTimer(router, tabKey);
      clearRuntimeAccessTime(router, tabKey);
      return repl;
    }

    if (router.repls?.get(sessionKey) === promoted) router.repls.delete(sessionKey);
    return originalGet.call(router, { sessionId });
  });
  return promoted;
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
    if (isRuntimeActive(repl)) {
      scheduleCleanup(router, key, replPromise, idleMs);
      return;
    }
    router.repls.delete(key);
    clearRuntimeAccessTime(router, key);
  }, idleMs);
  timer.unref?.();
  timers.set(key, timer);
}

async function enforceSessionLimit(router, maxSessions) {
  const entries = [...(router.repls?.entries() || [])]
    .filter(([key]) => key.startsWith('session:'));
  if (entries.length <= maxSessions) return;

  const accessTimes = routerAccessTimes.get(router) || new Map();
  entries.sort(([left], [right]) => (accessTimes.get(left) || 0) - (accessTimes.get(right) || 0));
  let overflow = entries.length - maxSessions;
  for (const [key, promise] of entries) {
    if (overflow <= 0) break;
    if (router.repls?.get(key) !== promise) continue;
    let repl;
    try { repl = await promise; } catch { repl = undefined; }
    if (repl && isRuntimeActive(repl)) continue;
    if (router.repls?.get(key) !== promise) continue;
    router.repls.delete(key);
    clearRuntimeTimer(router, key);
    clearRuntimeAccessTime(router, key);
    overflow -= 1;
  }
}

function isRuntimeActive(repl) {
  return Boolean(
    repl?.busy
      || repl?.subscribers?.size > 0
      || repl?.backgroundSessionRuns?.size > 0
      || Number(repl?.backgroundTaskCount || 0) > 0
  );
}

function runtimeSessionId(repl) {
  return String(repl?.runtime?.engine?.snapshot?.().session?.sessionId || '').trim();
}

function touchRuntime(router, key) {
  let accessTimes = routerAccessTimes.get(router);
  if (!accessTimes) {
    accessTimes = new Map();
    routerAccessTimes.set(router, accessTimes);
  }
  accessTimes.set(key, Date.now());
}

function clearRuntimeTimer(router, key) {
  const timers = routerTimers.get(router);
  if (!timers) return;
  clearTimeout(timers.get(key));
  timers.delete(key);
}

function clearRuntimeAccessTime(router, key) {
  routerAccessTimes.get(router)?.delete(key);
}

function normalizeScopeValue(value) {
  const normalized = String(value || '').trim();
  return normalized || undefined;
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function runtimeScopeKey(scope = {}) {
  const sessionId = normalizeScopeValue(scope.sessionId);
  if (sessionId) return `session:${sessionId}`;
  const tabId = normalizeScopeValue(scope.tabId);
  if (tabId) return `tab:${tabId}`;
  return '__default__';
}

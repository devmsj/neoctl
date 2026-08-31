import fsp from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_REFRESH_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 12_000;
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const CODEX_USER_AGENT = 'codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal';

export function createCpaQuotaMonitor({
  configFile,
  refreshMs = DEFAULT_REFRESH_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
} = {}) {
  let config = { url: '', password: '' };
  let quotas = [];
  let timer;
  let refreshPromise;

  async function start() {
    config = await readConfig(configFile);
    await refresh();
    timer = setInterval(() => { void refresh(); }, refreshMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = undefined;
  }

  function getPublicState() {
    return {
      config: {
        url: config.url,
        hasPassword: Boolean(config.password),
      },
      quotas,
    };
  }

  async function updateConfig(value) {
    const next = normalizeConfig(value);
    config = {
      ...next,
      password: value?.preservePassword && config.password ? config.password : next.password,
    };
    await writeConfig(configFile, config);
    await refresh();
    return getPublicState();
  }

  async function refresh() {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      try {
        quotas = await fetchCpaQuotas(config, { fetchImpl, timeoutMs });
      } catch {
        quotas = [];
      } finally {
        refreshPromise = undefined;
      }
      return quotas;
    })();
    return refreshPromise;
  }

  return { start, stop, refresh, updateConfig, getPublicState };
}

export async function fetchCpaQuotas(config, { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const normalized = normalizeConfig(config);
  if (!normalized.url || !normalized.password) return [];
  const managementBase = managementBaseUrl(normalized.url);
  const headers = { Authorization: `Bearer ${normalized.password}` };
  const authFiles = await fetchJson(`${managementBase}/auth-files`, { headers }, { fetchImpl, timeoutMs });
  const credentials = selectCodexCredentials(authFiles?.files);
  const quotas = [];
  for (const credential of credentials) {
    try {
      const accountId = credential?.id_token?.chatgpt_account_id;
      const apiCall = await fetchJson(`${managementBase}/api-call`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          authIndex: credential.auth_index,
          method: 'GET',
          url: CODEX_USAGE_URL,
          header: {
            Authorization: 'Bearer $TOKEN$',
            'Content-Type': 'application/json',
            'User-Agent': CODEX_USER_AGENT,
            ...(accountId ? { 'Chatgpt-Account-Id': accountId } : {}),
          },
        }),
      }, { fetchImpl, timeoutMs });
      if (Number(apiCall?.status_code) < 200 || Number(apiCall?.status_code) >= 300) continue;
      const quota = parseWeeklyQuota(parseJsonValue(apiCall?.body), credential);
      if (quota) quotas.push(quota);
    } catch {
      // One invalid credential must not hide healthy credentials.
    }
  }
  return quotas;
}

export function parseWeeklyQuota(usage, credential = {}) {
  if (!usage || typeof usage !== 'object') return null;
  const rateLimit = usage.rate_limit ?? usage.rateLimit;
  const windows = [rateLimit?.primary_window, rateLimit?.primaryWindow, rateLimit?.secondary_window, rateLimit?.secondaryWindow].filter(Boolean);
  const weekly = windows.find((window) => Number(window?.limit_window_seconds ?? window?.limitWindowSeconds) === 604800)
    ?? windows.find((window) => Number(window?.limit_window_seconds ?? window?.limitWindowSeconds) >= 604800)
    ?? windows[0];
  if (!weekly) return null;
  const usedPercent = clampPercent(weekly.used_percent ?? weekly.usedPercent);
  const resetAtSeconds = finiteNumber(weekly.reset_at ?? weekly.resetAt);
  const resetAfterSeconds = finiteNumber(weekly.reset_after_seconds ?? weekly.resetAfterSeconds);
  const resetAtMs = resetAtSeconds > 0
    ? resetAtSeconds * 1000
    : resetAfterSeconds > 0 ? Date.now() + resetAfterSeconds * 1000 : NaN;
  if (!Number.isFinite(usedPercent) || !Number.isFinite(resetAtMs)) return null;
  return {
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    resetAt: new Date(resetAtMs).toISOString(),
    account: String(credential.label || credential.email || usage.email || '').trim(),
    planType: String(usage.plan_type ?? usage.planType ?? credential?.id_token?.plan_type ?? '').trim(),
    updatedAt: new Date().toISOString(),
  };
}

function selectCodexCredentials(files) {
  if (!Array.isArray(files)) return [];
  return files.filter((file) => {
    const provider = String(file?.type || file?.provider || '').toLowerCase();
    return provider === 'codex'
      && Boolean(file?.auth_index)
      && !normalizeBoolean(file?.disabled);
  });
}

function normalizeBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return String(value || '').trim().toLowerCase() === 'true';
}

function managementBaseUrl(value) {
  const url = new URL(String(value).trim());
  const pathname = url.pathname.replace(/\/+$/, '');
  url.pathname = pathname.endsWith('/v0/management')
    ? pathname
    : `${pathname}/v0/management`;
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

async function fetchJson(url, options, { fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`CPA HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function parseJsonValue(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try { return JSON.parse(value); } catch { return null; }
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

function clampPercent(value) {
  const number = finiteNumber(value);
  return Number.isFinite(number) ? Math.min(100, Math.max(0, Math.round(number * 10) / 10)) : NaN;
}

function normalizeConfig(value) {
  return {
    url: String(value?.url || '').trim(),
    password: String(value?.password || ''),
  };
}

async function readConfig(configFile) {
  if (!configFile) return { url: '', password: '' };
  try {
    return normalizeConfig(JSON.parse(await fsp.readFile(configFile, 'utf8')));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return { url: '', password: '' };
  }
}

async function writeConfig(configFile, config) {
  if (!configFile) return;
  await fsp.mkdir(path.dirname(configFile), { recursive: true });
  await fsp.writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fsp.chmod(configFile, 0o600).catch(() => {});
}

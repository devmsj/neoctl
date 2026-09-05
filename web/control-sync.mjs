import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as wait } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { seal, open } from './control-protocol.mjs';

const FILE = 'transcript.jsonl';
const MAX_PACKET = 256 * 1024;
const CHUNK = 32 * 1024;
const RAW_BUDGET = 128 * 1024;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const validId = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value);

// These are the actual envKey -> key definitions in engine/src/web/index.ts.
export const MODEL_FIELDS = Object.freeze({
  OPENAI_API_KEY: 'apiKey', OPENAI_BASE_URL: 'baseUrl', OPENAI_MODEL: 'model',
  OPENAI_ENDPOINT: 'endpoint', MODEL_REASONING_EFFORT: 'reasoningEffort',
  MODEL_REASONING_SUMMARY: 'reasoningSummary', MODEL_MAX_OUTPUT_TOKENS: 'maxOutputTokens',
  MODEL_TIMEOUT_MS: 'timeoutMs', MODEL_STREAM_IDLE_TIMEOUT_MS: 'streamIdleTimeoutMs',
  MODEL_MAX_RETRIES: 'maxRetries',
});

export function loginProfile(profile) {
  if (!profile || profile.provider !== 'openai' || !profile.values || Array.isArray(profile.values)) throw new Error('PROFILE_INVALID');
  const values = {};
  for (const [key, value] of Object.entries(profile.values)) {
    if (!Object.values(MODEL_FIELDS).includes(key) || typeof value !== 'string' || value.length > 8192 || /[\r\n\0]/.test(value)) throw new Error('PROFILE_INVALID');
    values[key] = value;
  }
  if (!values.apiKey?.trim() || !values.model?.trim()) throw new Error('PROFILE_INVALID');
  return { provider: 'openai', values };
}

// Reuse the existing login HTTP endpoint for shared env persistence/default runtime,
// then the same Engine saveLogin method for every already-created runtime. No env writer.
export function createLoginApplier({ runtimeUrl, getActiveRepls = () => [], fetchImpl = fetch, timeoutMs = 10_000 }) {
  const endpoint = new URL('/api/login', runtimeUrl);
  return async (profile, { signal } = {}) => {
    const mapped = loginProfile(profile);
    const combinedSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    // Archives are complete forms, not per-device patches. Clear omitted optional
    // fields so a broadcast cannot inherit different old settings on each device.
    const values = {};
    for (const field of Object.values(MODEL_FIELDS)) values[field] = mapped.values[field] ?? '';
    const response = await fetchImpl(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'openai', values }), signal: combinedSignal, redirect: 'error',
    });
    if (!response.ok || (await response.json()).ok !== true) throw new Error('LOGIN_FAILED');
    const applied = new Set();
    // Include runtime creations which completed while another login was applying.
    for (;;) {
      const pending = [...getActiveRepls()].filter((repl) => !applied.has(repl));
      if (!pending.length) break;
      for (const repl of pending) {
        combinedSignal.throwIfAborted();
        if ((await repl.saveLogin('openai', values))?.ok !== true) throw new Error('LOGIN_FAILED');
        applied.add(repl);
      }
    }
  };
}

export function validateControlConfig(value) {
  if (!value || value.enabled !== true || typeof value.key !== 'string') return null;
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value.key) || Buffer.from(value.key, 'base64').length !== 32 || Buffer.from(value.key, 'base64').toString('base64') !== value.key) return null;
  try {
    const url = new URL(value.url);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (loopback || value.allowHttp === true))) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    return { url: url.href.replace(/\/$/, ''), allowHttp: value.allowHttp === true, key: value.key, enabled: true };
  } catch { return null; }
}

async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, file);
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

function runLocal(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 2500, maxBuffer: 16 * 1024, encoding: 'utf8' }, (error, stdout) => resolve(error ? '' : stdout.trim()));
  });
}

export async function deviceIdentity(directory, deviceId) {
  const machineCode = hash(`neo-control-machine-v1:${deviceId}`);
  let model = '';
  if (process.platform === 'win32') model = await runLocal('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_ComputerSystem).Model']);
  return { machineCode, hostname: os.hostname().slice(0, 160), model: (model || `${os.type()} ${os.arch()}`).slice(0, 160), platform: process.platform };
}

async function bytesAt(handle, offset, length) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, offset);
  return buffer.subarray(0, bytesRead);
}
async function anchorAt(handle, offset) {
  return hash(await bytesAt(handle, Math.max(0, offset - 64), Math.min(64, offset)));
}

// Engine SessionStore.resolveSessionRoot: AGENT_SESSION_DIR or getNeoctlHome()/sessions.
export function sessionStoreRoot(env = process.env) {
  return env.AGENT_SESSION_DIR ? path.resolve(env.AGENT_SESSION_DIR) : path.join(os.homedir(), '.neoctl', 'sessions');
}

export function createControlSync(options = {}) {
  // Only the launcher's in-memory opt-in is trusted. Never discover/read pairing
  // files or environment variables. Snapshot prevents target/key swaps at runtime.
  const config = validateControlConfig(options.config);
  const directory = typeof options.dataDir === 'string' && options.dataDir.trim() ? path.resolve(options.dataDir) : '';
  const enabled = Boolean(config && directory);
  const sessionsRoot = options.sessionsRoot || sessionStoreRoot();
  const registryFile = options.registryFile || path.join(directory, 'session-workspaces.json');
  const stateFile = options.stateFile || path.join(directory, 'control-sync-state.json');
  const diagnosticFile = path.join(directory, 'control-sync-diagnostic.json');
  const fetchImpl = options.fetchImpl || fetch;
  const pollMs = Math.min(30_000, Math.max(1, Number(options.pollMs) || 1000));
  const timeoutMs = Math.min(30_000, Math.max(1, Number(options.timeoutMs) || 8000));
  const fastPollMs = Math.min(30_000, Math.max(500, Number(options.fastPollMs) || 500));
  const scanLimit = Math.min(1024, Math.max(2, Math.floor(Number(options.scanLimit) || 64)));
  const indexTtlMs = Math.min(60_000, Math.max(1, Number(options.indexTtlMs) || 30_000));
  let state, pairing, identity, inFlight, controller, timer;
  let registryCache, registryStamp, indexAt = 0, lastSyncAt = 0, backlog = false;
  const active = new Map();
  const activeTtlMs = Math.min(60_000, Math.max(1, Number(options.activeTtlMs) || 30_000));
  let serverReportingBlocked = false, reportingProbed = false;
  let enrolled = false;
  let stopped = false, started = false, failures = 0, rotation = 0, lastDiagnostic = '';

  async function diagnose(code) {
    // No exception text, URLs, keys, env values, session content, or identifying paths.
    if (lastDiagnostic === code || !enabled) return;
    lastDiagnostic = code;
    await atomicJson(diagnosticFile, { code, at: new Date().toISOString() }).catch(() => {});
  }
  function stillEnabled() { return enabled && !stopped; }
  async function initialize() {
    const idFile = path.join(directory, 'control-device.json');
    let savedDevice;
    try { savedDevice = JSON.parse(await fs.readFile(idFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    let deviceId = savedDevice?.deviceId;
    if (deviceId !== undefined && (typeof deviceId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(deviceId))) throw new Error('DEVICE_ID_INVALID');
    if (!deviceId) {
      deviceId = randomUUID();
      await atomicJson(idFile, { deviceId });
    }
    const value = { ...config, deviceId };
    const fingerprint = hash(JSON.stringify(value));
    try {
      const saved = JSON.parse(await fs.readFile(stateFile, 'utf8'));
      if (saved.version === 1 && saved.pairing === fingerprint && saved.cursors && typeof saved.cursors === 'object' && !Array.isArray(saved.cursors)) state = saved;
    } catch (error) {
      if (error.code !== 'ENOENT') await diagnose('STATE_UNREADABLE');
    }
    state ||= { version: 1, pairing: fingerprint, cursors: {}, ackCommandId: null };
    identity = options.device || await (options.identityProvider || deviceIdentity)(directory, deviceId);
    pairing = value;
  }
  async function conflict(sessionId) {
    state.cursors[sessionId] = { ...state.cursors[sessionId], blocked: true };
    await atomicJson(stateFile, state);
    await diagnose('TRANSCRIPT_CONFLICT');
  }
  async function sessionIndex() {
    // Stat every cycle, parse/sort on change or TTL. Index registered IDs directly;
    // unrelated Engine/CLI history never adds filesystem scan work.
    try {
      const stat = await fs.stat(registryFile, { bigint: true });
      const stamp = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
      if (!registryCache || stamp !== registryStamp || Date.now() - indexAt >= indexTtlMs) {
        const registry = JSON.parse(await fs.readFile(registryFile, 'utf8'));
        if (!registry || typeof registry !== 'object' || Array.isArray(registry)) throw new Error('REGISTRY_INVALID');
        const ids = Object.keys(registry).filter(validId).sort();
        registryCache = { ids, members: new Set(ids) };
        registryStamp = stamp;
        indexAt = Date.now();
        for (const id of active.keys()) if (!registryCache.members.has(id)) active.delete(id);
      }
      return registryCache.ids;
    } catch {
      registryCache = undefined;
      registryStamp = undefined;
      active.clear();
      return [];
    }
  }
  async function collect() {
    const ids = await sessionIndex();
    backlog = false;
    if (!ids.length) return [];
    const deltas = [];
    let remaining = RAW_BUDGET;
    // Interleave a rotating active queue and cold sweep, with bounded disk work.
    const visited = new Set();
    let cold = 0;
    const hot = [];
    for (const id of active.keys()) { hot.push(id); if (hot.length >= Math.ceil(scanLimit / 2)) break; }
    let hotIndex = 0;
    for (let index = 0; index < scanLimit && deltas.length < 16 && remaining > 0 && stillEnabled(); index++) {
      let sessionId = ids.length > scanLimit && index % 2 === 0 ? hot[hotIndex++] : undefined;
      if (!sessionId) {
        if (cold >= ids.length) break;
        sessionId = ids[rotation % ids.length];
        rotation = (rotation + 1) % ids.length;
        cold++;
      }
      if (visited.has(sessionId)) continue;
      visited.add(sessionId);
      const activeUntil = active.get(sessionId);
      active.delete(sessionId);
      if (activeUntil > Date.now()) active.set(sessionId, activeUntil);
      const cursor = state.cursors[sessionId] || { offset: 0 };
      if (cursor.blocked) { active.delete(sessionId); continue; }
      if (!Number.isSafeInteger(cursor.offset) || cursor.offset < 0) { await conflict(sessionId); continue; }
      const filename = path.join(sessionsRoot, sessionId, FILE);
      let handle;
      try {
        const parent = await fs.lstat(path.dirname(filename));
        if (!parent.isDirectory() || parent.isSymbolicLink()) continue;
        const link = await fs.lstat(filename);
        if (!link.isFile() || link.isSymbolicLink()) continue;
        handle = await fs.open(filename, 'r');
        const stat = await handle.stat();
        if (stat.size < cursor.offset || (cursor.anchor && cursor.anchor !== await anchorAt(handle, cursor.offset))) {
          await conflict(sessionId); continue;
        }
        let data = await bytesAt(handle, cursor.offset, Math.min(CHUNK, remaining, stat.size - cursor.offset));
        // Preserve unfinished tail lines. Very long records are sent as raw byte chunks;
        // receiver stores bytes, not independently decoded UTF-8 strings.
        const newline = data.lastIndexOf(10);
        if (newline >= 0) data = data.subarray(0, newline + 1);
        else if (data.length < CHUNK) data = Buffer.alloc(0);
        if (!data.length) continue; // Empty/unfinished tails consume no delta slots.
        active.set(sessionId, Date.now() + activeTtlMs);
        if (stat.size > cursor.offset + data.length) backlog = true;
        remaining -= data.length;
        deltas.push({ sessionId, file: FILE, offset: cursor.offset, data: data.toString('base64') });
      } catch (error) {
        if (error.code !== 'ENOENT') await diagnose('TRANSCRIPT_READ_FAILED');
      } finally { await handle?.close().catch(() => {}); }
    }
    if (remaining === 0 || deltas.length === 16) backlog = true;
    return deltas;
  }
  async function acceptAcks(acks, deltas) {
    if (!Array.isArray(acks)) throw new Error('ACK_INVALID');
    if (!acks.length) return;
    const next = structuredClone(state);
    const sent = new Map(deltas.map((delta) => [delta.sessionId, delta]));
    const seen = new Set();
    for (const ack of acks) {
      const delta = sent.get(ack?.sessionId);
      if (!delta || ack.file !== FILE || seen.has(ack.sessionId) || !Number.isSafeInteger(ack.offset) || ack.offset < 0 || ack.offset > delta.offset + Buffer.from(delta.data, 'base64').length) throw new Error('ACK_INVALID');
      seen.add(ack.sessionId);
      if (state.cursors[ack.sessionId]?.blocked) continue;
      if (ack.error === 'QUOTA_EXCEEDED' && ack.retryable === false) {
        next.cursors[ack.sessionId] = { ...state.cursors[ack.sessionId], offset: state.cursors[ack.sessionId]?.offset ?? delta.offset, blocked: true };
        active.delete(ack.sessionId);
        await diagnose('SESSION_QUOTA_EXCEEDED');
        continue;
      }
      if (ack.error) throw new Error('ACK_INVALID');
      if (ack.conflict === true) {
        await conflict(ack.sessionId);
        next.cursors[ack.sessionId] = state.cursors[ack.sessionId];
        continue;
      }
      let handle;
      try {
        handle = await fs.open(path.join(sessionsRoot, ack.sessionId, FILE), 'r');
        const stat = await handle.stat();
        const data = Buffer.from(delta.data, 'base64');
        if (stat.size < delta.offset + data.length || !(await bytesAt(handle, delta.offset, data.length)).equals(data)) {
          await conflict(ack.sessionId); next.cursors[ack.sessionId] = state.cursors[ack.sessionId]; continue;
        }
        next.cursors[ack.sessionId] = { offset: ack.offset, anchor: await anchorAt(handle, ack.offset) };
      } finally { await handle?.close().catch(() => {}); }
    }
    if (JSON.stringify(next) !== JSON.stringify(state)) await atomicJson(stateFile, next);
    state = next;
  }
  async function exchange(endpoint, payload) {
    if (!stillEnabled()) throw new Error('STOPPED');
    const body = JSON.stringify({ deviceId: pairing.deviceId, envelope: await seal(pairing.key, pairing.deviceId, 'up', payload) });
    if (Buffer.byteLength(body) > MAX_PACKET) throw new Error('PACKET_LIMIT');
    if (!stillEnabled()) throw new Error('STOPPED');
    controller = new AbortController();
    // All sync requests (including manual ticks and immediate ACK) share spacing.
    if (endpoint === 'sync') {
      const delay = Math.max(0, 500 - (Date.now() - lastSyncAt));
      if (delay) await wait(delay, undefined, { signal: controller.signal });
      if (!stillEnabled()) throw new Error('STOPPED');
      lastSyncAt = Date.now();
    }
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
    const response = await fetchImpl(`${pairing.url}/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal, redirect: 'error' });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (endpoint === 'sync' && [401, 403, 404].includes(response.status)) { enrolled = false; reportingProbed = false; }
      throw new Error('CONTROL_HTTP_FAILED');
    }
    // Bounded response reading also covers chunked responses.
    let size = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_PACKET) { controller.abort(); throw new Error('RESPONSE_LIMIT'); }
      chunks.push(chunk);
    }
    const reply = await open(pairing.key, pairing.deviceId, 'down', JSON.parse(Buffer.concat(chunks).toString('utf8')).envelope);
    if (reply?.requestId !== payload.requestId) throw new Error('REQUEST_ID_MISMATCH');
    return { reply, signal };
  }
  async function cycle() {
    if (!stillEnabled()) return false;
    if (!pairing) await initialize();
    if (!enrolled) {
      const { reply } = await exchange('enroll', { requestId: randomUUID(), sentAt: Date.now(), kind: 'enroll', device: identity });
      if (reply.kind !== 'enrolled' || reply.deviceId !== pairing.deviceId) throw new Error('ENROLL_INVALID');
      if (!stillEnabled()) return false;
      enrolled = true;
    }
    // First sync after launch/re-enrollment is control-only. Never inspect local
    // transcripts until an authenticated response establishes reporting policy.
    // A cycle is bounded to probe + regular sync + one immediate ACK (at most 3).
    if (!reportingProbed) {
      const hadPendingAck = state.ackCommandId && state.ackCommandPending !== false;
      const applied = await syncOnce([]);
      if (!stillEnabled()) return false;
      if (applied) { await syncOnce([]); return stillEnabled(); }
      if (serverReportingBlocked || hadPendingAck) return true;
    }
    // Persisted pending ACK has priority over transcript scans after restart.
    if (state.ackCommandId && state.ackCommandPending !== false) {
      const applied = await syncOnce([]);
      if (applied && stillEnabled()) await syncOnce([]);
    } else {
      const deltas = serverReportingBlocked ? [] : await collect();
      if (!stillEnabled()) return false;
      const applied = await syncOnce(deltas);
      // One extra request only; never recurse on commands returned by the ACK.
      if (applied && stillEnabled()) await syncOnce([]);
    }
    return stillEnabled();
  }
  async function syncOnce(deltas) {
    const payload = { requestId: randomUUID(), sentAt: Date.now(), device: identity, deltas };
    if (state.ackCommandId && state.ackCommandPending !== false) payload.ackCommandId = state.ackCommandId;
    const { reply, signal } = await exchange('sync', payload);
    if (!stillEnabled()) return false;
    if (reply.reportingBlocked !== undefined && typeof reply.reportingBlocked !== 'boolean') throw new Error('REPORTING_POLICY_INVALID');
    serverReportingBlocked = reply.reportingBlocked === true; // Legacy servers default false.
    reportingProbed = true;
    if (serverReportingBlocked) backlog = false;
    // In-flight bytes may have been sent before learning the policy. The server
    // discards them; never advance or freeze a cursor using a blocked response.
    if (!serverReportingBlocked) await acceptAcks(reply.acks, deltas);
    if (payload.ackCommandId) {
      const next = { ...state, ackCommandPending: false };
      await atomicJson(stateFile, next);
      state = next;
    }
    if (reply.command) {
      const command = reply.command;
      if (!validId(command.id)) throw new Error('COMMAND_INVALID');
      if (command.id !== state.ackCommandId) {
        loginProfile(command.profile);
        if (!options.applyProfile) throw new Error('LOGIN_UNAVAILABLE');
        if (!stillEnabled()) return false;
        await options.applyProfile(command.profile, { signal });
        if (!stillEnabled()) return false;
        const next = { ...state, ackCommandId: command.id, ackCommandPending: true };
        await atomicJson(stateFile, next);
        state = next;
        return true;
      }
    }
    return false;
  }
  function tick() {
    if (inFlight) return inFlight;
    if (stopped || !enabled) return Promise.resolve(false);
    inFlight = cycle().then((result) => { failures = 0; return result; }).catch(async () => {
      failures = Math.min(failures + 1, 6);
      await diagnose('SYNC_RETRY');
      return false;
    }).finally(() => { inFlight = undefined; controller = undefined; });
    return inFlight;
  }
  function schedule(delay) {
    if (stopped || !started || !enabled) return;
    timer = setTimeout(async () => {
      await tick();
      schedule(failures ? Math.min(30_000, Math.max(500, pollMs) * 2 ** failures) : backlog ? fastPollMs : pollMs);
    }, delay);
    timer.unref?.();
  }
  return {
    tick,
    start() { if (!started && enabled) { started = true; schedule(0); } return this; },
    async stop() { stopped = true; clearTimeout(timer); controller?.abort(); await inFlight; },
  };
}

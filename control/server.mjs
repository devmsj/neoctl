import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { seal, open, decodeBase64 } from './protocol.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILES = new Set(['meta.json', 'transcript.jsonl']);
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
const DEFAULT_LIMITS = Object.freeze({
  requestBytes: 256 * 1024, deltaBytes: 128 * 1024, deltas: 128,
  fileBytes: 16 * 1024 * 1024, diskBytes: 1024 * 1024 * 1024,
  devices: 1000, profiles: 128, sessionsPerDevice: 1000,
  profileBytes: 64 * 1024, stateBytes: 32 * 1024 * 1024, concurrentRequests: 64, syncPerMinute: 240,
  enrollPerMinute: 60, authFailuresPerMinute: 30, deviceRequestsPerMinute: 12000,
});
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const reject = (message = 'Invalid request', status = 400) => { throw new HttpError(status, message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function identifier(value) { if (typeof value !== 'string' || !ID.test(value) || RESERVED.test(value)) reject('Invalid identifier'); return value; }
function text(value, max = 256, empty = false) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || /[\u0000-\u001f\u007f]/.test(value)) reject('Invalid text');
  return value;
}
const PROFILE_KEYS = new Set(['apiKey', 'baseUrl', 'model', 'endpoint', 'reasoningEffort', 'reasoningSummary', 'maxOutputTokens', 'timeoutMs', 'streamIdleTimeoutMs', 'maxRetries']);
function validateProfile(profile) {
  if (!object(profile) || profile.provider !== 'openai' || !object(profile.values) || Object.keys(profile).some(k => !['provider', 'values'].includes(k))) reject('Invalid OpenAI profile');
  for (const [key, value] of Object.entries(profile.values)) {
    if (!PROFILE_KEYS.has(key) || typeof value !== 'string') reject('Invalid profile value');
    text(value, 8192, true);
  }
  text(profile.values.apiKey, 8192);
  text(profile.values.model, 256);
  if (profile.values.baseUrl) {
    let url;
    try { url = new URL(profile.values.baseUrl); } catch { reject('Invalid baseUrl'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) reject('Invalid baseUrl');
  }
}
const clone = value => structuredClone(value);
async function existsStat(target) {
  try { return await fs.lstat(target); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function safeDirectory(target) {
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe storage directory');
}
async function atomicWrite(target, content) {
  const temporary = `${target}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close(); handle = null;
    await fs.rename(temporary, target);
    // Directory fsync is supported on Unix, not on all Windows filesystems.
    let dir;
    try { dir = await fs.open(path.dirname(target), 'r'); await dir.sync(); }
    catch (error) { if (!['EPERM', 'EISDIR', 'EINVAL', 'ENOTSUP', 'EBADF', 'EACCES'].includes(error.code)) throw error; }
    finally { await dir?.close(); }
  } finally { await handle?.close(); await fs.rm(temporary, { force: true }).catch(() => {}); }
}
function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(value));
}
async function readBody(request, max) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) reject('Content-Type must be application/json', 415);
  if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') reject('Unsupported encoding', 415);
  const declared = request.headers['content-length'];
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > max)) reject('Request too large', 413);
  const parts = []; let bytes = 0;
  for await (const part of request) {
    bytes += part.length;
    if (bytes > max) reject('Request too large', 413);
    parts.push(part);
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { reject('Invalid JSON'); }
}
function sameOrigin(request, publicOrigin) {
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = request.headers.origin;
  if (!origin) return true; // CLI/device requests have no Origin.
  try {
    const url = new URL(origin);
    return url.origin === origin && (url.origin === publicOrigin || url.origin === `http://${request.headers.host}`);
  } catch { return false; }
}

/** Creates (but does not listen on) a native http.Server. Only one process may own dataDir. */
export async function createControlServer(options = {}) {
  const adminToken = options.adminToken ?? process.env.CONTROL_ADMIN_TOKEN;
  if (typeof adminToken !== 'string' || !adminToken.trim() || /[\r\n]/.test(adminToken)) throw new Error('CONTROL_ADMIN_TOKEN is required');
  const dataDir = path.resolve(options.dataDir ?? process.env.CONTROL_DATA_DIR ?? path.join(HERE, '.data'));
  const sharedDeviceKey = options.sharedDeviceKey ?? process.env.CONTROL_SHARED_DEVICE_KEY;
  if (sharedDeviceKey !== undefined) {
    try {
      if (decodeBase64(sharedDeviceKey).length !== 32) throw new Error();
    } catch { throw new Error('CONTROL_SHARED_DEVICE_KEY must be canonical base64 of 32 bytes'); }
  }
  const autoEnroll = options.autoEnroll ?? (process.env.CONTROL_AUTO_ENROLL === 'true');
  if (typeof autoEnroll !== 'boolean') throw new Error('autoEnroll must be boolean');
  if (sharedDeviceKey === adminToken) throw new Error('Device key must differ from admin token');
  const publicOrigin = options.publicOrigin ?? process.env.CONTROL_PUBLIC_ORIGIN;
  if (publicOrigin !== undefined) {
    let parsed;
    try { parsed = new URL(publicOrigin); } catch { throw new Error('Invalid CONTROL_PUBLIC_ORIGIN'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== publicOrigin) throw new Error('CONTROL_PUBLIC_ORIGIN must be an exact http(s) origin');
  }
  const viewerDir = path.resolve(options.viewerDir ?? path.join(HERE, 'viewer-dist'));
  const publicDir = path.resolve(options.publicDir ?? path.join(HERE, 'public'));
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  for (const [key, value] of Object.entries(limits)) if (!(key in DEFAULT_LIMITS) || !Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid limit: ${key}`);
  await safeDirectory(dataDir);
  const sessionRoot = path.join(dataDir, 'sessions');
  await safeDirectory(sessionRoot);
  const statePath = path.join(dataDir, 'state.json');
  let state = { version: 1, devices: [], revokedDeviceIds: [], profiles: [], broadcastProfileId: null, broadcast: null, sequence: 0 };
  const stateStat = await existsStat(statePath);
  if (stateStat) {
    if (!stateStat.isFile() || stateStat.isSymbolicLink() || stateStat.size > limits.stateBytes) throw new Error('Unsafe or oversized state');
    state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    if (state.version !== 1 || !Array.isArray(state.devices) || !Array.isArray(state.profiles)) throw new Error('Unsupported state');
  }
  // Tombstones never expire: deleting an identity must survive process restarts.
  const migrateRevocations = state.revokedDeviceIds === undefined;
  if (migrateRevocations) state.revokedDeviceIds = [];
  if (!Array.isArray(state.revokedDeviceIds)) throw new Error('Invalid revocation state');
  for (const id of state.revokedDeviceIds) identifier(id);
  if (state.devices.some(d => state.revokedDeviceIds.includes(d.deviceId))) throw new Error('Revoked device in state');
  const migrateReporting = state.devices.some(d => d.reportingBlocked === undefined);
  for (const d of state.devices) {
    if (d.reportingBlocked === undefined) d.reportingBlocked = false;
    if (typeof d.reportingBlocked !== 'boolean') throw new Error('Invalid reporting state');
  }
  // Only the current revision is retained. Legacy ACKs cannot prove success.
  const migrateBroadcast = state.broadcastTargets === undefined;
  if (migrateBroadcast) state.broadcastTargets = state.broadcast ? state.devices.map(d => ({
    deviceId: d.deviceId, commandId: d.pendingCommand?.source === 'broadcast' ? d.pendingCommand.id : null,
    status: d.pendingCommand?.source === 'broadcast' ? 'pending' : 'superseded', acknowledgedAt: null,
  })) : [];
  if (migrateBroadcast && state.broadcast) {
    for (const d of state.devices) {
      if (d.pendingCommand?.source === 'broadcast') d.pendingCommand.broadcastId = state.broadcast.id;
    }
  }
  const sessions = new Map(), sessionCounts = new Map();
  const sessionKey = (deviceId, sessionId) => deviceId + '/' + sessionId;
  function putSession(record) {
    const key = sessionKey(record.deviceId, record.sessionId);
    if (!sessions.has(key)) sessionCounts.set(record.deviceId, (sessionCounts.get(record.deviceId) ?? 0) + 1);
    sessions.set(key, record);
  }
  let diskBytes = 0;
  // Disk files, not cached offsets, are authoritative after crashes/restarts.
  for (const d of await fs.readdir(sessionRoot, { withFileTypes: true })) {
    identifier(d.name);
    if (!d.isDirectory() || d.isSymbolicLink()) throw new Error('Unsafe session storage');
    for (const s of await fs.readdir(path.join(sessionRoot, d.name), { withFileTypes: true })) {
      identifier(s.name);
      if (!s.isDirectory() || s.isSymbolicLink()) throw new Error('Unsafe session storage');
      const record = { deviceId: d.name, sessionId: s.name, files: {}, updatedAt: 0 };
      for (const file of await fs.readdir(path.join(sessionRoot, d.name, s.name), { withFileTypes: true })) {
        if (!FILES.has(file.name) || !file.isFile() || file.isSymbolicLink()) throw new Error('Unsafe session file');
        const stat = await fs.lstat(path.join(sessionRoot, d.name, s.name, file.name));
        record.files[file.name] = stat.size; record.updatedAt = Math.max(record.updatedAt, stat.mtimeMs); diskBytes += stat.size;
      }
      putSession(record);
    }
  }
  async function commit(next) {
    const data = JSON.stringify(next);
    if (Buffer.byteLength(data) > limits.stateBytes) reject('State quota exceeded', 413);
    await atomicWrite(statePath, data);
    state = next;
  }
  // Explicit shared-key mode migrates existing identities without changing their
  // IDs, sessions, command acknowledgements or replay history. Rotations require
  // updating every client; removing the option does not silently rotate devices.
  const migrateSharedKey = sharedDeviceKey !== undefined && state.devices.some(d => d.key !== sharedDeviceKey);
  if (migrateSharedKey) state = { ...state, devices: state.devices.map(d => ({ ...d, key: sharedDeviceKey })) };
  if (!stateStat || migrateSharedKey || migrateRevocations || migrateBroadcast || migrateReporting) await commit(state);
  await fs.chmod(dataDir, 0o700).catch(() => {});
  await fs.chmod(statePath, 0o600).catch(() => {});
  let queue = Promise.resolve();
  function serial(action) {
    const task = queue.then(action);
    queue = task.catch(() => {});
    return task;
  }
  function getDevice(id, target = state) { const d = target.devices.find(item => item.deviceId === id); if (!d) reject('Device not found', 404); return d; }
  function getProfile(id, target = state) { identifier(id); const p = target.profiles.find(item => item.id === id); if (!p) reject('Profile not found', 404); return p; }
  function makeCommand(profile, source, sequence) {
    return { id: randomUUID(), profileId: profile.id, profile: clone(profile.profile), source, sequence, createdAt: Date.now() };
  }
  function newDevice(target, deviceId, key, name, device = null) {
    if (target.devices.length >= limits.devices) reject('Device quota exceeded', 413);
    const d = { deviceId, key, name, reportingBlocked: false, createdAt: Date.now(), lastSeen: null, ip: null, device, pendingCommand: null, lastAckCommandId: null };
    if (target.broadcast) addBroadcastTarget(target, d);
    target.devices.push(d);
    return d;
  }
  function addBroadcastTarget(target, d) {
    d.pendingCommand = { ...target.broadcast, id: randomUUID(), broadcastId: target.broadcast.id };
    target.broadcastTargets.push({ deviceId: d.deviceId, commandId: d.pendingCommand.id, status: 'pending', acknowledgedAt: null });
  }
  function startBroadcast(target, profile) {
    target.broadcastProfileId = profile.id;
    target.broadcast = makeCommand(profile, 'broadcast', ++target.sequence);
    target.broadcastTargets = [];
    for (const d of target.devices) addBroadcastTarget(target, d);
  }
  function broadcastStatus(snapshot) {
    if (!snapshot.broadcast) return null;
    const devices = new Map(snapshot.devices.map(d => [d.deviceId, d]));
    const counts = { total: 0, pending: 0, succeeded: 0, superseded: 0 };
    const clients = snapshot.broadcastTargets.flatMap(t => {
      const d = devices.get(t.deviceId);
      if (!d) return [];
      counts.total++; counts[t.status]++;
      return [{ deviceId: d.deviceId, name: d.name, status: t.status, acknowledgedAt: t.acknowledgedAt,
        online: d.lastSeen !== null && Date.now() - d.lastSeen < 30_000 }];
    });
    return { id: snapshot.broadcast.id, profileId: snapshot.broadcast.profileId, createdAt: snapshot.broadcast.createdAt, counts, clients };
  }
  function publicDevice(d) {
    const { key, pendingCommand, recentRequests, ...safe } = d;
    return { ...safe, reportingBlocked: d.reportingBlocked, id: d.deviceId, machineId: d.device?.machineCode ?? null, ...(d.device || {}), online: d.lastSeen !== null && Date.now() - d.lastSeen < 30_000,
      pendingCommand: pendingCommand ? { id: pendingCommand.id, profileId: pendingCommand.profileId, source: pendingCommand.source, createdAt: pendingCommand.createdAt } : null };
  }
  async function sessionFile(deviceId, sessionId, file, create = false) {
    identifier(deviceId); identifier(sessionId);
    if (!FILES.has(file)) reject('Invalid session file');
    const devicePath = path.join(sessionRoot, deviceId), dir = path.join(devicePath, sessionId);
    if (create) { await safeDirectory(devicePath); await safeDirectory(dir); }
    else {
      for (const folder of [devicePath, dir]) {
        const stat = await existsStat(folder);
        if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) reject('Unsafe session path');
      }
    }
    const target = path.join(dir, file);
    const stat = await existsStat(target);
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) reject('Unsafe session path');
    return { target, stat };
  }
  async function appendDelta(deviceId, delta) {
    let record = sessions.get(sessionKey(deviceId, delta.sessionId));
    const { target, stat } = await sessionFile(deviceId, delta.sessionId, delta.file);
    const length = stat?.size ?? 0;
    const result = { sessionId: delta.sessionId, file: delta.file, offset: length };
    const bytes = delta.bytes;
    if (bytes.length === 0) return { ...result, offset: Math.min(length, delta.offset) };
    if (delta.offset > length) return result; // rewind; never fill gaps
    if (delta.offset < length) {
      const overlap = Math.min(bytes.length, length - delta.offset);
      const handle = await fs.open(target, 'r');
      try {
        const previous = Buffer.alloc(overlap);
        const read = await handle.read(previous, 0, overlap, delta.offset);
        if (read.bytesRead !== overlap || !previous.equals(bytes.subarray(0, overlap)))
          return { ...result, offset: delta.offset, conflict: true };
      } finally { await handle.close(); }
      // Ack only bytes actually compared. A partial overlap retries its tail next request.
      return { ...result, offset: delta.offset + overlap };
    }
    if (length + bytes.length > limits.fileBytes || diskBytes + bytes.length > limits.diskBytes) reject('Session quota exceeded', 413);
    if (!record && (sessionCounts.get(deviceId) ?? 0) >= limits.sessionsPerDevice) reject('Session quota exceeded', 413);
    await sessionFile(deviceId, delta.sessionId, delta.file, true);
    const handle = await fs.open(target, 'a', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally {
      await handle.close();
      // Account for partial writes even if a disk-full error interrupts this request.
      const after = await fs.stat(target);
      diskBytes += after.size - length;
      if (!record) { record = { deviceId, sessionId: delta.sessionId, files: {}, updatedAt: 0 }; putSession(record); }
      record = { ...record, files: { ...record.files, [delta.file]: after.size }, updatedAt: after.mtimeMs };
      putSession(record);
      result.offset = after.size;
    }
    return result;
  }
  function validateIdentity(payload) {
    if (!object(payload)) reject();
    identifier(payload.requestId);
    if (!Number.isSafeInteger(payload.sentAt) || Math.abs(Date.now() - payload.sentAt) > 120_000) reject('Stale request');
    if (!object(payload.device)) reject('Invalid device');
    const device = {};
    for (const field of ['machineCode', 'hostname', 'model', 'platform']) device[field] = text(payload.device[field], 256, true);
    return device;
  }
  function validatePayload(payload) {
    const device = validateIdentity(payload);
    if (payload.ackCommandId !== undefined && payload.ackCommandId !== null) identifier(payload.ackCommandId);
    if (!Array.isArray(payload.deltas) || payload.deltas.length > limits.deltas) reject('Invalid deltas');
    const deltas = payload.deltas.map(delta => {
      if (!object(delta)) reject('Invalid delta');
      identifier(delta.sessionId);
      if (!FILES.has(delta.file) || !Number.isSafeInteger(delta.offset) || delta.offset < 0 || delta.offset > limits.fileBytes) reject('Invalid delta');
      let bytes;
      try { bytes = Buffer.from(decodeBase64(delta.data)); } catch { reject('Invalid delta data'); }
      if (bytes.length > limits.deltaBytes) reject('Delta too large', 413);
      return { sessionId: delta.sessionId, file: delta.file, offset: delta.offset, bytes };
    });
    return { device, deltas };
  }
  async function enroll(body, response) {
    if (!autoEnroll || sharedDeviceKey === undefined) reject('Enrollment disabled', 403);
    let payload;
    try {
      if (!object(body)) throw new Error();
      identifier(body.deviceId);
      payload = await open(sharedDeviceKey, body.deviceId, 'up', body.envelope);
    } catch { json(response, 400, { error: 'request rejected' }); return; }
    let result, status = 200;
    try {
      const device = validateIdentity(payload);
      if (payload.kind !== 'enroll') reject('Invalid enrollment kind');
      if (state.revokedDeviceIds.includes(body.deviceId)) reject('Device revoked', 403);
      // Retries are idempotent: never replace an existing record, commands,
      // acknowledgements, lastSeen, or sync replay history (even on fresh requestId).
      if (!state.devices.some(d => d.deviceId === body.deviceId)) {
        const next = clone(state);
        newDevice(next, body.deviceId, sharedDeviceKey, device.hostname || 'New device', device);
        await commit(next);
      }
      result = { requestId: payload.requestId, deviceId: body.deviceId, kind: 'enrolled' };
    } catch (error) {
      status = error.status ?? 500;
      result = { requestId: typeof payload?.requestId === 'string' ? payload.requestId.slice(0, 128) : null,
        deviceId: body.deviceId, error: error.status ? error.message : 'Internal error' };
    }
    json(response, status, { envelope: await seal(sharedDeviceKey, body.deviceId, 'down', result) });
  }
  async function sync(body, request, response) {
    let d, payload;
    // No identifying/authentication details are disclosed before successful decryption.
    try {
      if (!object(body)) throw new Error();
      identifier(body.deviceId); d = getDevice(body.deviceId);
      payload = await open(d.key, d.deviceId, 'up', body.envelope);
    } catch { json(response, 400, { error: 'request rejected' }); return; }
    let result, status = 200;
    try {
      const { device, deltas } = validatePayload(payload);
      const now = Date.now();
      const recent = (d.recentRequests ?? []).filter(item => item.expiresAt >= now);
      if (recent.some(item => item.id === payload.requestId)) reject('Replay rejected', 409);
      if (recent.filter(item => item.receivedAt > now - 60_000).length >= limits.syncPerMinute) reject('Rate limit exceeded', 429);
      // Persist replay consumption before appending or applying any ack, including failed batches.
      // Copy only changed records; published snapshots are never mutated.
      const consumed = { ...state, devices: state.devices.map(item => item.deviceId === d.deviceId
        ? { ...item, recentRequests: [...recent, { id: payload.requestId, receivedAt: now, expiresAt: payload.sentAt + 120_000 }] } : item) };
      await commit(consumed);
      const updated = { ...getDevice(d.deviceId) };
      const next = { ...state, devices: state.devices.map(item => item.deviceId === d.deviceId ? updated : item),
        broadcastTargets: state.broadcastTargets.map(t => ({ ...t })) };
      updated.device = device; updated.lastSeen = Date.now(); updated.ip = request.socket.remoteAddress ?? null;
      if (payload.ackCommandId && updated.pendingCommand?.id === payload.ackCommandId) {
        const target = next.broadcastTargets.find(t => t.deviceId === d.deviceId);
        if (next.broadcast && target?.status === 'pending' && target.commandId === payload.ackCommandId
          && updated.pendingCommand.source === 'broadcast'
          && updated.pendingCommand.broadcastId === next.broadcast.id) {
          target.status = 'succeeded'; target.acknowledgedAt = now;
        }
        updated.lastAckCommandId = payload.ackCommandId; updated.pendingCommand = null;
      }
      const acks = [];
      // Pause only body ingestion, not identity, heartbeat or command ACKs.
      // Empty ACKs leave legacy clients' upload cursors unchanged.
      for (const delta of updated.reportingBlocked ? [] : deltas) {
        try { acks.push(await appendDelta(d.deviceId, delta)); }
        catch (error) {
          if (!(error instanceof HttpError) || error.status !== 413) throw error;
          acks.push({ sessionId: delta.sessionId, file: delta.file, offset: delta.offset, error: 'QUOTA_EXCEEDED', retryable: false });
        }
      }
      // Persist ack before ever emitting a response without the command.
      await commit(next);
      result = { requestId: payload.requestId, acks, reportingBlocked: updated.reportingBlocked };
      if (updated.pendingCommand) result.command = { id: updated.pendingCommand.id, profile: updated.pendingCommand.profile };
    } catch (error) {
      status = error.status ?? 500;
      result = { requestId: typeof payload?.requestId === 'string' ? payload.requestId.slice(0, 128) : null, acks: [], error: error.status ? error.message : 'Internal error' };
    }
    json(response, status, { envelope: await seal(d.key, d.deviceId, 'down', result) });
  }
  async function admin(method, parts, body, response) {
    if (method === 'GET' && parts.length === 2 && parts[1] === 'state') {
      json(response, 200, { devices: state.devices.map(publicDevice), profiles: state.profiles, broadcastProfileId: state.broadcastProfileId, broadcastStatus: broadcastStatus(state), sessions: [...sessions.values()] }); return;
    }
    if (method === 'GET' && parts.length === 4 && parts[1] === 'sessions') {
      const deviceId = identifier(parts[2]), sessionId = identifier(parts[3]);
      if (!sessions.has(sessionKey(deviceId, sessionId))) reject('Session not found', 404);
      async function read(file) {
        const { target, stat } = await sessionFile(deviceId, sessionId, file);
        if (!stat) return '';
        if (stat.size > limits.fileBytes) reject('File too large', 413);
        return fs.readFile(target, 'utf8');
      }
      const rawMeta = await read('meta.json'); let meta = null;
      try { if (rawMeta) meta = JSON.parse(rawMeta); } catch { /* An in-progress append may not yet be valid JSON. */ }
      json(response, 200, { meta, transcript: await read('transcript.jsonl') }); return;
    }
    const next = clone(state);
    let result = { ok: true }, status = 200;
    if (method === 'POST' && parts.length === 2 && parts[1] === 'devices') {
      if (!object(body)) reject();
      let deviceId;
      do { deviceId = randomUUID(); } while (next.revokedDeviceIds.includes(deviceId) || next.devices.some(d => d.deviceId === deviceId));
      const key = sharedDeviceKey ?? randomBytes(32).toString('base64');
      newDevice(next, deviceId, key, body.name === undefined ? 'New device' : text(body.name));
      result = { deviceId, key }; status = 201;
    } else if (parts.length === 3 && parts[1] === 'devices' && ['PATCH', 'DELETE'].includes(method)) {
      const d = getDevice(identifier(parts[2]), next);
      if (method === 'PATCH') {
        if (!object(body) || !Object.keys(body).length || Object.keys(body).some(k => !['name', 'reportingBlocked'].includes(k))) reject('Invalid device patch');
        if (Object.hasOwn(body, 'reportingBlocked') && typeof body.reportingBlocked !== 'boolean') reject('Invalid reportingBlocked');
        if (Object.hasOwn(body, 'name')) d.name = text(body.name);
        if (Object.hasOwn(body, 'reportingBlocked')) d.reportingBlocked = body.reportingBlocked;
        result = publicDevice(d);
      }
      else {
        next.revokedDeviceIds.push(d.deviceId);
        next.devices = next.devices.filter(item => item.deviceId !== d.deviceId);
        next.broadcastTargets = next.broadcastTargets.filter(t => t.deviceId !== d.deviceId);
      }
    } else if (method === 'POST' && parts.length === 2 && parts[1] === 'profiles') {
      if (!object(body)) reject();
      validateProfile(body.profile);
      if (Buffer.byteLength(JSON.stringify(body.profile)) > limits.profileBytes) reject('Profile too large', 413);
      const id = body.id === undefined ? randomUUID() : identifier(body.id), name = text(body.name);
      const profile = { id, name, profile: clone(body.profile), updatedAt: Date.now() };
      const index = next.profiles.findIndex(p => p.id === id);
      if (index < 0) { if (next.profiles.length >= limits.profiles) reject('Profile quota exceeded', 413); next.profiles.push(profile); status = 201; }
      else next.profiles[index] = profile;
      result = profile;
      // Editing the selected broadcast creates a newer target, including for offline devices.
      if (next.broadcastProfileId === id) {
        startBroadcast(next, profile);
      }
    } else if (method === 'DELETE' && parts.length === 3 && parts[1] === 'profiles') {
      const p = getProfile(parts[2], next);
      next.profiles = next.profiles.filter(item => item.id !== p.id);
      if (next.broadcastProfileId === p.id) {
        next.broadcastProfileId = null; next.broadcast = null; next.broadcastTargets = [];
        for (const d of next.devices) if (d.pendingCommand?.source === 'broadcast' && d.pendingCommand.profileId === p.id) d.pendingCommand = null;
      }
      // Directed commands keep their immutable snapshot even if the source profile is deleted.
    } else if (method === 'POST' && parts.length === 2 && parts[1] === 'broadcast') {
      if (!object(body)) reject();
      if (body.profileId === null) {
        next.broadcastProfileId = null; next.broadcast = null; next.broadcastTargets = [];
        for (const d of next.devices) if (d.pendingCommand?.source === 'broadcast') d.pendingCommand = null;
      } else {
        const p = getProfile(body.profileId, next);
        startBroadcast(next, p);
      }
    } else if (method === 'POST' && parts.length === 2 && parts[1] === 'dispatch') {
      if (!object(body) || !Array.isArray(body.deviceIds) || !body.deviceIds.length || body.deviceIds.length > limits.devices) reject('Invalid device selection');
      const p = getProfile(body.profileId, next), ids = [...new Set(body.deviceIds)];
      const targets = ids.map(id => getDevice(identifier(id), next));
      const sequence = ++next.sequence;
      for (const d of targets) {
        d.pendingCommand = makeCommand(p, 'direct', sequence);
        const target = next.broadcastTargets.find(t => t.deviceId === d.deviceId);
        if (target) { target.status = 'superseded'; target.acknowledgedAt = null; }
      }
      result = { ok: true, commands: targets.map(d => ({ deviceId: d.deviceId, id: d.pendingCommand.id })) };
    } else reject('Not found', 404);
    await commit(next); json(response, status, result);
  }
  async function serveStatic(request, response, pathname) {
    const files = { '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };
    let root = publicDir;
    let file = Object.hasOwn(files, pathname) ? files[pathname] : null;
    if (['/viewer', '/viewer/', '/viewer/index.html'].includes(pathname)) {
      root = viewerDir; file = ['index.html', 'text/html; charset=utf-8'];
    } else if (/^\/viewer\/assets\/[A-Za-z0-9_-]+\.(js|css|woff2)$/.test(pathname)) {
      root = viewerDir;
      const ext = path.extname(pathname);
      file = [pathname.slice('/viewer/'.length), { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2' }[ext]];
      const assets = await existsStat(path.join(root, 'assets'));
      if (!assets?.isDirectory() || assets.isSymbolicLink()) reject('Not found', 404);
    }
    if (!file || !['GET', 'HEAD'].includes(request.method)) reject('Not found', 404);
    const rootStat = await existsStat(root), target = path.join(root, file[0]);
    if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) reject('Not found', 404);
    const stat = await existsStat(target);
    if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) reject('Not found', 404);
    const content = await fs.readFile(target);
    response.writeHead(200, { 'Content-Type': file[1], 'Content-Length': content.length, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
    response.end(request.method === 'HEAD' ? undefined : content);
  }
  // Bound unauthenticated decryption work and the number of IP bucket entries.
  const ipBuckets = new Map();
  function allowDeviceIp(ip, enrolling) {
    const now = Date.now();
    for (const [key, bucket] of ipBuckets) if (now - bucket.start >= 60_000) ipBuckets.delete(key);
    let bucket = ipBuckets.get(ip);
    if (!bucket) {
      if (ipBuckets.size >= 2048) return false;
      bucket = { start: now, count: 0, enrollCount: 0, failures: 0 }; ipBuckets.set(ip, bucket);
    }
    return ++bucket.count <= limits.deviceRequestsPerMinute && bucket.failures < limits.authFailuresPerMinute
      && (!enrolling || ++bucket.enrollCount <= limits.enrollPerMinute);
  }
  let active = 0;
  const tokenBuffer = Buffer.from(`Bearer ${adminToken}`);
  const server = http.createServer({ maxHeaderSize: 16 * 1024, requestTimeout: 15_000, headersTimeout: 10_000, keepAliveTimeout: 5000 }, async (request, response) => {
    if (active >= limits.concurrentRequests) { json(response, 503, { error: 'request rejected' }); request.resume(); return; }
    active++;
    const timer = setTimeout(() => { request.destroy(); }, 20_000); timer.unref();
    let isDevice = false;
    try {
      const url = new URL(request.url, 'http://control.local');
      const isSync = url.pathname === '/sync', isEnroll = url.pathname === '/enroll';
      isDevice = isSync || isEnroll;
      const ip = request.socket.remoteAddress ?? 'unknown';
      if (isDevice) response.once('finish', () => {
        if (response.statusCode >= 400) { const bucket = ipBuckets.get(ip); if (bucket) bucket.failures++; }
      });
      const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');
      if ((isApi || isDevice) && !sameOrigin(request, publicOrigin)) reject('Cross-origin request denied', 403);
      if (isApi) {
        const supplied = Buffer.from(request.headers.authorization ?? '');
        if (supplied.length !== tokenBuffer.length || !timingSafeEqual(supplied, tokenBuffer)) reject('Unauthorized', 401);
      }
      if (isDevice && request.method === 'POST') {
        if (!allowDeviceIp(ip, isEnroll)) reject('Rate limit exceeded', 429);
        const body = await readBody(request, limits.requestBytes);
        await serial(() => {
          if (ipBuckets.get(ip)?.failures >= limits.authFailuresPerMinute) reject('Rate limit exceeded', 429);
          return isEnroll ? enroll(body, response) : sync(body, request, response);
        });
      } else if (isApi) {
        const parts = url.pathname.split('/').filter(Boolean).map(part => { try { return decodeURIComponent(part); } catch { reject('Invalid path'); } });
        const body = ['POST', 'PATCH'].includes(request.method) ? await readBody(request, limits.requestBytes) : undefined;
        // Synchronous /state sees committed snapshots without waiting on disk I/O.
        // Session file reads remain serialized against in-flight appends.
        if (request.method === 'GET' && parts.length === 2 && parts[1] === 'state') await admin(request.method, parts, body, response);
        else await serial(() => admin(request.method, parts, body, response));
      } else await serveStatic(request, response, url.pathname);
    } catch (error) {
      if (!response.headersSent && !response.destroyed) json(response, error.status ?? 500, { error: isDevice ? 'request rejected' : error.status ? error.message : 'Internal error' });
    } finally { clearTimeout(timer); active--; if (!request.complete) request.resume(); }
  });
  server.on('clientError', (_error, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });
  server.control = { dataDir, limits: { ...limits } };
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const server = await createControlServer();
    const host = process.env.CONTROL_HOST ?? '127.0.0.1';
    const port = Number(process.env.CONTROL_PORT ?? 8787);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid CONTROL_PORT');
    server.listen(port, host, () => console.log(`Control server listening on http://${host}:${server.address().port}`));
    server.on('error', error => { console.error(error.message); process.exitCode = 1; });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(() => { process.exitCode = 0; }); server.closeIdleConnections(); });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

import path from 'node:path';
import { mkdir, readFile, readdir, rmdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { QueryEngine, WebRepl } from './core-runtime.mjs';

export function createWorkspaceRuntimeManager(options) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const workspaceRoot = path.resolve(options.workspaceRoot || path.join(projectRoot, 'workspace'));
  const registryFile = path.resolve(options.registryFile || path.join(projectRoot, '.neoctl-web', 'session-workspaces.json'));
  const registry = new SessionWorkspaceRegistry(registryFile, workspaceRoot);
  const maxSubscribers = positiveNumber(process.env.NEO_SESSION_MAX_SUBSCRIBERS, 32);
  const claimedWorkspacePaths = new Set();
  const pendingWorkspacePaths = new Set();
  let claimedWorkspacePathsLoaded = false;
  let workspaceAllocationQueue = Promise.resolve();

  const withWorkspaceAllocationLock = (operation) => {
    const result = workspaceAllocationQueue.then(operation, operation);
    workspaceAllocationQueue = result.then(() => undefined, () => undefined);
    return result;
  };

  const loadClaimedWorkspacePaths = async () => {
    if (claimedWorkspacePathsLoaded) return;
    for (const cwd of await registry.paths()) claimedWorkspacePaths.add(cwd);
    claimedWorkspacePathsLoaded = true;
  };

  const reserveWorkspacePath = () => withWorkspaceAllocationLock(async () => {
    await loadClaimedWorkspacePaths();
    const candidate = await reserveWorkspace(workspaceRoot, claimedWorkspacePaths);
    pendingWorkspacePaths.add(candidate);
    return candidate;
  });

  const materializeWorkspacePath = (candidate) => withWorkspaceAllocationLock(async () => {
    await loadClaimedWorkspacePaths();
    const cwd = await materializeWorkspace(workspaceRoot, candidate, claimedWorkspacePaths);
    pendingWorkspacePaths.delete(candidate);
    return cwd;
  });

  const markCwdNoticeConsumed = async (sessionId) => {
    const entry = await registry.entry(sessionId);
    if (entry?.cwdNoticePending) await registry.set(sessionId, entry.cwd, { ...entry, cwdNoticePending: false });
  };

  class WorkspaceWebRepl extends WebRepl {
    syncScheduled = false;

    subscribe(res) {
      if (this.subscribers.size >= maxSubscribers) {
        res.writeHead(503, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
          'Retry-After': '30',
        });
        res.end('too many live viewers for this session');
        return;
      }
      super.subscribe(res);
    }

    snapshot(includeCatalog = false) {
      return {
        ...super.snapshot(includeCatalog),
        cwd: currentEngineCwd(this.runtime.engine, projectRoot),
      };
    }

    async submit(text, attachments = []) {
      if (!String(text || '').trim() && attachments.length === 0) return super.submit(text, attachments);
      await this.materializeCurrentWorkspace();
      return super.submit(text, attachments);
    }

    async browseWorkspace(value) {
      try {
        return { ok: true, ...(await browseWorkspace(value, currentEngineCwd(this.runtime.engine, projectRoot))) };
      } catch (error) {
        return workspaceFailure('CWD_INVALID', error);
      }
    }

    async createWorkspaceDirectory(value) {
      try {
        const current = currentEngineCwd(this.runtime.engine, projectRoot);
        const target = resolveWorkspaceInput(value, current);
        await mkdir(target, { recursive: true });
        return { ok: true, ...(await browseWorkspace(target, current)) };
      } catch (error) {
        return workspaceFailure('CWD_CREATE_FAILED', error);
      }
    }

    async deleteWorkspaceDirectory(value) {
      try {
        const current = currentEngineCwd(this.runtime.engine, projectRoot);
        const target = resolveWorkspaceInput(value, current);
        const root = path.parse(target).root;
        if (target === root || isSameOrAncestor(target, current)) throw new Error('当前工作目录及其上级目录不能删除');
        await rmdir(target);
        return { ok: true, ...(await browseWorkspace(path.dirname(target), current)) };
      } catch (error) {
        return workspaceFailure('CWD_DELETE_FAILED', error);
      }
    }

    async changeWorkspace(value) {
      if (this.busy) return { ok: false, errorCode: 'CWD_UPDATE_BLOCKED', error: '模型回答期间不能切换工作目录' };
      try {
        const previous = currentEngineCwd(this.runtime.engine, projectRoot);
        const cwd = await validateWorkspaceDirectory(resolveWorkspaceInput(value, previous));
        if (cwd === previous) return { ok: true, cwd, unchanged: true };
        const snapshot = this.runtime.engine.snapshot().session;
        if (!snapshot) throw new Error('session transcripts are disabled');
        const stored = await registry.entry(snapshot.sessionId);
        const history = normalizeCwdHistory(stored?.cwdHistory, previous);
        if (history.at(-1) !== previous) history.push(previous);
        if (history.at(-1) !== cwd) history.push(cwd);
        await registry.set(snapshot.sessionId, cwd, {
          materialized: true,
          cwdHistory: history,
          cwdNoticePending: true,
        });
        this.runtime.engine = createWorkspaceEngine(this.runtime.engine, cwd, snapshot.sessionId, true, {
          cwdTransitionPaths: history,
          onCwdTransitionConsumed: () => markCwdNoticeConsumed(snapshot.sessionId),
        });
        await this.runtime.engine.initialize();
        registerEngineSync(this);
        await Promise.all([this.loadSessionPlugins(snapshot.sessionId), this.loadSessionTools(snapshot.sessionId)]);
        await this.refreshSessionView();
        return { ok: true, cwd, history };
      } catch (error) {
        return workspaceFailure('CWD_UPDATE_FAILED', error);
      }
    }

    async materializeCurrentWorkspace() {
      const candidate = currentEngineCwd(this.runtime.engine, projectRoot);
      if (!isInsideRoot(candidate, workspaceRoot)) return candidate;
      if (!pendingWorkspacePaths.has(candidate) && await pathExists(candidate)) {
        claimedWorkspacePaths.add(candidate);
        return candidate;
      }

      const cwd = await materializeWorkspacePath(candidate);
      const snapshot = this.runtime.engine.snapshot().session;
      if (!snapshot) throw new Error('session transcripts are disabled');
      if (cwd !== candidate) {
        this.runtime.engine = createWorkspaceEngine(this.runtime.engine, cwd, snapshot.sessionId, true);
        await this.runtime.engine.initialize();
        registerEngineSync(this);
        await Promise.all([this.loadSessionPlugins(snapshot.sessionId), this.loadSessionTools(snapshot.sessionId)]);
        await this.refreshSessionView();
      }
      await registry.set(snapshot.sessionId, cwd, { materialized: true, cwdHistory: [cwd] });
      return cwd;
    }

    async newSession() {
      try {
        await this.detachRunningForeground('new session');
        const cwd = await reserveWorkspacePath();
        this.runtime.engine = createWorkspaceEngine(this.runtime.engine, cwd, undefined, false);
        await this.runtime.engine.initialize();
        registerEngineSync(this);
        const snapshot = this.runtime.engine.snapshot().session;
        if (!snapshot) throw new Error('session transcripts are disabled');
        await Promise.all([this.loadSessionPlugins(snapshot.sessionId), this.loadSessionTools(snapshot.sessionId)]);
        await registry.set(snapshot.sessionId, cwd, { materialized: false, cwdHistory: [cwd] });
        await this.refreshSessionView();
        return { ok: true, cwd };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, errorCode: 'SESSION_CREATE_FAILED', error: message };
      }
    }

    async resumeSession(sessionId) {
      if (!sessionId) return { ok: false, errorCode: 'INVALID_REQUEST', error: 'sessionId is required' };
      if (this.backgroundSessionRuns.has(sessionId)) return super.resumeSession(sessionId);
      try {
        await this.detachRunningForeground('session switch');
        const workspace = await registry.entry(sessionId);
        const cwd = workspace?.cwd || projectRoot;
        if (workspace && !workspace.materialized) pendingWorkspacePaths.add(cwd);
        this.runtime.engine = createWorkspaceEngine(this.runtime.engine, cwd, sessionId, true, {
          cwdTransitionPaths: workspace?.cwdNoticePending ? workspace.cwdHistory : undefined,
          onCwdTransitionConsumed: () => markCwdNoticeConsumed(sessionId),
        });
        await this.runtime.engine.initialize();
        registerEngineSync(this);
        const snapshot = this.runtime.engine.snapshot().session;
        if (!snapshot) throw new Error('session transcripts are disabled');
        await Promise.all([this.loadSessionPlugins(snapshot.sessionId), this.loadSessionTools(snapshot.sessionId)]);
        await this.refreshSessionView();
        return { ok: true, cwd };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, errorCode: 'SESSION_RESUME_FAILED', error: message };
      }
    }

    broadcastSync() {
      if (this.syncScheduled) return;
      this.syncScheduled = true;
      setImmediate(() => {
        this.syncScheduled = false;
        const payload = this.snapshot(false);
        for (const subscriber of this.subscribers) {
          const res = subscriber.response;
          if (res.destroyed || res.writableEnded) continue;
          this.send(subscriber, 'sync', payload);
        }
      });
    }
  }

  return {
    workspaceRoot,
    async createRuntime(runtimeOptions = {}) {
      const mappedWorkspace = runtimeOptions.sessionId
        ? await registry.entry(runtimeOptions.sessionId)
        : undefined;
      const mappedCwd = mappedWorkspace?.cwd;
      const shouldAllocate = !mappedCwd && runtimeOptions.resume === false;
      const cwd = mappedCwd || (shouldAllocate ? await reserveWorkspacePath() : projectRoot);
      if (mappedCwd && (!mappedWorkspace.materialized || !await pathExists(mappedCwd))) {
        claimedWorkspacePaths.add(mappedCwd);
        pendingWorkspacePaths.add(mappedCwd);
      }
      const runtime = await options.createRuntime({
        ...runtimeOptions,
        cwd,
        cwdTransitionPaths: mappedWorkspace?.cwdNoticePending ? mappedWorkspace.cwdHistory : undefined,
        onCwdTransitionConsumed: runtimeOptions.sessionId
          ? () => markCwdNoticeConsumed(runtimeOptions.sessionId)
          : undefined,
      });
      const sessionId = runtime.engine.snapshot().session?.sessionId;
      if (sessionId && cwd !== projectRoot) {
        await registry.set(sessionId, cwd, { materialized: !pendingWorkspacePaths.has(cwd) });
      }
      return runtime;
    },
    createRepl(runtime) {
      return new WorkspaceWebRepl(runtime);
    },
  };
}

function createWorkspaceEngine(source, cwd, sessionId, resume, overrides = {}) {
  const settings = source.getModelSettings();
  return new QueryEngine({
    ...source.options,
    cwd,
    model: settings.model,
    reasoning: settings.reasoning,
    ...overrides,
    session: source.options.session
      ? { ...source.options.session, sessionId, resume }
      : undefined,
  });
}

function registerEngineSync(repl) {
  repl.runtime.engine.onSessionTitleChange(() => repl.broadcastSync());
}

function currentEngineCwd(engine, fallback) {
  return path.resolve(engine?.cwd || engine?.options?.cwd || fallback);
}

export async function reserveWorkspace(root, claimed = new Set()) {
  await mkdir(root, { recursive: true });
  const now = new Date();
  for (let offset = 0; offset < 120; offset += 1) {
    const candidate = path.join(root, formatWorkspaceStamp(new Date(now.getTime() + offset * 1000)));
    if (claimed.has(candidate) || await pathExists(candidate)) continue;
    claimed.add(candidate);
    return candidate;
  }
  throw new Error('unable to reserve a unique workspace directory');
}

export async function materializeWorkspace(root, candidate, claimed = new Set()) {
  await mkdir(root, { recursive: true });
  const resolvedCandidate = path.resolve(candidate);
  if (!isInsideRoot(resolvedCandidate, root)) throw new Error('workspace path is outside workspace root');
  try {
    await mkdir(resolvedCandidate);
    claimed.add(resolvedCandidate);
    return resolvedCandidate;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }

  claimed.delete(resolvedCandidate);
  const replacement = await reserveWorkspace(root, claimed);
  await mkdir(replacement);
  claimed.add(replacement);
  return replacement;
}

async function pathExists(candidate) {
  try {
    await stat(candidate);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function formatWorkspaceStamp(date) {
  const two = (value) => String(value).padStart(2, '0');
  return [
    two(date.getFullYear() % 100),
    two(date.getMonth() + 1),
    two(date.getDate()),
    two(date.getHours()),
    two(date.getMinutes()),
    two(date.getSeconds()),
  ].join('');
}

export class SessionWorkspaceRegistry {
  constructor(file, workspaceRoot) {
    this.file = file;
    this.workspaceRoot = workspaceRoot;
    this.items = undefined;
    this.writeQueue = Promise.resolve();
  }

  async get(sessionId) {
    return (await this.entry(sessionId))?.cwd;
  }

  async entry(sessionId) {
    const items = await this.load();
    const value = items[String(sessionId || '')];
    if (!value) return undefined;
    const rawCwd = typeof value === 'string' ? value : value?.cwd;
    if (!rawCwd) return undefined;
    const cwd = path.resolve(rawCwd);
    return {
      cwd,
      materialized: typeof value === 'string' ? true : value.materialized !== false,
      cwdHistory: normalizeCwdHistory(typeof value === 'string' ? undefined : value.cwdHistory, cwd),
      cwdNoticePending: typeof value === 'string' ? false : value.cwdNoticePending === true,
    };
  }

  async set(sessionId, cwd, options = {}) {
    const id = String(sessionId || '').trim();
    if (!id) return;
    const resolved = path.resolve(cwd);
    const items = await this.load();
    const previous = items[id];
    const previousObject = typeof previous === 'object' && previous ? previous : {};
    items[id] = {
      ...previousObject,
      cwd: resolved,
      materialized: options.materialized !== false,
      cwdHistory: normalizeCwdHistory(options.cwdHistory ?? previousObject.cwdHistory, resolved),
      cwdNoticePending: options.cwdNoticePending === undefined
        ? previousObject.cwdNoticePending === true
        : options.cwdNoticePending === true,
    };
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFile(this.file, `${JSON.stringify(items, null, 2)}\n`, 'utf8');
    });
    await this.writeQueue;
  }

  async paths() {
    const items = await this.load();
    return Object.values(items)
      .map((value) => path.resolve(String(typeof value === 'string' ? value : value?.cwd || '')))
      .filter((value) => isInsideRoot(value, this.workspaceRoot));
  }

  async load() {
    if (this.items) return this.items;
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8'));
      this.items = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      this.items = {};
    }
    return this.items;
  }
}

export async function browseWorkspace(value, currentCwd) {
  const requested = resolveWorkspaceInput(value, currentCwd);
  const locationsPromise = discoverWorkspaceLocations();
  const { current, entries } = await browseWorkspaceDirectoryOrAncestor(requested);
  const locations = await locationsPromise;
  return {
    cwd: current,
    requested,
    fallback: path.resolve(current) !== path.resolve(requested),
    parent: current === path.parse(current).root ? undefined : path.dirname(current),
    home: os.homedir(),
    locations,
    entries: entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ name: entry.name, path: path.join(current, entry.name) }))
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })),
  };
}

async function browseWorkspaceDirectoryOrAncestor(candidate) {
  let current = path.resolve(candidate);
  let missingError;
  while (true) {
    try {
      const info = await stat(current);
      if (!info.isDirectory()) throw new Error('路径不是文件夹');
      return { current, entries: await readdir(current, { withFileTypes: true }) };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      missingError ||= error;
      const parent = path.dirname(current);
      if (parent === current) throw missingError;
      current = parent;
    }
  }
}

let workspaceLocationsCache;
let workspaceLocationsCachedAt = 0;

export async function discoverWorkspaceLocations() {
  if (workspaceLocationsCache && Date.now() - workspaceLocationsCachedAt < 5000) return workspaceLocationsCache;
  const home = os.homedir();
  const candidates = [
    { id: 'home', label: '主目录', path: home, kind: 'home' },
    ...[
      ['desktop', '桌面', ['Desktop', '桌面']],
      ['documents', '文档', ['Documents', '文档']],
      ['downloads', '下载', ['Downloads', '下载']],
    ].flatMap(([id, label, names]) => names.map((name) => ({ id, label, path: path.join(home, name), kind: 'favorite' }))),
  ];

  if (process.platform === 'win32') {
    const drives = await Promise.all('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(async (letter) => {
      const drivePath = `${letter}:\\`;
      return await directoryExists(drivePath)
        ? { id: `drive-${letter}`, label: `本地磁盘 (${letter}:)`, path: drivePath, kind: 'drive' }
        : undefined;
    }));
    candidates.push(...drives.filter(Boolean));
  } else {
    candidates.push({ id: 'root', label: '文件系统', path: '/', kind: 'root' });
    const mountRoots = process.platform === 'darwin'
      ? ['/Volumes']
      : ['/mnt', '/media', path.join('/media', os.userInfo().username), path.join('/run/media', os.userInfo().username)];
    for (const mountRoot of mountRoots) {
      const mounts = await readdir(mountRoot, { withFileTypes: true }).catch(() => []);
      for (const mount of mounts.filter((entry) => entry.isDirectory())) {
        candidates.push({ id: `volume-${mount.name}`, label: mount.name, path: path.join(mountRoot, mount.name), kind: 'volume' });
      }
    }
  }

  const seen = new Set();
  const locations = [];
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate.path);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key) || !await directoryExists(resolved)) continue;
    seen.add(key);
    locations.push({ ...candidate, path: resolved });
  }
  workspaceLocationsCache = locations;
  workspaceLocationsCachedAt = Date.now();
  return locations;
}

export function resolveWorkspaceInput(value, currentCwd) {
  let input = String(value || '').trim().replace(/^["']|["']$/g, '');
  if (!input) return path.resolve(currentCwd || process.cwd());
  if (input === '~') input = os.homedir();
  else if (input.startsWith('~/') || input.startsWith('~\\')) input = path.join(os.homedir(), input.slice(2));
  input = input.replace(/[\\/]+/g, path.sep);
  if (process.platform === 'win32' && /^[a-zA-Z]:$/.test(input)) input += path.sep;
  return path.resolve(currentCwd || process.cwd(), input);
}

async function validateWorkspaceDirectory(candidate) {
  const resolved = path.resolve(candidate);
  const info = await stat(resolved);
  if (!info.isDirectory()) throw new Error('路径不是文件夹');
  return resolved;
}

async function directoryExists(candidate) {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

function normalizeCwdHistory(value, fallback) {
  const history = Array.isArray(value) ? value.map((entry) => String(entry || '').trim()).filter(Boolean) : [];
  if (!history.length && fallback) history.push(path.resolve(fallback));
  return history;
}

function isSameOrAncestor(candidate, descendant) {
  const relative = path.relative(path.resolve(candidate), path.resolve(descendant));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function workspaceFailure(errorCode, error) {
  return { ok: false, errorCode, error: error instanceof Error ? error.message : String(error) };
}

function isInsideRoot(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

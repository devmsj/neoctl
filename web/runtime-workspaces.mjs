import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { QueryEngine, WebRepl } from './core-runtime.mjs';

export function createWorkspaceRuntimeManager(options) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const workspaceRoot = path.resolve(options.workspaceRoot || path.join(projectRoot, 'workspace'));
  const registryFile = path.resolve(options.registryFile || path.join(projectRoot, '.neoctl-web', 'session-workspaces.json'));
  const registry = new SessionWorkspaceRegistry(registryFile, workspaceRoot);
  const maxSubscribers = positiveNumber(process.env.NEO_SESSION_MAX_SUBSCRIBERS, 32);

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

    async newSession() {
      try {
        await this.detachRunningForeground('new session');
        const cwd = await allocateWorkspace(workspaceRoot);
        this.runtime.engine = createWorkspaceEngine(this.runtime.engine, cwd, undefined, false);
        await this.runtime.engine.initialize();
        registerEngineSync(this);
        const snapshot = this.runtime.engine.snapshot().session;
        if (!snapshot) throw new Error('session transcripts are disabled');
        await this.loadSessionPlugins(snapshot.sessionId);
        await registry.set(snapshot.sessionId, cwd);
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
        const cwd = await registry.get(sessionId) || projectRoot;
        this.runtime.engine = createWorkspaceEngine(this.runtime.engine, cwd, sessionId, true);
        await this.runtime.engine.initialize();
        registerEngineSync(this);
        const snapshot = this.runtime.engine.snapshot().session;
        if (!snapshot) throw new Error('session transcripts are disabled');
        await this.loadSessionPlugins(snapshot.sessionId);
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
      const mappedCwd = runtimeOptions.sessionId
        ? await registry.get(runtimeOptions.sessionId)
        : undefined;
      const shouldAllocate = !mappedCwd && runtimeOptions.resume === false;
      const cwd = mappedCwd || (shouldAllocate ? await allocateWorkspace(workspaceRoot) : projectRoot);
      const runtime = await options.createRuntime({ ...runtimeOptions, cwd });
      const sessionId = runtime.engine.snapshot().session?.sessionId;
      if (sessionId && cwd !== projectRoot) await registry.set(sessionId, cwd);
      return runtime;
    },
    createRepl(runtime) {
      return new WorkspaceWebRepl(runtime);
    },
  };
}

function createWorkspaceEngine(source, cwd, sessionId, resume) {
  const settings = source.getModelSettings();
  return new QueryEngine({
    ...source.options,
    cwd,
    model: settings.model,
    reasoning: settings.reasoning,
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

async function allocateWorkspace(root) {
  await mkdir(root, { recursive: true });
  const now = new Date();
  for (let offset = 0; offset < 120; offset += 1) {
    const candidate = path.join(root, formatWorkspaceStamp(new Date(now.getTime() + offset * 1000)));
    try {
      await mkdir(candidate);
      return candidate;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  throw new Error('unable to allocate a unique workspace directory');
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

class SessionWorkspaceRegistry {
  constructor(file, workspaceRoot) {
    this.file = file;
    this.workspaceRoot = workspaceRoot;
    this.items = undefined;
    this.writeQueue = Promise.resolve();
  }

  async get(sessionId) {
    const items = await this.load();
    const value = items[String(sessionId || '')];
    if (!value) return undefined;
    const resolved = path.resolve(value);
    return isInsideRoot(resolved, this.workspaceRoot) ? resolved : undefined;
  }

  async set(sessionId, cwd) {
    const id = String(sessionId || '').trim();
    if (!id) return;
    const resolved = path.resolve(cwd);
    if (!isInsideRoot(resolved, this.workspaceRoot)) return;
    const items = await this.load();
    items[id] = resolved;
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFile(this.file, `${JSON.stringify(items, null, 2)}\n`, 'utf8');
    });
    await this.writeQueue;
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

function isInsideRoot(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

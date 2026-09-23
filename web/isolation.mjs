import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { createIsolationAuth, createIsolationAccounts, publicUser, loadIsolationConfig, jsonReply, readBoundedJson, httpError } from './isolation-auth.mjs';

const SESSION_ID = /^(?!\.{1,2}$)[a-zA-Z0-9_.-]{1,220}$/;
const GET_ROUTES = new Set(['/api/client-info', '/api/state', '/api/runtime-context', '/api/sessions', '/api/cwd', '/api/tools', '/api/session-tools', '/api/session-plugins', '/api/tool-call-detail', '/api/terminal-output', '/api/agent-content', '/events']);
const POST_ROUTES = new Set(['/api/submit', '/api/submit-now', '/api/interrupt', '/api/queue/cancel', '/api/queue/send-now', '/api/sessions/resume', '/api/sessions/new', '/api/sessions/delete', '/api/cwd/change', '/api/cwd/create', '/api/cwd/delete', '/api/session-model', '/api/session-tools', '/api/session-plugins', '/api/compact', '/api/fast-mode', '/api/context-window']);
const SAFE_COMMANDS = new Set(['/help', '/cost', '/compact', '/pure', '/new', '/sessions', '/state', '/reset']);
const inside = (root, target) => { const relative = path.relative(root, target); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); };

export async function assertOwnedSession(root, sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId) || sessionId === 'latest') throw httpError(404, '会话不存在');
  try {
    const folder = path.join(root, sessionId);
    const info = await fs.lstat(folder);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error();
    const transcript = await fs.lstat(path.join(folder, 'transcript.jsonl')).catch(error => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (transcript && (!transcript.isFile() || transcript.isSymbolicLink())) throw new Error();
  } catch { throw httpError(404, '会话不存在'); }
}

export function sanitizeIsolatedSnapshot(value) {
  const result = { ...value };
  if (result.interactive) result.interactive = { sessions: true };
  if (result.catalog) result.catalog = { ...result.catalog, envPath: undefined, commands: result.catalog.commands?.filter(x => SAFE_COMMANDS.has(x.name)) };
  result.appPrompt = undefined;
  return result;
}

/** Web-only identity boundary. The core receives neither credentials nor user identities. */
export async function createIsolationMode({ dataRoot, workspaceRoot, pluginDir, pluginManager, configFile, memoryState = () => ({ current: null, history: [] }), cpaQuotaMonitor, pluginSettings, toolSettings }) {
  const config = await loadIsolationConfig(dataRoot, configFile);
  if (!config.enabled) return {
    enabled: false,
    async route(req, res, url) {
      if (url.pathname === '/api/auth/status' && req.method === 'GET') {
        jsonReply(res, { isolation: false, user: null }); return true;
      }
      return false;
    },
    close() {},
  };
  const core = await import('./core-runtime.mjs');
  if (!core.handleWebRequest) throw new Error('隔离模式需要支持 handleWebRequest 的 core，请先构建或更新 core');
  if (process.env.AGENT_SESSION_TRANSCRIPT === '0') throw new Error('隔离模式要求启用会话存储');
  const { installRuntimeRouterIdleCleanup } = await import('./runtime-router-cleanup.mjs');
  installRuntimeRouterIdleCleanup();
  const { createWorkspaceRuntimeManager } = await import('./runtime-workspaces.mjs');
  const { createPluginManager } = await import('./plugin-manager.mjs');
  pluginManager ||= await createPluginManager({ directory: path.join(dataRoot, 'installed-plugins'), builtInDirectory: pluginDir, loadPlugins: core.loadNeoPlugins });
  const { createWebPluginSettings } = await import('./plugin-settings.mjs');
  const { createWebToolSettings } = await import('./tool-settings.mjs');
  const { createChunkUploadHandler } = await import('./chunk-uploads.mjs');
  const { workspaceFs, openWorkspaceRead, containerMode } = await import('./execution-backend.mjs');
  const globalPlugins = pluginSettings || await createWebPluginSettings(path.join(dataRoot, 'plugins.json'));
  const globalTools = toolSettings || await createWebToolSettings(path.join(dataRoot, 'tools.json'));
  const users = new Map();
  let modelConfigQueue = Promise.resolve();
  const withModelConfigLock = operation => {
    const result = modelConfigQueue.then(operation);
    modelConfigQueue = result.catch(() => {});
    return result;
  };
  const accounts = createIsolationAccounts(config, { dataRoot, onDelete: username => auth.revokeUser(username) });
  const auth = createIsolationAuth(config, accounts);
  const allOwners = () => [...config.users, ...config.retiredUsernames.map(username => ({ username, role: 'user', deleted: true }))];
  async function adminRoute(req, res, url) {
    if (url.pathname === '/api/admin/users' && req.method === 'GET') {
      jsonReply(res, { users: accounts.list() }); return;
    }
    if (url.pathname === '/api/admin/users' && req.method === 'POST') {
      jsonReply(res, { user: await accounts.create(await readBoundedJson(req, 8192)) }, 201); return;
    }
    if (url.pathname === '/api/admin/users/delete' && req.method === 'POST') {
      const body = await readBoundedJson(req, 4096);
      await accounts.remove(body?.username); jsonReply(res, { ok: true }); return;
    }
    if (url.pathname === '/api/admin/sessions' && req.method === 'GET') {
      const groups = [];
      for (const owner of allOwners()) {
        const engine = new core.QueryEngine({ agentId: 'main', cwd: path.join(workspaceRoot, 'users', owner.username), session: { rootDir: path.join(dataRoot, 'isolated-users', owner.username, 'sessions') } });
        groups.push({ user: { ...publicUser(owner), deleted: owner.deleted === true }, sessions: await engine.listSessions(Number.POSITIVE_INFINITY) });
      }
      jsonReply(res, { groups }); return;
    }
    throw httpError(404, '接口不存在');
  }

  async function createUser(user) {
    const root = path.join(dataRoot, 'isolated-users', user.username);
    const sessionsRoot = path.join(root, 'sessions');
    const uploadsRoot = path.join(root, 'uploads');
    const workRoot = path.join(workspaceRoot, 'users', user.username);
    await fs.mkdir(sessionsRoot, { recursive: true, mode: 0o700 });
    const pluginEnv = { ...process.env };
    for (const key of ['NEO_DOWNLOADS_DIR', 'NEO_VIDEO_SHARE_DIR', 'NEO_XHS_ARTIFACTS_DIR']) delete pluginEnv[key];
    const settings = await createWebPluginSettings(path.join(root, 'plugins.json'));
    const tools = await createWebToolSettings(path.join(root, 'tools.json'));
    const pluginHost = await pluginManager.createHost({
      enabled: process.env.NEO_WEB_PLUGINS?.trim() || globalPlugins.globalEnabledIds(), locked: Boolean(process.env.NEO_WEB_PLUGINS?.trim()),
      settings: { ...settings, globalEnabledIds: () => globalPlugins.globalEnabledIds(), setGlobalEnabled: ids => globalPlugins.setGlobalEnabled(ids) },
    }, { appDataDir: root, env: pluginEnv });
    const manager = createWorkspaceRuntimeManager({
      projectRoot: workRoot, workspaceRoot: workRoot, registryFile: path.join(root, 'workspaces.json'),
      createRuntime: options => core.createWebRuntime({
        ...options, sessionId: options.sessionId || randomUUID(), sessionRootDir: sessionsRoot, resume: !!options.sessionId,
        ...pluginHost.runtimePlugins(options.sessionId),
        globalToolOverrides: globalTools.globalOverrides(),
        resolveGlobalToolOverrides: () => globalTools.globalOverrides(),
        persistGlobalToolOverrides: overrides => globalTools.setGlobalOverrides(overrides),
        sessionToolOverrides: tools.sessionOverrides(options.sessionId),
        persistSessionToolOverrides: (id, overrides) => tools.setSessionOverrides(id, overrides),
        resolveSessionToolOverrides: id => tools.sessionOverrides(id),
      }),
    });
    const router = new core.WebRuntimeRouter({
      createRuntime: options => manager.createRuntime({ ...options, resume: !!options?.sessionId }),
      createRepl(runtime) {
        const repl = manager.createRepl(runtime);
        const snapshot = repl.snapshot.bind(repl);
        repl.snapshot = includeCatalog => sanitizeIsolatedSnapshot(snapshot(includeCatalog));
        // These are public extension methods; no changes to the model/query loop.
        const resume = repl.resumeSession.bind(repl), remove = repl.deleteSession.bind(repl);
        repl.resumeSession = async id => { await assertOwnedSession(sessionsRoot, id); return resume(id); };
        repl.deleteSession = async id => { await assertOwnedSession(sessionsRoot, id); return remove(id); };
        const browse = repl.browseWorkspace.bind(repl);
        repl.browseWorkspace = async value => {
          const result = await browse(value);
          if (!result.ok) return result;
          return { ...result, home: workRoot, parent: result.cwd === workRoot ? undefined : result.parent,
            locations: [{ name: '工作区', path: workRoot }], entries: result.entries.filter(entry => inside(workRoot, entry.path)) };
        };
        return repl;
      },
    });
    const getRuntime = router.get.bind(router);
    router.get = scope => withModelConfigLock(() => getRuntime(scope));
    async function checkedWorkspace(target, allowMissing = false) {
      const absolute = path.resolve(target);
      if (!inside(workRoot, absolute)) throw httpError(403, '工作区访问被拒绝');
      let cursor = absolute;
      while (true) {
        try {
          const resolved = await workspaceFs.realpath(cursor);
          if (!inside(workRoot, resolved)) throw httpError(403, '工作区访问被拒绝');
          return absolute;
        } catch (error) {
          if (!allowMissing || error.code !== 'ENOENT' || cursor === workRoot) throw error;
          cursor = path.dirname(cursor);
        }
      }
    }
    const scopeFor = url => ({ sessionId: url.searchParams.get('sessionId') || undefined, tabId: url.searchParams.get('tabId') || 'default' });
    async function finalize(file, url) {
      if (!containerMode) return file;
      const repl = await router.get(scopeFor(url));
      const cwd = await repl.materializeCurrentWorkspace();
      await checkedWorkspace(cwd);
      const destination = path.join(cwd, file.storedName);
      // Existing upload delivery supports a resolved workspace without an HTTP side channel.
      const { deliverUploadToWorkspace } = await import('./execution-backend.mjs');
      return deliverUploadToWorkspace(file, destination);
    }
    const chunks = createChunkUploadHandler({ uploadsDir: uploadsRoot, baseDir: root, finalize });
    return { root, sessionsRoot, uploadsRoot, workRoot, router, pluginHost, checkedWorkspace, scopeFor, finalize, chunks };
  }
  function userContext(user) {
    if (!users.has(user.username)) {
      const pending = createUser(user);
      users.set(user.username, pending);
      pending.catch(() => users.delete(user.username));
    }
    return users.get(user.username);
  }
  async function serveFile(req, res, filename, workspace = false, image = false) {
    let handle;
    try {
      handle = workspace ? await openWorkspaceRead(filename) : await fs.open(filename, 'r');
      const stat = await handle.stat();
      if (!stat.isFile()) throw httpError(404, '文件不存在');
      const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
      const type = image ? types[path.extname(filename).toLowerCase()] : 'application/octet-stream';
      if (!type) throw httpError(404, '图片不存在');
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...(image ? {} : { 'Content-Disposition': 'attachment' }) });
      if (req.method === 'HEAD') { res.end(); return; }
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        if (res.destroyed) break;
        if (!res.write(chunk)) await new Promise(resolve => { res.once('drain', resolve); res.once('close', resolve); });
      }
      res.end();
    } finally { await handle?.close(); }
  }
  return {
    enabled: true,
    close: () => auth.close(),
    async route(req, res, url) {
      // Static application assets contain no user data. Every dynamic route is handled here.
      if (!/^\/(api(?:\/|$)|events(?:\/|$)|vendor(?:\/|$))/.test(url.pathname)) return false;
      try {
        // Core images and plugin downloads normally use long-lived caches. Do not
        // let a browser reuse protected content after logout/account switching.
        const writeHead = res.writeHead;
        res.writeHead = function (status, message, headers) {
          const supplied = typeof message === 'string' ? headers : message;
          const clean = { ...supplied };
          for (const name of Object.keys(clean)) if (['cache-control', 'vary', 'x-content-type-options'].includes(name.toLowerCase())) delete clean[name];
          clean['Cache-Control'] = 'private, no-store';
          clean.Vary = 'Cookie';
          clean['X-Content-Type-Options'] = 'nosniff';
          return typeof message === 'string' ? writeHead.call(this, status, message, clean) : writeHead.call(this, status, clean);
        };
        res.setHeader('Cache-Control', 'private, no-store');
        if (await auth.route(req, res, url)) return true;
        const session = auth.authenticate(req);
        if (!session) { jsonReply(res, { errorCode: 'AUTH_REQUIRED', error: '请先登录' }, 401); return true; }
        const isAdmin = session.user.role === 'admin';
        if (url.pathname.startsWith('/api/admin/')) {
          if (!isAdmin) throw httpError(403, '仅超管可管理用户');
          await adminRoute(req, res, url); return true;
        }
        if (url.pathname === '/api/memory' && req.method === 'GET') {
          jsonReply(res, memoryState()); return true;
        }
        if (url.pathname === '/api/cpa-quota' && req.method === 'GET') {
          const state = cpaQuotaMonitor?.getPublicState() || { config: { url: '', hasPassword: false }, quotas: [] };
          jsonReply(res, isAdmin ? state : { quotas: state.quotas }); return true;
        }
        if (['/api/cpa-config', '/api/plugins/global', '/api/plugins/install', '/api/plugins/uninstall', '/api/prompt-config', '/api/tools/global'].includes(url.pathname) || (isAdmin && ['/api/plugins', '/api/tools'].includes(url.pathname))) {
          if (!isAdmin) throw httpError(403, '仅超管可修改全局配置');
          if (!['GET', 'POST'].includes(req.method)) throw httpError(405, '请求方法无效');
          if (url.pathname === '/api/cpa-config') {
            if (req.method !== 'POST') throw httpError(405, '请求方法无效');
            if (!cpaQuotaMonitor) throw httpError(503, 'CPA 监控未启动');
            const body = await readBoundedJson(req, 65536);
            const current = cpaQuotaMonitor.getPublicState();
            const password = body?.preservePassword && current.config.hasPassword ? undefined : String(body?.password || '');
            const state = await withModelConfigLock(() => cpaQuotaMonitor.updateConfig({ url: body?.url, password, preservePassword: body?.preservePassword }));
            jsonReply(res, { ok: true, ...state }); return true;
          }
          const admin = await userContext(session.user);
          if (url.pathname === '/api/prompt-config') {
            // Global prompt protocol is independent of the selected owner/session.
            const target = new URL(url);
            for (const key of ['ownerUsername', 'sessionId', 'tabId']) target.searchParams.delete(key);
            req.url = target.pathname + target.search;
            await withModelConfigLock(() => core.handleWebRequest(req, res, admin.router)); return true;
          }
          if (url.pathname.startsWith('/api/plugins')) {
            if (!await withModelConfigLock(() => admin.pluginHost.route(req, res, url, { readJsonBody: readBoundedJson, sendJson: jsonReply }))) throw httpError(405, '请求方法无效');
            return true;
          }
          const repl = await admin.router.get({ tabId: 'global-model-config' });
          if (url.pathname === '/api/tools' && req.method === 'GET') {
            jsonReply(res, repl.globalTools()); return true;
          }
          if (url.pathname !== '/api/tools/global' || req.method !== 'POST') throw httpError(405, '请求方法无效');
          const body = await readBoundedJson(req, 65536);
          const result = await withModelConfigLock(async () => {
            const saved = await repl.setGlobalTools(body?.overrides);
            if (!saved.ok) return saved;
            const contexts = await Promise.all([...users.values()]);
            await Promise.all(contexts.map(user => user.router.reloadGlobalTools(globalTools.globalOverrides())));
            return saved;
          });
          jsonReply(res, result); return true;
        }
        if (url.pathname === '/api/login') {
          if (!isAdmin) throw httpError(403, '仅超管可配置模型');
          if (!['GET', 'POST'].includes(req.method)) throw httpError(405, '请求方法无效');
          const admin = await userContext(session.user);
          const repl = await admin.router.get({ tabId: 'global-model-config' });
          if (req.method === 'GET') {
            const form = await withModelConfigLock(() => repl.loginForm(url.searchParams.get('provider') || undefined));
            jsonReply(res, { ...form, envPath: undefined }); return true;
          }
          const body = await readBoundedJson(req, 64 * 1024);
          if (!body || typeof body.provider !== 'string' || !body.values || typeof body.values !== 'object' || Array.isArray(body.values) || Object.values(body.values).some(value => typeof value !== 'string')) throw httpError(400, '模型配置无效');
          const result = await withModelConfigLock(async () => {
            const saved = await repl.saveLogin(body.provider, body.values);
            if (!saved.ok) return saved;
            const contexts = await Promise.all([...users.values()]);
            await Promise.all(contexts.map(user => user.router.reloadModelConfig()));
            return saved;
          });
          jsonReply(res, result); return true;
        }
        const ownerUsernames = url.searchParams.getAll('ownerUsername');
        if (ownerUsernames.length > 1 || (ownerUsernames.length && !ownerUsernames[0])) throw httpError(400, '用户参数无效');
        let owner = session.user;
        if (ownerUsernames.length) {
          if (!isAdmin) throw httpError(403, '不能访问其他用户');
          owner = allOwners().find(user => user.username === ownerUsernames[0]);
          if (!owner) throw httpError(404, '用户不存在');
        }
        url.searchParams.delete('ownerUsername');
        const user = await userContext(owner);
        for (const name of ['sessionId', 'tabId']) {
          const values = url.searchParams.getAll(name);
          if (values.length > 1 || (values.length && (!values[0] || !SESSION_ID.test(values[0])))) throw httpError(400, '会话参数无效');
        }
        if (url.searchParams.has('sessionId')) await assertOwnedSession(user.sessionsRoot, url.searchParams.get('sessionId'));
        if (!url.searchParams.has('sessionId') && !url.searchParams.has('tabId')) url.searchParams.set('tabId', 'default');
        const scope = user.scopeFor(url);
        if (/^\/api\/(?:prompt-library|prompt-config|session-prompt|app-prompt|login|client-reload|cpa-config|tools\/global)(?:\/|$)/.test(url.pathname)) throw httpError(403, '隔离模式不允许访问此接口');
        if (url.pathname.startsWith('/api/plugins') && url.pathname !== '/api/plugins') throw httpError(403, '全局配置不可修改');
        if (await user.pluginHost.route(req, res, url, { readJsonBody: readBoundedJson, sendJson: jsonReply })) return true;
        if (await user.chunks(req, res, url)) return true;
        if (url.pathname.startsWith('/api/uploads/') && ['GET', 'HEAD'].includes(req.method)) {
          const name = decodeURIComponent(url.pathname.slice('/api/uploads/'.length));
          if (!name || path.basename(name) !== name || name.startsWith('.')) throw httpError(404, '文件不存在');
          await serveFile(req, res, path.join(user.uploadsRoot, name)); return true;
        }
        if (url.pathname.startsWith('/api/local-images/') && req.method === 'GET') {
          const encoded = decodeURIComponent(url.pathname.slice('/api/local-images/'.length));
          const filename = Buffer.from(encoded, 'base64url').toString('utf8');
          await user.checkedWorkspace(filename);
          await serveFile(req, res, filename, true, true); return true;
        }
        if (url.pathname === '/api/uploads' && req.method === 'POST') {
          const body = await readBoundedJson(req, 32 * 1024 * 1024);
          const name = path.basename(String(body.name || '').replace(/\\/g, '/')).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').slice(0, 180);
          if (!name || name === '.' || name === '..' || typeof body.data !== 'string') throw httpError(400, '文件无效');
          const storedName = `${randomUUID()}-${name}`;
          await fs.mkdir(user.uploadsRoot, { recursive: true });
          const buffer = Buffer.from(body.data, 'base64');
          const absolutePath = path.join(user.uploadsRoot, storedName);
          await fs.writeFile(absolutePath, buffer, { flag: 'wx', mode: 0o600 });
          const file = await user.finalize({ id: randomUUID(), name, storedName, size: buffer.length, mimeType: String(body.mimeType || 'application/octet-stream'), absolutePath, relativePath: absolutePath, url: `/api/uploads/${encodeURIComponent(storedName)}` }, url);
          jsonReply(res, { ok: true, file }); return true;
        }
        const imageRoute = /^\/api\/images\/(?:by-id\/[^/]+|[^/]+\/\d+)$/.test(url.pathname);
        const vendorRoute = /^\/vendor\/(marked.esm.js|highlight.min.js|highlight-theme.css)$/.test(url.pathname);
        if (!(req.method === 'GET' && (GET_ROUTES.has(url.pathname) || imageRoute || vendorRoute)) && !(req.method === 'POST' && POST_ROUTES.has(url.pathname))) throw httpError(403, '隔离模式不允许访问此接口');
        let body;
        if (req.method === 'POST') {
          body = await readBoundedJson(req, 32 * 1024 * 1024);
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, '请求无效');
          if (['/api/sessions/resume', '/api/sessions/delete'].includes(url.pathname)) await assertOwnedSession(user.sessionsRoot, body.sessionId);
          if (url.pathname === '/api/submit' || url.pathname === '/api/submit-now') {
            const text = String(body.text || '').trim();
            if (text.startsWith('/') && !SAFE_COMMANDS.has(text.split(/\s/)[0].toLowerCase())) throw httpError(403, '隔离模式不支持此命令');
            for (const attachment of body.attachments || []) if (attachment?.kind === 'file') {
              const filename = path.resolve(String(attachment.absolutePath || ''));
              if (inside(user.uploadsRoot, filename)) {
                const real = await fs.realpath(filename);
                if (!inside(user.uploadsRoot, real)) throw httpError(403, '附件访问被拒绝');
              } else await user.checkedWorkspace(filename);
            }
          }
        }
        if (url.pathname === '/api/cwd' || url.pathname.startsWith('/api/cwd/')) {
          const repl = await user.router.get(scope);
          await workspaceFs.mkdir(user.workRoot, { recursive: true });
          const current = repl.snapshot().cwd;
          const target = path.resolve(current, String(body?.path || url.searchParams.get('path') || current));
          await user.checkedWorkspace(target, true);
          if (body) body.path = target; else url.searchParams.set('path', target);
        }
        let request = req;
        if (body !== undefined) {
          request = Readable.from([Buffer.from(JSON.stringify(body))]);
          Object.assign(request, { method: req.method, headers: req.headers, socket: req.socket });
        }
        request.url = url.pathname + url.search;
        if (url.pathname === '/events') {
          await user.router.get(scope);
          if (!auth.track(session, res)) return true;
        }
        await core.handleWebRequest(request, res, user.router);
        return true;
      } catch (error) {
        if (res.headersSent) { res.end(); return true; }
        const status = error.status || (error.code === 'ENOENT' ? 404 : 500);
        jsonReply(res, { error: status === 500 ? '请求处理失败' : error.message }, status);
        return true;
      }
    },
  };
}

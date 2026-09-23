function normalizePlugin(plugin) {
  if (!plugin || typeof plugin !== 'object') throw new Error('web plugin resource must be an object');
  const id = String(plugin.id || '').trim();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) throw new Error(`invalid web plugin id: ${id || '(empty)'}`);
  if (!String(plugin.name || '').trim()) throw new Error(`web plugin ${id} is missing name`);
  if (!String(plugin.version || '').trim()) throw new Error(`web plugin ${id} is missing version`);
  for (const key of ['route', 'presentToolResult', 'dispose']) {
    if (plugin[key] !== undefined && typeof plugin[key] !== 'function') throw new Error(`web plugin ${id} ${key} must be a function`);
  }
  return { ...plugin, id, name: String(plugin.name).trim(), version: String(plugin.version).trim(),
    defaultEnabled: plugin.defaultEnabled !== false,
    tools: Array.isArray(plugin.tools) ? plugin.tools : [],
    promptSections: Array.isArray(plugin.promptSections) ? plugin.promptSections : [] };
}

/** Owns instances, not plugin-specific routes or storage. Published catalogs change synchronously. */
export function createWebPluginHost(options = {}) {
  let catalog = [];
  let revision = 0;
  const entries = new Map();
  const reserved = new Map();
  const retired = new Set();
  let enabledSetting = options.enabled;
  let mutation = Promise.resolve();
  const report = error => (options.onError || console.error)(error);

  function enabledIds() {
    // Shared settings make global switches immediately visible to isolated user hosts too.
    const configured = options.locked ? enabledSetting : options.settings?.globalEnabledIds() ?? enabledSetting;
    const value = Array.isArray(configured) ? configured.filter(id => catalog.some(p => p.id === id)) : configured;
    return resolveEnabledPluginIds(catalog, value);
  }
  function active() { const ids = enabledIds(); return catalog.filter(p => ids.has(p.id)); }
  function validate(plugins) {
    const next = plugins.map(normalizePlugin).sort((a, b) => a.id.localeCompare(b.id));
    if (new Set(next.map(p => p.id)).size !== next.length) throw new Error('duplicate web plugin id');
    const names = new Set();
    for (const plugin of next) for (const tool of plugin.tools) {
      for (const name of [tool.name, ...(tool.aliases || [])]) {
        if (names.has(name)) throw new Error(`duplicate tool name or alias across web plugins: ${name}`);
        if (reserved.has(name)) throw new Error(`plugin tool conflicts with host tool: ${name}`);
        names.add(name);
      }
    }
    return next;
  }
  function drain(entry) {
    if (!entry.retired || entry.leases || entry.disposal) return;
    entry.disposal = Promise.resolve().then(() => entry.plugin.dispose?.()).catch(report).finally(() => {
      retired.delete(entry);
      entry.finish();
    });
  }
  function lease(plugins) {
    const owned = plugins.map(p => entries.get(p.id));
    for (const entry of owned) entry.leases++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const entry of owned) { entry.leases--; drain(entry); }
    };
  }
  function publish(next) {
    const waits = [];
    for (const [id, entry] of entries) {
      if (next.some(p => p.plugin.id === id && p.source === entry.source)) continue;
      entries.delete(id);
      entry.retired = true;
      retired.add(entry);
      waits.push(entry.drained);
      drain(entry);
    }
    catalog = next.map(({ source, plugin }) => {
      if (!entries.has(plugin.id)) {
        let finish;
        const drained = new Promise(resolve => { finish = resolve; });
        entries.set(plugin.id, { source, plugin, leases: 0, retired: false, drained, finish });
      }
      return entries.get(plugin.id).plugin;
    });
    revision++;
    return Promise.all(waits);
  }
  const initial = options.plugins || [];
  // Explicit startup configuration is strict; persisted removed ids are filtered when resolving.
  if (typeof enabledSetting === 'string') resolveEnabledPluginIds(initial, enabledSetting);
  const normalized = validate(initial);
  publish(normalized.map(plugin => ({ plugin, source: initial.find(p => p.id === plugin.id) })));

  function definitions() {
    const enabled = enabledIds();
    return catalog.map(plugin => ({ id: plugin.id, name: plugin.name, version: plugin.version,
      globallyEnabled: enabled.has(plugin.id), tools: plugin.tools, promptSections: plugin.promptSections,
      presentToolResult: plugin.presentToolResult }));
  }
  const host = {
    get ids() { return active().map(p => p.id); },
    get tools() { return active().flatMap(p => p.tools); },
    get promptSections() { return active().flatMap(p => p.promptSections); },
    /** Validate before any persistent commit; publication itself cannot fail. */
    prepare(plugins) {
      const normalized = validate(plugins);
      const next = normalized.map(plugin => ({ plugin, source: plugins.find(p => p.id === plugin.id) }));
      return () => publish(next);
    },
    reserveToolNames(names) {
      const own = new Set(catalog.flatMap(p => p.tools.flatMap(t => [t.name, ...(t.aliases || [])])));
      for (const name of names) if (own.has(name)) throw new Error(`plugin tool conflicts with host tool: ${name}`);
      for (const name of names) reserved.set(name, true);
    },
    runtimePlugins(sessionId) {
      return {
        externalPlugins: definitions(),
        resolveExternalPlugins: definitions,
        reservePluginToolNames: names => host.reserveToolNames(names),
        acquirePluginSnapshot(overrides = {}) {
          const enabled = active().filter(p => overrides[p.id] !== false);
          return { plugins: definitions(), release: lease(enabled) };
        },
        sessionPluginOverrides: options.settings?.sessionOverrides(sessionId) || {},
        persistSessionPluginOverrides: (id, next) => options.settings?.setSessionOverrides(id, next),
        resolveSessionPluginOverrides: id => options.settings?.sessionOverrides(id) || {},
      };
    },
    snapshot() {
      const enabled = enabledIds();
      return { revision, items: catalog.map(p => ({ id: p.id, name: p.name, version: p.version,
        enabled: enabled.has(p.id), configuredEnabled: enabled.has(p.id), tools: p.tools.map(t => t.name) })),
        restartRequired: false, locked: options.locked === true, installationSupported: Boolean(options.management) };
    },
    async route(req, res, url, helpers = {}) {
      if (req.method === 'GET' && url.pathname === '/api/plugins') {
        helpers.sendJson?.(res, host.snapshot()); return true;
      }
      if (req.method === 'POST' && ['/api/plugins/global', '/api/plugins/install', '/api/plugins/uninstall'].includes(url.pathname)) {
        const origin = req.headers?.origin;
        if (req.headers?.['sec-fetch-site'] === 'cross-site' || (origin && !sameHostOrigin(origin, req.headers?.host))) {
          helpers.sendJson?.(res, { errorCode: 'PLUGIN_ORIGIN_DENIED', error: 'cross-origin plugin management is not allowed' }, 403); return true;
        }
        if (options.locked) {
          helpers.sendJson?.(res, { errorCode: 'PLUGINS_LOCKED', error: 'plugins are locked by NEO_WEB_PLUGINS' }, 409); return true;
        }
        const body = await helpers.readJsonBody?.(req);
        const operation = mutation.catch(() => {}).then(async () => {
          if (url.pathname !== '/api/plugins/global') {
            if (!options.management) throw new Error('plugin installation is not configured');
            if (url.pathname.endsWith('/install')) await options.management.install(body?.directory);
            else await options.management.uninstall(body?.id);
          } else {
            if (!Array.isArray(body?.enabledIds)) throw new Error('enabledIds must be an array');
            const requested = [...resolveEnabledPluginIds(catalog, body.enabledIds)];
            await options.settings?.setGlobalEnabled(requested);
            enabledSetting = requested;
            revision++;
          }
          return { ok: true, enabledIds: host.ids, ...host.snapshot() };
        });
        mutation = operation;
        try { helpers.sendJson?.(res, await operation); }
        catch (error) { helpers.sendJson?.(res, { errorCode: 'PLUGIN_UPDATE_FAILED', error: error.message || String(error) }, 400); }
        return true;
      }
      // Hold a lease through response finish/close, not merely through the route promise (streams).
      for (const plugin of active()) {
        if (entries.get(plugin.id)?.plugin !== plugin || !enabledIds().has(plugin.id) || typeof plugin.route !== 'function') continue;
        const release = lease([plugin]);
        let routeDone = false, responseDone = false, handled = false;
        const finish = () => { responseDone = true; if (routeDone) release(); };
        res.once?.('finish', finish); res.once?.('close', finish);
        try { handled = await plugin.route(req, res, url, helpers); }
        finally {
          routeDone = true;
          if (!handled || responseDone || res.writableFinished || res.destroyed || !res.once) {
            res.off?.('finish', finish); res.off?.('close', finish); release();
          }
        }
        if (handled) return true;
      }
      return false;
    },
  };
  return host;
}

function sameHostOrigin(origin, host) {
  try { const url = new URL(origin); return ['http:', 'https:'].includes(url.protocol) && url.host === host; }
  catch { return false; }
}

export function resolveEnabledPluginIds(catalog, configured) {
  const available = new Set(catalog.map(plugin => plugin.id));
  if (Array.isArray(configured)) {
    const requested = configured.map(String);
    const unknown = requested.filter(id => !available.has(id));
    if (unknown.length) throw new Error(`unknown web plugin: ${unknown.join(', ')}`);
    return new Set(requested);
  }
  const raw = configured === undefined || configured === null ? '' : String(configured).trim();
  if (!raw) return new Set(catalog.filter(plugin => plugin.defaultEnabled !== false).map(plugin => plugin.id));
  if (raw.toLowerCase() === 'none') return new Set();
  if (raw.toLowerCase() === 'all') return available;
  return resolveEnabledPluginIds(catalog, raw.split(',').map(id => id.trim()).filter(Boolean));
}

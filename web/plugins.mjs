function normalizePlugin(plugin) {
  if (!plugin || typeof plugin !== 'object') throw new Error('web plugin must be an object');
  const id = String(plugin.id || '').trim();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) throw new Error(`invalid web plugin id: ${id || '(empty)'}`);
  return {
    ...plugin,
    id,
    name: String(plugin.name || id).trim() || id,
    version: String(plugin.version || '0.0.0').trim() || '0.0.0',
    tools: Array.isArray(plugin.tools) ? plugin.tools : [],
    promptSections: Array.isArray(plugin.promptSections) ? plugin.promptSections : [],
  };
}

export function createWebPluginHost(options = {}) {
  const catalog = (options.plugins || []).map(normalizePlugin).sort((left, right) => left.id.localeCompare(right.id));
  const ids = catalog.map((plugin) => plugin.id);
  if (new Set(ids).size !== ids.length) throw new Error('duplicate web plugin id');
  const enabledIds = resolveEnabledPluginIds(catalog, options.enabled);
  const enabled = catalog.filter((plugin) => enabledIds.has(plugin.id));
  const tools = enabled.flatMap((plugin) => plugin.tools);
  const toolNames = tools.map((tool) => String(tool?.name || '').trim()).filter(Boolean);
  if (new Set(toolNames).size !== toolNames.length) throw new Error('duplicate tool name across enabled web plugins');

  return {
    ids: enabled.map((plugin) => plugin.id),
    tools,
    promptSections: enabled.flatMap((plugin) => plugin.promptSections),
    snapshot() {
      return {
        items: catalog.map((plugin) => ({
          id: plugin.id,
          name: plugin.name,
          version: plugin.version,
          enabled: enabledIds.has(plugin.id),
          tools: plugin.tools.map((tool) => tool.name),
        })),
        restartRequired: true,
      };
    },
    async route(req, res, url, helpers = {}) {
      if (req.method === 'GET' && url.pathname === '/api/plugins') {
        helpers.sendJson?.(res, this.snapshot());
        return true;
      }
      for (const plugin of enabled) {
        if (typeof plugin.route === 'function' && await plugin.route(req, res, url, helpers)) return true;
      }
      return false;
    },
  };
}

export function resolveEnabledPluginIds(catalog, configured) {
  const available = new Set(catalog.map((plugin) => plugin.id));
  const raw = configured === undefined || configured === null ? '' : String(configured).trim();
  if (!raw) return new Set(catalog.filter((plugin) => plugin.defaultEnabled !== false).map((plugin) => plugin.id));
  if (raw.toLowerCase() === 'none') return new Set();
  if (raw.toLowerCase() === 'all') return available;
  const requested = raw.split(',').map((id) => id.trim()).filter(Boolean);
  const unknown = requested.filter((id) => !available.has(id));
  if (unknown.length) throw new Error(`unknown web plugin: ${unknown.join(', ')}`);
  return new Set(requested);
}

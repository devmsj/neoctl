import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createWebPluginHost } from './plugins.mjs';

/** Trusted local plugin packages only. Code is copied to immutable, unique module URLs. */
export async function createPluginManager({ directory, builtInDirectory, loadPlugins, onError = console.error }) {
  const root = path.resolve(directory);
  const indexFile = path.join(root, 'catalog.json');
  await fs.mkdir(root, { recursive: true });
  let state;
  try { state = JSON.parse(await fs.readFile(indexFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; state = { installed: {}, removed: [] }; }
  if (!state || !state.installed || !Array.isArray(state.removed)) throw new Error('invalid plugin catalog');
  const builtins = new Map();
  const builtInEntries = await fs.readdir(builtInDirectory, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of builtInEntries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(builtInDirectory, entry.name);
    try { const manifest = JSON.parse(await fs.readFile(path.join(dir, 'neo-plugin.json'), 'utf8')); builtins.set(manifest.id, dir); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const hosts = new Set();
  let queue = Promise.resolve();
  const serial = operation => { const result = queue.catch(() => {}).then(operation); queue = result; return result; };
  function sources(value) {
    const result = new Map([...builtins].filter(([id]) => !value.removed.includes(id)));
    for (const [id, folder] of Object.entries(value.installed)) {
      if (!/^[a-f0-9-]{36}$/.test(folder)) throw new Error('invalid installed plugin directory');
      result.set(id, path.join(root, folder));
    }
    return result;
  }
  async function persist(next) {
    const temp = `${indexFile}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temp, JSON.stringify(next, null, 2) + '\n'); await fs.rename(temp, indexFile); }
    finally { await fs.rm(temp, { force: true }); }
  }
  async function load(source, context) {
    const plugins = await loadPlugins({ directories: [], pluginDirectories: [source], ...context });
    if (plugins.length !== 1) throw new Error('package must contain exactly one neo-plugin.json at its root');
    return plugins[0];
  }
  async function publish(next) {
    const nextSources = sources(next), prepared = [], created = [];
    try {
      for (const entry of hosts) {
        const plugins = new Map();
        for (const [id, source] of nextSources) {
          let plugin = entry.plugins.get(id);
          if (!plugin || plugin.sourceDir !== source) { plugin = await load(source, entry.context); created.push(plugin); }
          if (plugin.id !== id) throw new Error(`plugin id mismatch: ${id}`);
          plugins.set(id, plugin);
        }
        prepared.push({ entry, plugins, commit: entry.host.prepare([...plugins.values()]) });
      }
      await persist(next);
    } catch (error) {
      await Promise.allSettled(created.map(p => Promise.resolve().then(() => p.dispose?.())));
      throw error;
    }
    const previous = state;
    state = next;
    const drains = prepared.map(({ entry, plugins, commit }) => { entry.plugins = plugins; return commit(); });
    // Never wait for an active model turn in a management request. Logical removal is complete.
    void Promise.all(drains).then(async () => {
      const retained = new Set(Object.values(next.installed));
      for (const folder of Object.values(previous.installed)) {
        if (!retained.has(folder)) await fs.rm(path.join(root, folder), { recursive: true, force: true });
      }
    }).catch(onError);
  }
  const manager = {
    createHost(options = {}, context = {}) {
      return serial(async () => {
        const plugins = new Map();
        try {
          for (const [id, source] of sources(state)) plugins.set(id, await load(source, context));
          const host = createWebPluginHost({ ...options, plugins: [...plugins.values()], management: manager, onError });
          hosts.add({ host, plugins, context });
          return host;
        } catch (error) {
          await Promise.allSettled([...plugins.values()].map(p => Promise.resolve().then(() => p.dispose?.())));
          throw error;
        }
      });
    },
    install(directory) {
      return serial(async () => {
        if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('install requires an absolute trusted local package directory');
        const source = await fs.realpath(directory);
        const relative = path.relative(source, root);
        if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('package cannot contain the plugin installation store');
        const folder = randomUUID(), target = path.join(root, folder);
        try {
          await fs.cp(source, target, { recursive: true, filter: async file => {
            const stat = await fs.lstat(file);
            if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error('plugin packages must contain only regular files and directories, no links');
            return true;
          } });
          const manifest = JSON.parse(await fs.readFile(path.join(target, 'neo-plugin.json'), 'utf8'));
          if (!/^[a-z0-9][a-z0-9._-]*$/.test(manifest.id || '')) throw new Error('invalid plugin id');
          if (!hosts.size) throw new Error('no plugin host is available to validate the package');
          await publish({ installed: { ...state.installed, [manifest.id]: folder }, removed: state.removed.filter(id => id !== manifest.id) });
        } catch (error) { await fs.rm(target, { recursive: true, force: true }); throw error; }
      });
    },
    uninstall(id) {
      return serial(async () => {
        if (typeof id !== 'string' || !sources(state).has(id)) throw new Error(`unknown plugin: ${id}`);
        const installed = { ...state.installed }; delete installed[id];
        await publish({ installed, removed: [...new Set([...state.removed, id])] });
      });
    },
  };
  return manager;
}

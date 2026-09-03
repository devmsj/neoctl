import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const webRoot = path.dirname(fileURLToPath(import.meta.url));
const source = resolveCoreSource();
const localEngineRoot = path.resolve(webRoot, '..', 'engine');
const coreSpecifier = source === 'local'
  ? pathToFileURL(path.join(localEngineRoot, 'dist', 'index.js')).href
  : 'neoctl';
const webSpecifier = source === 'local'
  ? pathToFileURL(path.join(localEngineRoot, 'dist', 'web', 'index.js')).href
  : 'neoctl/web/index.js';

const [coreModule, webModule] = await Promise.all([
  importCore(coreSpecifier),
  importCore(webSpecifier),
]);

export const QueryEngine = coreModule.QueryEngine;
export const loadNeoPlugins = coreModule.loadNeoPlugins;
export const WebRepl = webModule.WebRepl;
export const WebRuntimeRouter = webModule.WebRuntimeRouter;
export const createWebRuntime = webModule.createWebRuntime;
export const runWebServer = webModule.runWebServer;
export const coreRuntimeInfo = Object.freeze({
  source,
  version: await readCoreVersion(),
  location: source === 'local' ? localEngineRoot : 'neoctl',
});

function resolveCoreSource() {
  const argumentIndex = process.argv.indexOf('--core');
  const argument = argumentIndex >= 0 ? process.argv[argumentIndex + 1] : undefined;
  const value = String(argument || process.env.NEO_CORE_SOURCE || 'package').trim().toLowerCase();
  if (value === 'local' || value === 'package') return value;
  throw new Error(`Invalid Core source: ${value}. Use local or package.`);
}

async function importCore(specifier) {
  try {
    return await import(specifier);
  } catch (error) {
    if (source !== 'local') throw error;
    throw new Error('Local Engine is not built. Run npm --prefix ../engine run build first.', { cause: error });
  }
}

async function readCoreVersion() {
  const packageFile = source === 'local'
    ? path.join(localEngineRoot, 'package.json')
    : path.join(webRoot, 'node_modules', 'neoctl', 'package.json');
  const value = JSON.parse(await readFile(packageFile, 'utf8'));
  return String(value.version || 'unknown');
}

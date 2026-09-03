import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import type { PromptSection } from "../context/prompts.js";
import type { Tool } from "../tools/tool.js";

export const NEO_PLUGIN_PROTOCOL = "neo-plugin/v1";
export const NEO_PLUGIN_MANIFEST = "neo-plugin.json";

export interface NeoPluginManifest {
  protocol: typeof NEO_PLUGIN_PROTOCOL;
  id: string;
  name: string;
  version: string;
  entry: string;
  defaultEnabled?: boolean;
  description?: string;
}

export interface NeoPluginFactoryContext {
  manifest: Readonly<NeoPluginManifest>;
  pluginDir: string;
  appDataDir?: string;
  env: Readonly<Record<string, string | undefined>>;
}

export interface NeoPluginRouteHelpers {
  readJsonBody?: (request: IncomingMessage) => Promise<unknown>;
  sendJson?: (response: ServerResponse, payload: unknown, status?: number) => unknown;
}

export interface NeoPluginCapabilities {
  tools?: readonly Tool[];
  promptSections?: readonly PromptSection[];
  route?: (
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    helpers: NeoPluginRouteHelpers,
  ) => boolean | Promise<boolean>;
}

export interface NeoPluginResource {
  id: string;
  name: string;
  version: string;
  description?: string;
  defaultEnabled: boolean;
  sourceDir: string;
  manifestPath: string;
  tools: readonly Tool[];
  promptSections: readonly PromptSection[];
  route?: NeoPluginCapabilities["route"];
}

export type NeoPluginFactory = (
  context: NeoPluginFactoryContext,
) => NeoPluginCapabilities | Promise<NeoPluginCapabilities>;

export interface LoadNeoPluginsOptions {
  /** One or more directories whose direct children are plugin resource directories. */
  directories: string | readonly string[];
  /** Generic application data directory exposed to plugin factories. */
  appDataDir?: string;
  /** Environment made available to plugin factories. Defaults to process.env. */
  env?: Readonly<Record<string, string | undefined>>;
}

export async function loadNeoPlugins(options: LoadNeoPluginsOptions): Promise<NeoPluginResource[]> {
  const roots = normalizeRoots(options.directories);
  const plugins: NeoPluginResource[] = [];
  for (const root of roots) plugins.push(...await loadPluginRoot(root, options));
  plugins.sort((left, right) => left.id.localeCompare(right.id));
  assertUnique(plugins.map((plugin) => plugin.id), "duplicate plugin id");
  assertUnique(
    plugins.flatMap((plugin) => plugin.tools ?? []).map((tool) => tool.name),
    "duplicate tool name across plugins",
  );
  return plugins;
}

export function validateNeoPluginManifest(value: unknown, manifestPath = NEO_PLUGIN_MANIFEST): NeoPluginManifest {
  if (!isRecord(value)) throw new Error(`invalid plugin manifest ${manifestPath}: expected an object`);
  if (value.protocol !== NEO_PLUGIN_PROTOCOL) {
    throw new Error(`invalid plugin manifest ${manifestPath}: protocol must be ${NEO_PLUGIN_PROTOCOL}`);
  }
  const id = requireText(value.id, "id", manifestPath);
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(id)) {
    throw new Error(`invalid plugin manifest ${manifestPath}: invalid id ${id}`);
  }
  const entry = requireText(value.entry, "entry", manifestPath);
  if (path.isAbsolute(entry)) throw new Error(`invalid plugin manifest ${manifestPath}: entry must be relative`);
  return {
    protocol: NEO_PLUGIN_PROTOCOL,
    id,
    name: requireText(value.name, "name", manifestPath),
    version: requireText(value.version, "version", manifestPath),
    entry,
    ...(typeof value.defaultEnabled === "boolean" ? { defaultEnabled: value.defaultEnabled } : {}),
    ...(typeof value.description === "string" && value.description.trim() ? { description: value.description.trim() } : {}),
  };
}

async function loadPluginRoot(root: string, options: LoadNeoPluginsOptions): Promise<NeoPluginResource[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
  const directories = entries.filter((entry) => entry.isDirectory()).sort((left, right) => left.name.localeCompare(right.name));
  const plugins: NeoPluginResource[] = [];
  for (const entry of directories) {
    const pluginDir = path.resolve(root, entry.name);
    const manifestPath = path.join(pluginDir, NEO_PLUGIN_MANIFEST);
    let rawManifest: string;
    try {
      rawManifest = await readFile(manifestPath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") continue;
      throw error;
    }
    let parsedManifest: unknown;
    try {
      parsedManifest = JSON.parse(rawManifest);
    } catch (error) {
      throw new Error(`invalid plugin manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    const manifest = validateNeoPluginManifest(parsedManifest, manifestPath);
    const entryPath = resolveContainedEntry(pluginDir, manifest.entry, manifestPath);
    const module = await import(pathToFileURL(entryPath).href);
    const factory = module.createPlugin ?? module.default;
    if (typeof factory !== "function") {
      throw new Error(`invalid plugin module ${entryPath}: export createPlugin(context) or a default factory`);
    }
    const context: NeoPluginFactoryContext = Object.freeze({
      manifest: Object.freeze({ ...manifest }),
      pluginDir,
      ...(options.appDataDir ? { appDataDir: path.resolve(options.appDataDir) } : {}),
      env: Object.freeze({ ...(options.env ?? process.env) }),
    });
    const capabilities = normalizeCapabilities(await (factory as NeoPluginFactory)(context), entryPath);
    plugins.push({
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      defaultEnabled: manifest.defaultEnabled !== false,
      sourceDir: pluginDir,
      manifestPath,
      ...capabilities,
    });
  }
  return plugins;
}

function normalizeCapabilities(value: unknown, entryPath: string): Pick<NeoPluginResource, "tools" | "promptSections" | "route"> {
  if (!isRecord(value)) throw new Error(`invalid plugin module ${entryPath}: factory must return an object`);
  const tools = value.tools === undefined ? [] : requireArray<unknown>(value.tools, "tools", entryPath);
  const promptSections = value.promptSections === undefined ? [] : requireArray<unknown>(value.promptSections, "promptSections", entryPath);
  for (const [index, tool] of tools.entries()) validateTool(tool, index, entryPath);
  for (const [index, section] of promptSections.entries()) validatePromptSection(section, index, entryPath);
  if (value.route !== undefined && typeof value.route !== "function") {
    throw new Error(`invalid plugin module ${entryPath}: route must be a function`);
  }
  const normalizedTools = tools as Tool[];
  const normalizedSections = promptSections as PromptSection[];
  assertUnique(normalizedTools.map((tool) => tool.name), `duplicate tool name in plugin module ${entryPath}`);
  return {
    tools: [...normalizedTools],
    promptSections: normalizedSections.map((section) => ({ ...section })),
    ...(typeof value.route === "function" ? { route: value.route as NeoPluginCapabilities["route"] } : {}),
  };
}

function validateTool(value: unknown, index: number, entryPath: string): asserts value is Tool {
  if (!isRecord(value)) throw new Error(`invalid plugin module ${entryPath}: tools[${index}] must be an object`);
  if (!requireOptionalText(value.name)) throw new Error(`invalid plugin module ${entryPath}: tools[${index}].name is required`);
  if (!(typeof value.description === "string" || typeof value.description === "function")) {
    throw new Error(`invalid plugin module ${entryPath}: tools[${index}].description is required`);
  }
  if (!isRecord(value.inputSchema)) throw new Error(`invalid plugin module ${entryPath}: tools[${index}].inputSchema is required`);
  if (!isRecord(value.metadata)) throw new Error(`invalid plugin module ${entryPath}: tools[${index}].metadata is required`);
  if (typeof value.execute !== "function" && typeof value.call !== "function") {
    throw new Error(`invalid plugin module ${entryPath}: tools[${index}] must implement execute or call`);
  }
}

function validatePromptSection(value: unknown, index: number, entryPath: string): asserts value is PromptSection {
  if (!isRecord(value) || !requireOptionalText(value.name) || typeof value.content !== "string") {
    throw new Error(`invalid plugin module ${entryPath}: promptSections[${index}] must contain name and content`);
  }
  if (value.cacheStable !== undefined && typeof value.cacheStable !== "boolean") {
    throw new Error(`invalid plugin module ${entryPath}: promptSections[${index}].cacheStable must be boolean`);
  }
}

function resolveContainedEntry(pluginDir: string, entry: string, manifestPath: string): string {
  const resolved = path.resolve(pluginDir, entry);
  const relative = path.relative(pluginDir, resolved);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`invalid plugin manifest ${manifestPath}: entry must resolve inside the plugin directory`);
  }
  return resolved;
}

function normalizeRoots(value: string | readonly string[]): string[] {
  const roots = (Array.isArray(value) ? value : [value])
    .map((root) => String(root || "").trim())
    .filter(Boolean)
    .map((root) => path.resolve(root));
  return [...new Set(roots)];
}

function requireText(value: unknown, field: string, manifestPath: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`invalid plugin manifest ${manifestPath}: ${field} is required`);
  return text;
}

function requireArray<T>(value: unknown, field: string, entryPath: string): T[] {
  if (!Array.isArray(value)) throw new Error(`invalid plugin module ${entryPath}: ${field} must be an array`);
  return value as T[];
}

function requireOptionalText(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}

function assertUnique(values: readonly string[], message: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`${message}: ${value}`);
    seen.add(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

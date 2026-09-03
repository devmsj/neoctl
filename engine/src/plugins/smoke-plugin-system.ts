import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadNeoPlugins, NEO_PLUGIN_PROTOCOL, validateNeoPluginManifest } from "./plugin-system.js";

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "neo-plugin-smoke-"));
  const dataDir = path.join(root, "data");
  try {
    await createPlugin(root, "beta", false, "beta_tool");
    await createPlugin(root, "alpha", true, "alpha_tool");
    await mkdir(path.join(root, "not-a-plugin"), { recursive: true });

    const plugins = await loadNeoPlugins({
      directories: root,
      appDataDir: dataDir,
      env: { SMOKE_VALUE: "available" },
    });
    assert.deepEqual(plugins.map((plugin) => plugin.id), ["alpha", "beta"]);
    assert.deepEqual(plugins.map((plugin) => plugin.defaultEnabled), [true, false]);
    assert.deepEqual(plugins.flatMap((plugin) => plugin.tools.map((tool) => tool.name)), ["alpha_tool", "beta_tool"]);
    assert.equal(plugins[0]?.promptSections[0]?.content, `available:${path.resolve(dataDir)}`);
    assert.equal(await plugins[0]?.route?.({ method: "GET" } as never, {} as never, new URL("http://localhost/alpha"), {}), true);
    assert.throws(
      () => validateNeoPluginManifest({ protocol: "other", id: "bad", name: "Bad", version: "1", entry: "index.mjs" }),
      /protocol must be neo-plugin\/v1/,
    );

    const missing = await loadNeoPlugins({ directories: path.join(root, "missing") });
    assert.deepEqual(missing, []);

    console.log(JSON.stringify({ ok: true, protocol: NEO_PLUGIN_PROTOCOL, plugins: plugins.map((plugin) => plugin.id) }, null, 2));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function createPlugin(root: string, id: string, defaultEnabled: boolean, toolName: string): Promise<void> {
  const pluginDir = path.join(root, id);
  await mkdir(pluginDir, { recursive: true });
  await writeFile(path.join(pluginDir, "neo-plugin.json"), JSON.stringify({
    protocol: NEO_PLUGIN_PROTOCOL,
    id,
    name: id.toUpperCase(),
    version: "1.0.0",
    entry: "index.mjs",
    defaultEnabled,
  }, null, 2));
  await writeFile(path.join(pluginDir, "index.mjs"), `
export function createPlugin(context) {
  return {
    tools: [{
      name: ${JSON.stringify(toolName)},
      description: "smoke tool",
      inputSchema: { type: "object" },
      metadata: { readOnly: true, concurrent: true, visible: true },
      async execute() { return { ok: true, output: context.manifest.id }; },
    }],
    promptSections: [{ name: "Smoke", content: context.env.SMOKE_VALUE + ":" + context.appDataDir, cacheStable: true }],
    route(request, response, url) { return url.pathname === "/" + context.manifest.id; },
  };
}
`, "utf8");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

#!/usr/bin/env node
// Fail closed if the repository, npm latest tags or published dependency disagree.
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const npm = process.env.npm_execpath;
function view(spec, field) {
  const args = ['view', spec, field, '--json', '--registry=https://registry.npmjs.org', '--prefer-online'];
  const text = npm ? execFileSync(process.execPath, [npm, ...args], { encoding: 'utf8', windowsHide: true })
    : execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `npm ${args.join(' ')}`], { encoding: 'utf8', windowsHide: true });
  return JSON.parse(text);
}
export async function verifyReleaseVersions() {
  const core = JSON.parse(await readFile(path.join(root, 'engine/package.json'), 'utf8'));
  const web = JSON.parse(await readFile(path.join(root, 'web/package.json'), 'utf8'));
  const shell = JSON.parse(await readFile(path.join(root, 'desktop/package.json'), 'utf8'));
  const latestCore = view('neoctl', 'dist-tags.latest');
  const latestWeb = view('neoctl-web', 'dist-tags.latest');
  if (latestCore !== core.version || latestWeb !== web.version) throw new Error(`npm latest mismatch: expected Web ${web.version}/Core ${core.version}, registry Web ${latestWeb}/Core ${latestCore}`);
  const requirement = view(`neoctl-web@${web.version}`, 'dependencies.neoctl');
  if (requirement !== core.version || web.dependencies.neoctl !== core.version) throw new Error('Release Web must pin the exact latest Core version');
  const versions = { schema: 1, desktop: shell.version, web: web.version, core: core.version, registry: 'https://registry.npmjs.org', verifiedAt: new Date().toISOString() };
  console.log(`[release] verified Desktop ${versions.desktop}, Web ${versions.web}, Core ${versions.core}`);
  return versions;
}
if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  const versions = await verifyReleaseVersions();
  if (process.argv[2]) await writeFile(process.argv[2], `${JSON.stringify(versions, null, 2)}\n`);
}

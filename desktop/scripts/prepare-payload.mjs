#!/usr/bin/env node
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyReleaseVersions } from './verify-release-versions.mjs';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(desktopRoot, '..');
const webRoot = path.join(repoRoot, 'web');
const payloadDir = path.join(desktopRoot, 'resources', 'payload');
const output = path.join(payloadDir, 'neoctl-web.tgz');

await mkdir(payloadDir, { recursive: true });
const packageJson = JSON.parse(await readFile(path.join(webRoot, 'package.json'), 'utf8'));
const published = process.env.NEO_RELEASE_PAYLOAD === 'registry';
if (published) await verifyReleaseVersions();
console.log(`[payload] ${published ? 'fetching published' : 'building'} ${packageJson.name}@${packageJson.version}`);
const filename = await npmPack(webRoot, published ? `neoctl-web@${packageJson.version}` : '');
await rm(output, { force: true });
await copyFile(path.join(webRoot, filename), output);
await rm(path.join(webRoot, filename), { force: true });
await writeFile(path.join(payloadDir, 'payload-manifest.json'), `${JSON.stringify({
  schema: 1,
  name: packageJson.name,
  version: packageJson.version,
  core: packageJson.dependencies?.neoctl || null,
  filename: 'neoctl-web.tgz',
  builtAt: new Date().toISOString(),
}, null, 2)}\n`, 'utf8');
console.log(`[payload] wrote ${path.relative(desktopRoot, output)}`);

function npmPack(cwd, specifier) {
  if (specifier && !/^neoctl-web@\d+\.\d+\.\d+$/.test(specifier)) throw new Error('invalid release version');
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `npm pack ${specifier} --json --registry=https://registry.npmjs.org`], { cwd, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0) return reject(new Error(`npm pack failed with exit code ${code}`));
      const filenames = [...stdout.matchAll(/"filename"\s*:\s*"([^"]+\.tgz)"/g)];
      const filename = filenames.at(-1)?.[1];
      if (!filename) return reject(new Error(`unable to find npm pack filename in output:\n${stdout}`));
      resolve(filename);
    });
  });
}

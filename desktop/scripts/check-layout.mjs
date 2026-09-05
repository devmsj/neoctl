#!/usr/bin/env node
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const required = [
  'ui/index.html', 'ui/app.js', 'ui/styles.css',
  'src-tauri/Cargo.toml', 'src-tauri/tauri.conf.json', 'src-tauri/src/lib.rs',
  'resources/payload/neoctl-web.tgz', 'resources/payload/payload-manifest.json',
];
for (const file of required) await access(path.join(root, file));
const config = JSON.parse(await readFile(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
if (config.build.frontendDist !== '../ui') throw new Error('unexpected frontendDist');
console.log(`[check] desktop layout valid (${required.length} required files)`);

#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = process.env.CARGO_TARGET_DIR ? path.resolve(root, process.env.CARGO_TARGET_DIR) : path.join(root, 'src-tauri/target');
const result = spawnSync('cargo', ['build', '--manifest-path', 'src-tauri/Cargo.toml', '--bin', 'neoctl-updater', '--release', '--locked'], { cwd: root, stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
const output = path.join(root, 'resources/updater');
mkdirSync(output, { recursive: true });
copyFileSync(path.join(target, 'release/neoctl-updater.exe'), path.join(output, 'neoctl-updater.exe'));
console.log('[updater] independent updater prepared');

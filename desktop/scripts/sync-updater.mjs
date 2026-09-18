#!/usr/bin/env node
// Tauri may rebuild all workspace binaries with its release feature set.
// Run after compilation, immediately before bundling, not before tauri build.
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = process.env.CARGO_TARGET_DIR ? path.resolve(root, process.env.CARGO_TARGET_DIR) : path.join(root, 'src-tauri/target');
const source = path.join(target, 'release/neoctl-updater.exe');
const destination = path.join(root, 'resources/updater/neoctl-updater.exe');
mkdirSync(path.dirname(destination), { recursive: true });
copyFileSync(source, destination);
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
if (hash(source) !== hash(destination)) throw new Error('Updater resource copy failed verification');
console.log('[updater] synchronized final release binary for bundling');

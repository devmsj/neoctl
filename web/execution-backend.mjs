import localFs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createReadStream } from 'node:fs';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

export const containerMode = process.env.NEO_EXECUTION_BACKEND === 'docker';
let backend;
let filesystem;
if (containerMode) {
  const localRoot = path.resolve(process.env.NEO_LOCAL_ENGINE_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine'));
  const load = relative => import(process.env.NEO_CORE_SOURCE === 'local' ? pathToFileURL(path.join(localRoot, 'dist', relative)).href : `neoctl/${relative}`);
  backend = await load('execution/docker.js');
  filesystem = await load('execution/filesystem.js');
}
export const workspaceFs = filesystem?.executionFs || localFs;
export const workspaceHome = () => containerMode ? '/root' : undefined;
export async function openWorkspaceRead(file) {
  if (!containerMode) return localFs.open(file, 'r');
  const stat = await workspaceFs.stat(file);
  const children = new Set();
  return {
    stat: async () => stat,
    createReadStream(options = {}) {
      const script = "const fs=require('node:fs');const [file,opts]=process.argv.slice(1);const stream=fs.createReadStream(file,JSON.parse(opts));stream.on('error',e=>{console.error(e.message);process.exitCode=1});stream.pipe(process.stdout)";
      const child = spawn('docker', backend.dockerArgs(['node', '-e', script, file, JSON.stringify({ start: options.start, end: options.end })]), { env: backend.dockerHostEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
      children.add(child);
      child.stdin.end();
      child.stderr.resume();
      const output = new PassThrough();
      child.stdout.pipe(output, { end: false });
      child.once('error', error => output.destroy(error));
      child.once('close', code => { children.delete(child); if (code) output.destroy(new Error('Container file stream failed')); else output.end(); });
      output.once('close', () => { if (child.exitCode === null) child.kill(); });
      return output;
    },
    close: async () => { for (const child of children) child.kill(); },
  };
}
export async function verifyExecutionBackend() {
  if (process.env.NEO_EXECUTION_BACKEND && !['local', 'docker'].includes(process.env.NEO_EXECUTION_BACKEND)) throw new Error('Invalid NEO_EXECUTION_BACKEND');
  await backend?.verifyDockerBackend();
}

/** The source is server-created upload metadata, not a client-supplied host path. */
export async function deliverUpload(file, url, runtimeTarget) {
  if (!containerMode) return file;
  const target = new URL('/api/state', runtimeTarget);
  for (const name of ['sessionId', 'tabId']) if (url.searchParams.has(name)) target.searchParams.set(name, url.searchParams.get(name));
  const response = await fetch(target);
  if (!response.ok) throw new Error('Cannot resolve upload workspace');
  const state = await response.json();
  if (!state.cwd?.startsWith('/')) throw new Error('Container workspace unavailable');
  const destination = path.posix.join(state.cwd, file.storedName);
  return deliverUploadToWorkspace(file, destination);
}

/** Destination is resolved by the authenticated Web workspace manager. */
export async function deliverUploadToWorkspace(file, destination) {
  if (!containerMode) return file;
  await workspaceFs.mkdir(path.posix.dirname(destination), { recursive: true });
  const script = "const fs=require('node:fs');const out=fs.createWriteStream(process.argv[1],{flags:'wx'});out.on('error',e=>{console.error(e.message);process.exit(1)});process.stdin.pipe(out)";
  const child = spawn('docker', backend.dockerArgs(['node', '-e', script, destination]), { env: backend.dockerHostEnv(), stdio: ['pipe', 'ignore', 'pipe'] });
  let diagnostic = '';
  child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-2000); });
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(diagnostic || 'Container upload failed')));
  });
  await Promise.all([pipeline(createReadStream(file.absolutePath), child.stdin), completion]);
  return { ...file, absolutePath: destination, relativePath: destination };
}

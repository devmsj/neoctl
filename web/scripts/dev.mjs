import { spawn } from 'node:child_process';
import { runWebServer } from 'neoctl/web/index.js';

const host = process.env.NEO_RUNTIME_HOST || '127.0.0.1';
const runtimePort = Number(process.env.NEO_RUNTIME_PORT || 3101);
const appHost = process.env.VITE_HOST || '127.0.0.1';
const appPort = String(process.env.VITE_PORT || 5173);

process.env.VITE_NEO_RUNTIME_TARGET = `http://${host}:${runtimePort}`;
process.env.OPENAI_IMAGE_TIMEOUT_MS ||= '600000';

await runWebServer(['--host', host, '--port', String(runtimePort)]);

const childEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key, value]) => typeof value === 'string' && key && !key.includes('='))
);

const command = `npm run dev:ui -- --host ${appHost} --port ${appPort}`;
const vite = process.platform === 'win32'
  ? spawn('cmd.exe', ['/d', '/s', '/c', command], { stdio: 'inherit', env: childEnv })
  : spawn('sh', ['-c', command], { stdio: 'inherit', env: childEnv });

const shutdown = () => {
  if (!vite.killed) vite.kill('SIGTERM');
  process.exit();
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
vite.on('exit', (code) => process.exit(code ?? 0));
vite.on('error', (error) => {
  console.error(error);
  process.exit(1);
});

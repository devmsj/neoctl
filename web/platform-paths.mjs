import os from 'node:os';
import path from 'node:path';

export function defaultWebDataRoot(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const homeDir = options.homeDir || os.homedir();
  const pathApi = platform === 'win32' ? path.win32 : path.posix;

  if (platform === 'win32') {
    const localAppData = absoluteEnvPath(env.LOCALAPPDATA, pathApi);
    return pathApi.join(localAppData || pathApi.join(homeDir, 'AppData', 'Local'), 'neoctl-web');
  }
  if (platform === 'darwin') {
    return pathApi.join(homeDir, 'Library', 'Application Support', 'neoctl-web');
  }
  const xdgDataHome = absoluteEnvPath(env.XDG_DATA_HOME, pathApi);
  return pathApi.join(xdgDataHome || pathApi.join(homeDir, '.local', 'share'), 'neoctl-web');
}

export function resolveWebStorage(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const cwd = options.cwd || process.cwd();
  const dataRoot = pathApi.resolve(
    cwd,
    String(env.NEO_WEB_DATA_DIR || '').trim() || defaultWebDataRoot({ ...options, platform, env }),
  );
  const workspaceRoot = pathApi.resolve(
    cwd,
    String(env.NEO_WORKSPACE_ROOT || '').trim() || pathApi.join(dataRoot, 'workspaces'),
  );
  return { dataRoot, workspaceRoot };
}

function absoluteEnvPath(value, pathApi) {
  const candidate = String(value || '').trim();
  return candidate && pathApi.isAbsolute(candidate) ? candidate : '';
}

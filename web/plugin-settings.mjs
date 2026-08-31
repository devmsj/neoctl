import fsp from 'node:fs/promises';
import path from 'node:path';

export async function createWebPluginSettings(storageFile) {
  let state = await readState(storageFile);
  let writeQueue = Promise.resolve();

  function snapshot() {
    return structuredClone(state);
  }

  async function update(next) {
    state = next;
    writeQueue = writeQueue.catch(() => undefined).then(() => writeState(storageFile, state));
    await writeQueue;
  }

  return {
    snapshot,
    globalEnabledIds() {
      return Array.isArray(state.globalEnabled) ? [...state.globalEnabled] : undefined;
    },
    sessionOverrides(sessionId) {
      const value = state.sessions[String(sessionId || '')];
      return value && typeof value === 'object' ? { ...value } : {};
    },
    async setGlobalEnabled(ids) {
      await update({ ...state, globalEnabled: [...new Set(ids)].sort() });
    },
    async setSessionOverrides(sessionId, overrides) {
      const id = String(sessionId || '').trim();
      if (!id) throw new Error('session id is required');
      const sessions = { ...state.sessions };
      const normalized = Object.fromEntries(Object.entries(overrides).filter(([, value]) => typeof value === 'boolean'));
      if (Object.keys(normalized).length) sessions[id] = normalized;
      else delete sessions[id];
      await update({ ...state, sessions });
    },
  };
}

async function readState(storageFile) {
  if (!storageFile) return emptyState();
  try {
    const parsed = JSON.parse(await fsp.readFile(storageFile, 'utf8'));
    return {
      version: 1,
      globalEnabled: Array.isArray(parsed?.globalEnabled) ? parsed.globalEnabled.map(String) : undefined,
      sessions: parsed?.sessions && typeof parsed.sessions === 'object' && !Array.isArray(parsed.sessions) ? parsed.sessions : {},
    };
  } catch (error) {
    if (error?.code !== 'ENOENT') console.warn(`failed to read web plugin settings: ${error.message || error}`);
    return emptyState();
  }
}

function emptyState() {
  return { version: 1, globalEnabled: undefined, sessions: {} };
}

async function writeState(storageFile, state) {
  if (!storageFile) return;
  await fsp.mkdir(path.dirname(storageFile), { recursive: true });
  const temporary = `${storageFile}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await fsp.rename(temporary, storageFile);
}

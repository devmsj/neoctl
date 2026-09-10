import fsp from 'node:fs/promises';
import path from 'node:path';

export async function createWebToolSettings(storageFile) {
  let state = await readState(storageFile);
  let writeQueue = Promise.resolve();

  function snapshot() {
    return structuredClone(state);
  }

  async function update(transform) {
    const mutation = writeQueue.catch(() => undefined).then(async () => {
      const next = transform(state);
      await writeState(storageFile, next);
      state = next;
    });
    writeQueue = mutation;
    await mutation;
  }

  return {
    snapshot,
    globalOverrides() {
      return { ...state.global };
    },
    sessionOverrides(sessionId) {
      const value = state.sessions[String(sessionId || '')];
      return value && typeof value === 'object' ? { ...value } : {};
    },
    async setGlobalOverrides(overrides) {
      const global = normalizeOverrides(overrides);
      await update(current => ({ ...current, global }));
    },
    async setSessionOverrides(sessionId, overrides) {
      const id = String(sessionId || '').trim();
      if (!id) throw new Error('session id is required');
      const normalized = normalizeOverrides(overrides);
      await update(current => {
        const sessions = { ...current.sessions };
        if (Object.keys(normalized).length) sessions[id] = normalized;
        else delete sessions[id];
        return { ...current, sessions };
      });
    },
  };
}

function normalizeOverrides(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([name, enabled]) => String(name).trim() && typeof enabled === 'boolean')
      .map(([name, enabled]) => [String(name).trim(), enabled])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

async function readState(storageFile) {
  if (!storageFile) return emptyState();
  try {
    const parsed = JSON.parse(await fsp.readFile(storageFile, 'utf8'));
    const sessions = parsed?.sessions && typeof parsed.sessions === 'object' && !Array.isArray(parsed.sessions)
      ? Object.fromEntries(Object.entries(parsed.sessions).map(([id, value]) => [id, normalizeOverrides(value)]))
      : {};
    return {
      version: 1,
      global: normalizeOverrides(parsed?.global),
      sessions,
    };
  } catch (error) {
    if (error?.code !== 'ENOENT') console.warn(`failed to read web tool settings: ${error.message || error}`);
    return emptyState();
  }
}

function emptyState() {
  return { version: 1, global: {}, sessions: {} };
}

async function writeState(storageFile, state) {
  if (!storageFile) return;
  await fsp.mkdir(path.dirname(storageFile), { recursive: true });
  const temporary = `${storageFile}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await fsp.rename(temporary, storageFile);
}

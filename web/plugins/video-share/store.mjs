import { workspaceFs, openWorkspaceRead, containerMode } from '../../execution-backend.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const VALID_ID = /^[a-f0-9]{48}$/;
export const VIDEO_TYPES = Object.freeze({
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime',
  '.webm': 'video/webm', '.ogv': 'video/ogg',
});

// Each publication has its own atomic directory: no shared mutable index or host imports.
export class VideoStore {
  constructor(directory) { this.directory = path.resolve(directory); }

  async publish(source) {
    if (typeof source !== 'string' || !path.isAbsolute(source)) throw new Error('Video path must be absolute');
    const type = VIDEO_TYPES[path.extname(source).toLowerCase()];
    if (!type) throw new Error('Supported video extensions: .mp4, .m4v, .mov, .webm, .ogv');
    const sourceStat = await workspaceFs.stat(source);
    if (!sourceStat.isFile() || sourceStat.size === 0) throw new Error('Video must be a non-empty regular file');
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const id = randomBytes(24).toString('hex');
    const staging = path.join(this.directory, `.pending-${id}`);
    await fs.mkdir(staging, { mode: 0o700 });
    try {
      // Validate only a small header, then persist the original path, never a copy.
      const header = Buffer.alloc(64);
      if (containerMode) {
        const handle = await openWorkspaceRead(source);
        try { let offset = 0; for await (const chunk of handle.createReadStream({ start: 0, end: 63 })) { chunk.copy(header, offset); offset += chunk.length; } } finally { await handle.close(); }
      } else {
        const handle = await fs.open(source, 'r');
        try { await handle.read(header, 0, header.length, 0); } finally { await handle.close(); }
      }
      const extension = path.extname(source).toLowerCase();
      const valid = extension === '.webm' ? header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
        : extension === '.ogv' ? header.toString('ascii', 0, 4) === 'OggS'
          : ['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'].includes(header.toString('ascii', 4, 8));
      if (!valid) throw new Error('File does not have a recognized video container signature');
      const entry = { version: 2, id, absolutePath: path.resolve(source), filename: path.basename(source), contentType: type, sizeBytes: sourceStat.size, createdAt: new Date().toISOString() };
      await fs.writeFile(path.join(staging, 'entry.json'), JSON.stringify(entry), { mode: 0o600 });
      await fs.rename(staging, path.join(this.directory, id));
      return entry;
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true });
      throw error;
    }
  }

  async get(id) {
    if (!VALID_ID.test(id)) return undefined;
    try {
      const entry = JSON.parse(await fs.readFile(path.join(this.directory, id, 'entry.json'), 'utf8'));
      // Old v1 snapshots have no source path; do not silently serve a copy.
      if (entry.version === 1) return undefined;
      if (entry.version !== 2 || typeof entry.absolutePath !== 'string' || !path.isAbsolute(entry.absolutePath)
        || entry.id !== id || typeof entry.filename !== 'string'
        || !Object.values(VIDEO_TYPES).includes(entry.contentType)) throw new Error('Invalid video metadata');
      return { ...entry, mediaPath: entry.absolutePath };
    } catch (error) {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async revoke(id) {
    if (!VALID_ID.test(id)) throw new Error('Invalid video id');
    const tombstone = path.join(this.directory, `.revoked-${id}-${randomBytes(6).toString('hex')}`);
    try { await fs.rename(path.join(this.directory, id), tombstone); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    // Renaming removes the public mapping first; never reuse a revoked token.
    await fs.rm(tombstone, { recursive: true, force: true });
    return true;
  }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlugin as downloads } from '../plugins/downloads/index.mjs';
import { createPlugin as videos } from '../plugins/video-share/index.mjs';

test('delivery contracts live in enabled tool definitions, not duplicate prompt sections', async t => {
  const root = await mkdtemp(join(tmpdir(), 'neo-guidance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const context = { appDataDir: root, env: {} };
  const d = downloads(context), v = videos(context);
  assert.equal(d.promptSections?.length || 0, 0);
  assert.equal(v.promptSections?.length || 0, 0);
  const download = d.tools.find(t => t.name === 'expose_downloads').description;
  for (const text of ['before the final reply', 'absolute paths', 'downloads[].markdown verbatim', 'sandbox:', 'no file is copied', 'without automatic expiration', 'Anyone with the link', 're-expose']) assert.ok(download.includes(text), text);
  const video = v.tools.find(t => t.name === 'expose_videos').description;
  for (const text of ['not a generic download tool', 'absolute paths', 'without video URLs', 'download only if explicitly requested', 'no directory restrictions', 'no transcoding', 'snapshot', 'browser codec support']) assert.ok(video.includes(text), text);
  const revoke = v.tools.find(t => t.name === 'revoke_videos').description;
  assert.match(revoke, /Only call when the user requests revocation/);
  assert.match(revoke, /Never delete or modify source videos/);
});

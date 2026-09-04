import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createOpenXhsArtifactEditorTool, createReadXhsArtifactTool, XhsArtifactRegistry } from './plugins/xhs-artifact/artifacts.mjs';
import { renderXhsEditorPage } from './plugins/xhs-artifact/editor-page.mjs';
import { parseXhsArtifactToolOutput, selectNewestXhsArtifact, XHS_ARTIFACT_EDITOR_HINT, XHS_ARTIFACT_INPUT_SCHEMA } from './plugins/xhs-artifact/xhs-artifact-contract.mjs';

function completePayload(overrides = {}) {
  return {
    title: '周末去看海',
    body: '风很轻，海边刚好。\n把这条路线收藏起来，周末直接出发。',
    interaction: '',
    hashtags: ['#周末去哪儿', '#看海'],
    images: [{
      url: '/tmp/generated-cover.png',
      caption: '傍晚海边的广角画面',
      overlay: '周末去看海',
      note: '暖色调，人物放在右下角',
    }],
    review: '避免绝对化措辞。',
    ...overrides,
  };
}

test('tool schema and validation enforce exact editor fields', () => {
  const tool = createOpenXhsArtifactEditorTool({ registry: new XhsArtifactRegistry() });

  assert.deepEqual(tool.inputSchema.required, ['payload']);
  assert.equal(tool.inputSchema, XHS_ARTIFACT_INPUT_SCHEMA);
  assert.equal(tool.description, XHS_ARTIFACT_EDITOR_HINT);
  assert.equal(tool.inputSchema.properties.payload.additionalProperties, false);
  assert.deepEqual(tool.inputSchema.properties.payload.required, ['title', 'body', 'interaction', 'hashtags', 'images', 'review']);
  assert.throws(() => tool.validate({ content: '# 标题\n错误格式' }), /payload must be an object/);
  assert.throws(() => tool.validate({ payload: completePayload({ images: '封面图建议' }) }), /images must be an array/);
  assert.throws(() => tool.validate({ payload: completePayload({ images: [{ url: '一张海边封面图', caption: '', overlay: '', note: '' }] }) }), /real http\(s\) URL/);
});

test('validation rejects legacy aliases and mixed editor sections', () => {
  const tool = createOpenXhsArtifactEditorTool({ registry: new XhsArtifactRegistry() });

  assert.throws(
    () => tool.validate({ payload: { ...completePayload(), content: { body: '旧嵌套正文' } } }),
    /unexpected content/,
  );
  assert.throws(
    () => tool.validate({ payload: completePayload({ body: '周末去看海\n真正的正文。' }) }),
    /must not repeat payload.title/,
  );
  assert.throws(
    () => tool.validate({ payload: completePayload({ body: '真正的正文。 #看海' }) }),
    /must not contain hashtags/,
  );
  assert.throws(
    () => tool.validate({ payload: completePayload({ body: '## 正文\n真正的正文。' }) }),
    /must not contain editor section headings/,
  );
  assert.throws(
    () => tool.validate({ payload: completePayload({ hashtags: ['周末去哪儿'] }) }),
    /must be exactly one #topic/,
  );
  assert.deepEqual(
    tool.validate({ payload: completePayload({ hashtags: ['#猫粮', '＃新手养猫'] }) }).payload.hashtags,
    ['#猫粮', '#新手养猫'],
  );
  assert.throws(
    () => tool.validate({ payload: completePayload({ images: [{ url: '', caption: '', overlay: '', note: '', prompt: '旧提示词' }] }) }),
    /unexpected prompt/,
  );
  assert.throws(
    () => tool.validate({ payload: completePayload({ images: [] }) }),
    /must contain at least one image/,
  );
});

test('editor keeps正文, image path, overlay and review in separate fields', async () => {
  const registry = new XhsArtifactRegistry();
  const openTool = createOpenXhsArtifactEditorTool({ registry });
  const readTool = createReadXhsArtifactTool({ registry });
  const validated = openTool.validate({ payload: completePayload() });
  const created = await openTool.execute(validated, { session: { sessionId: 'session-1' } });
  const artifact = parseXhsArtifactToolOutput(created.output);

  assert.ok(artifact);
  assert.equal(artifact.payload.body, completePayload().body);
  assert.equal(artifact.payload.images[0].caption, '傍晚海边的广角画面');
  assert.equal(artifact.payload.images[0].overlay, '周末去看海');
  assert.equal(artifact.payload.images[0].note, '暖色调，人物放在右下角');
  assert.equal(artifact.payload.review, '避免绝对化措辞。');
  assert.match(artifact.payload.images[0].url, /^\/api\/local-images\//);

  registry.update(artifact.id, { payload: { ...artifact.payload, body: '用户亲自修改后的正文', images: artifact.payload.images } });
  const latest = await readTool.execute(readTool.validate({ id: artifact.id }));
  assert.equal(latest.output.artifact.payload.body, '用户亲自修改后的正文');

  const revised = openTool.validate({
    artifact_id: artifact.id,
    payload: completePayload({ body: '保留用户修改，再补充一句。' }),
  });
  const updated = await openTool.execute(revised, { session: { sessionId: 'session-1' } });
  const updatedOutput = updated.output;
  assert.equal(updatedOutput.action, 'updated');
  assert.equal(updatedOutput.artifact.id, artifact.id);
  assert.equal(updatedOutput.artifact.payload.body, '保留用户修改，再补充一句。');
  assert.equal(updatedOutput._ui.presentationLevel, 'primary');
  assert.equal(updatedOutput._ui.resources[0].kind, 'embed');
  assert.match(updatedOutput._ui.resources[0].url, new RegExp(`/api/xhs-artifacts/${artifact.id}/editor`));
});

test('client parser renders only complete JSON tool artifacts', () => {
  const artifact = {
    id: 'artifact-1',
    type: 'xhs-post',
    title: completePayload().title,
    payload: completePayload(),
  };

  assert.deepEqual(parseXhsArtifactToolOutput(`ok\n${JSON.stringify({ artifact, action: 'opened' })}`), artifact);
  assert.equal(parseXhsArtifactToolOutput('ok\nartifact:\n  id: old-format\n  title: 未命名笔记'), null);
  assert.equal(parseXhsArtifactToolOutput(JSON.stringify({ artifact: { ...artifact, payload: { title: artifact.title } } })), null);
});

test('client keeps the newest update for the same editor id', () => {
  const initial = {
    id: 'artifact-1',
    type: 'xhs-post',
    title: completePayload().title,
    payload: completePayload({ images: [{ url: '', caption: '待生成封面', overlay: '', note: '生成图片' }] }),
    createdAt: 100,
    updatedAt: 100,
  };
  const updated = {
    ...initial,
    payload: completePayload({ images: [{ url: '/api/local-images/generated', caption: '已生成封面', overlay: '', note: '' }] }),
    updatedAt: 200,
  };

  assert.equal(selectNewestXhsArtifact(initial, updated), updated);
  assert.equal(selectNewestXhsArtifact(updated, initial), updated);
  assert.equal(selectNewestXhsArtifact(initial, { ...initial }), initial);
});

test('plugin editor page owns its Xiaohongshu presentation and fullscreen UI', () => {
  const artifact = { id: 'artifact-1', title: completePayload().title, payload: completePayload() };
  const html = renderXhsEditorPage(artifact, '/api/xhs-artifacts/artifact-1');
  assert.match(html, /id="fullscreen"/);
  assert.match(html, /requestFullscreen/);
  assert.match(html, /关注/);
  assert.doesNotMatch(html, /插件资源/);
});

test('registry persists artifacts across process-style restarts and isolates sessions', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-artifacts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const firstRegistry = new XhsArtifactRegistry({ storageDir: root });
  const openTool = createOpenXhsArtifactEditorTool({ registry: firstRegistry });
  const createdResult = await openTool.execute(openTool.validate({ payload: completePayload() }), { session: { sessionId: 'session-a' } });
  const created = parseXhsArtifactToolOutput(createdResult.output);
  assert.ok(created);

  const restartedRegistry = new XhsArtifactRegistry({ storageDir: root });
  const readTool = createReadXhsArtifactTool({ registry: restartedRegistry });
  const restored = await readTool.execute(readTool.validate({ id: created.id }), { session: { sessionId: 'session-a' } });
  assert.equal(restored.output.artifact.payload.body, completePayload().body);
  await assert.rejects(
    () => readTool.execute(readTool.validate({ id: created.id }), { session: { sessionId: 'session-b' } }),
    /artifact not found/,
  );
});

test('registry recovers an artifact from a persisted session transcript', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-recovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sessionId = '2026-08-13T03-47-38-805Z-SK-20250427HBTJ-test';
  const sessionsDir = path.join(root, 'sessions');
  const storageDir = path.join(root, 'artifacts');
  const artifact = {
    id: 'artifact-from-transcript',
    type: 'xhs-post',
    title: completePayload().title,
    payload: completePayload(),
    sessionId,
    createdAt: 100,
    updatedAt: 100,
  };
  const transcriptDir = path.join(sessionsDir, sessionId);
  fs.mkdirSync(transcriptDir, { recursive: true });
  fs.writeFileSync(path.join(transcriptDir, 'transcript.jsonl'), `${JSON.stringify({
    type: 'message',
    sessionId,
    message: {
      role: 'tool_result',
      blocks: [{
        type: 'tool_result',
        name: 'open_xhs_artifact_editor',
        ok: true,
        output: JSON.stringify({ artifact, action: 'opened' }),
      }],
    },
  })}\n`, 'utf8');

  const registry = new XhsArtifactRegistry({ storageDir, sessionsDir });
  assert.equal(registry.get(artifact.id, sessionId)?.title, artifact.title);
  assert.ok(fs.existsSync(path.join(storageDir, `${artifact.id}.json`)));
});

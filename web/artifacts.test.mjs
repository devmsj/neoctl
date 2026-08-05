import assert from 'node:assert/strict';
import test from 'node:test';
import { createOpenXhsArtifactEditorTool, createReadXhsArtifactTool, XhsArtifactRegistry } from './artifacts.mjs';

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
  assert.equal(tool.inputSchema.properties.payload.additionalProperties, false);
  assert.deepEqual(tool.inputSchema.properties.payload.required, ['title', 'body', 'interaction', 'hashtags', 'images', 'review']);
  assert.throws(() => tool.validate({ content: '# 标题\n错误格式' }), /payload must be an object/);
  assert.throws(() => tool.validate({ payload: completePayload({ images: '封面图建议' }) }), /images must be an array/);
  assert.throws(() => tool.validate({ payload: completePayload({ images: [{ url: '一张海边封面图', caption: '', overlay: '', note: '' }] }) }), /actual http\(s\) URL/);
});

test('editor keeps正文, image path, overlay and review in separate fields', async () => {
  const registry = new XhsArtifactRegistry();
  const openTool = createOpenXhsArtifactEditorTool({ registry });
  const readTool = createReadXhsArtifactTool({ registry });
  const validated = openTool.validate({ payload: completePayload() });
  const created = await openTool.execute(validated, { session: { sessionId: 'session-1' } });
  const artifact = created.output.artifact;

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
  assert.equal(updated.output.action, 'updated');
  assert.equal(updated.output.artifact.id, artifact.id);
  assert.equal(updated.output.artifact.payload.body, '保留用户修改，再补充一句。');
});

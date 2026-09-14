import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Exercise the actual normalizers without starting servers or mounting Vue.
for (const file of ['scripts/dev.mjs', 'server.mjs', 'src/App.vue']) {
  test(`${file}: usage survives normalization, JSON storage, read and update`, async () => {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    const fn = source.match(/function normalizePromptItem\(item\) \{[\s\S]*?\n\}/)?.[0];
    assert.ok(fn, 'normalizer exists');
    const normalize = vm.runInNewContext(`(${fn})`, { createPromptId: () => 'generated-id' });
    const input = { id: 'usage-test', title: ' 标题 ', content: ' 提示词 ', usage: '  先提供 **素材**。\n再说明目标。  ' };
    const saved = normalize(input);
    assert.equal(saved.usage, '先提供 **素材**。\n再说明目标。');
    const loaded = normalize(JSON.parse(JSON.stringify(saved)));
    assert.equal(loaded.usage, saved.usage);
    assert.equal(normalize({ ...loaded, content: '新内容' }).usage, saved.usage);
    assert.equal(normalize({ ...loaded, usage: '新用法' }).usage, '新用法');
    assert.equal(normalize({ ...loaded, usage: '' }).usage, '');
    assert.equal(normalize({ title: '旧记录', content: '内容' }).usage, '');
    assert.equal(normalize({ title: '', content: '内容', usage: '用法' }), null);
  });
}

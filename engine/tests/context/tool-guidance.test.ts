import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDefaultSystemPromptSections, buildEffectiveSystemPrompt } from '../../src/context/prompts.js';
import { createOpenAIImageGenerationTool } from '../../src/tools/builtins/image-generation-tool.js';
import { createLoadImageTool } from '../../src/tools/builtins/image-loader-tool.js';
import { IMAGE_SELECTION_GUIDE, IMAGE_EDIT_REFERENCE_GUIDE } from '../../src/tools/builtins/image-capabilities.js';

test('image guidance has one owner and remains available through tool definitions', () => {
  const system = buildEffectiveSystemPrompt(buildDefaultSystemPromptSections(['image_create', 'image_inspect', 'plan_update'], 'BASELINE'));
  const tool = createOpenAIImageGenerationTool();
  assert.ok(typeof tool.description === 'string');
  const schema = JSON.stringify(tool.inputSchema);
  assert.ok(system.includes('BASELINE'));
  assert.match(system, /call plan_update/);
  assert.match(system, /48000 serialized characters/);
  assert.match(system, /within 1-200000/);
  for (const guide of [IMAGE_SELECTION_GUIDE, IMAGE_EDIT_REFERENCE_GUIDE]) {
    assert.equal(system.includes(guide), false);
    assert.equal(schema.includes(guide), false);
    assert.equal(tool.description.split(guide).length - 1, 1);
  }
  assert.doesNotMatch(system, /quality=auto|hasTransparentPixels|imageRefs|before description, OCR/);
  for (const text of ['quality=auto', 'gpt-image-2.5-flare', 'mode=edit', 'imageRefs', 'useLatestImage=true', 'validation failure', 'material output mismatches', 'hasTransparentPixels']) assert.ok(tool.description.includes(text), text);
  const inspect = createLoadImageTool();
  assert.ok(typeof inspect.description === 'string');
  for (const text of ['mode=list', 'image registry', 'context compaction', '20MB', 'next message']) assert.ok(inspect.description.includes(text), text);
});

test('disabled image tools keep truthful capability fallbacks without detailed instructions', () => {
  const system = buildEffectiveSystemPrompt(buildDefaultSystemPromptSections([], 'BASELINE'));
  assert.match(system, /no image loading tool/);
  assert.match(system, /no drawing\/image generation\/editing tool/);
  assert.doesNotMatch(system, /gpt-image-2\.5|imageRefs|call plan_update/);
});

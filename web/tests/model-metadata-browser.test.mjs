import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'
import { openGlobalSettings } from './settings-navigation.mjs'
import { emptyAppearance } from '../shared/appearance.mjs'
import { handleModelSettingsRequest } from '../../engine/dist/web/model-settings-api.js'
import { ModelSettingsStore } from '../../engine/dist/model/settings-store.js'
import { saveModelMetadata, findModelMetadata } from '../../engine/dist/model/context-window.js'
import { registerSettingsConsumer } from '../../engine/dist/model/settings-sync.js'

test('model library edits IDs and deletes with fresh occupancy confirmation against a temporary real backend', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'neo-metadata-ui-'))
  const previous = process.env.NEO_MODEL_CONFIG_DIR
  process.env.NEO_MODEL_CONFIG_DIR = home
  let ui, held = '', interrupted = 0
  const consumer = { isModelConfigurationBusy: () => Boolean(held), refreshModelConfigurationIfIdle() {}, getHeldModelIds: () => held ? [held] : [], interruptForModelRemoval() { interrupted++ } }
  registerSettingsConsumer(consumer)
  try {
    new ModelSettingsStore().initialize({})
    saveModelMetadata({ id: 'ui-model', provider: 'custom', modelIds: ['ui-model'], reasoning: false })
    ui = await createObservabilityBrowser(observabilitySnapshot(), async route => {
      const url = new URL(route.request().url())
      if (url.pathname.startsWith('/api/model-settings')) { await route.continue(); return true }
      if (url.pathname === '/api/appearance') { await route.fulfill({ json: { config: emptyAppearance(), revision: '0' } }); return true }
    }, { apiHandler: (req, res, url) => handleModelSettingsRequest(req, res, url) })
    const p = ui.page
    await openGlobalSettings(p)
    await p.locator('[data-settings-page="model"]').click()
    const searchSection = p.getByRole('region', { name: '搜索配置', exact: true })
    await searchSection.waitFor()
    assert.equal(await searchSection.getByText('OpenAI API', { exact: true }).count(), 0)
    assert.equal(await searchSection.locator('.fallback-row svg').count(), 0)
    assert.equal(await searchSection.getByRole('button', { name: 'Exa 配置', exact: true }).count(), 0)
    assert.equal(await searchSection.locator('.fallback-service').count(), 0)
    const exaToggle = searchSection.getByRole('checkbox', { name: '启用 Exa 备用', exact: true })
    await exaToggle.uncheck(); assert.equal(await exaToggle.isChecked(), false)
    await exaToggle.check(); assert.equal(await exaToggle.isChecked(), true)
    await searchSection.getByRole('button', { name: '搜索参数', exact: true }).click()
    assert.ok(await p.getByRole('textbox', { name: 'Exa MCP URL', exact: true }).isVisible())
    await p.getByRole('button', { name: '取消', exact: true }).click()
    const desktop = await p.viewportSize()
    for (const width of [1280, 390]) {
      await p.setViewportSize({ width, height: 1000 })
      assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      if (width === 1280) {
        const a = await searchSection.locator('.api-control').boundingBox()
        const b = await searchSection.locator('.settings-field-grid>.settings-field').nth(1).locator('.neo-select').boundingBox()
        assert.ok(Math.abs(a.y - b.y) < 2, 'search connection and model controls stay aligned')
      }
    }
    await p.setViewportSize(desktop)
    await p.getByRole('button', { name: '模型库', exact: true }).click()
    const search = () => p.getByRole('textbox', { name: '搜索模型元数据', exact: true })
    await search().fill('ui-model')
    await p.getByRole('button', { name: '编辑模型 ui-model', exact: true }).click()
    const id = p.getByRole('textbox', { name: '模型 ID', exact: true })
    assert.ok(await id.isEditable())
    await id.fill('ui-model-renamed')
    await p.getByRole('button', { name: '保存', exact: true }).click()
    await p.getByRole('button', { name: '编辑模型 ui-model-renamed', exact: true }).waitFor()
    assert.equal(findModelMetadata('ui-model-renamed').id, 'ui-model-renamed')
    assert.equal(findModelMetadata('ui-model').id, 'ui-model-renamed', 'retained alias keeps old session IDs usable')
    await p.getByRole('button', { name: '删除模型 ui-model-renamed', exact: true }).click()
    await p.getByRole('dialog', { name: '删除模型', exact: true }).waitFor()
    assert.equal(await p.getByText('有会话占用该模型，删除会中断会话。', { exact: true }).count(), 0)
    await p.getByRole('button', { name: '取消', exact: true }).click()
    assert.ok(findModelMetadata('ui-model'))
    await p.getByRole('button', { name: '删除模型 ui-model-renamed', exact: true }).click()
    await p.getByRole('button', { name: '删除', exact: true }).waitFor()
    held = 'ui-model' // Occupancy changes while the ordinary confirmation is open.
    await p.getByRole('button', { name: '删除', exact: true }).click()
    await p.getByRole('button', { name: '删除并中断', exact: true }).waitFor()
    assert.ok(findModelMetadata('ui-model')); assert.equal(interrupted, 0)
    assert.ok(await p.getByText('有会话占用该模型，删除会中断会话。', { exact: true }).isVisible())
    await p.getByRole('button', { name: '删除并中断', exact: true }).click()
    await p.getByRole('dialog', { name: '模型库', exact: true }).waitFor()
    assert.equal(findModelMetadata('ui-model'), undefined)
    assert.equal(interrupted, 1); held = ''
    assert.equal(await p.getByRole('button', { name: '编辑模型 ui-model-renamed', exact: true }).count(), 0)
    await p.getByRole('button', { name: '添加模型', exact: true }).click()
    await p.getByRole('textbox', { name: '模型 ID', exact: true }).fill('ui-restored')
    await p.getByRole('button', { name: '保存', exact: true }).click()
    await p.getByRole('dialog', { name: '模型库', exact: true }).waitFor()
    await search().fill('ui-restored')
    await p.getByRole('button', { name: '删除模型 ui-restored', exact: true }).click()
    await p.getByRole('button', { name: '删除', exact: true }).click()
    await p.getByRole('dialog', { name: '模型库', exact: true }).waitFor()
    assert.equal(findModelMetadata('ui-restored'), undefined)
    const disk = JSON.parse(await readFile(path.join(home, 'model-metadata.json'), 'utf8'))
    assert.ok(disk.removedModelIds.includes('ui-model-renamed'))
    assert.deepEqual(ui.errors, [])
    assert.ok(!ui.requests.some(r => /\/api\/(send|interrupt|model-settings\/test)/.test(r.url)))
  } finally {
    held = ''; await ui?.close()
    if (previous === undefined) delete process.env.NEO_MODEL_CONFIG_DIR; else process.env.NEO_MODEL_CONFIG_DIR = previous
    await rm(home, { recursive: true, force: true })
  }
})

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
      // Capabilities pick models only; connections come from the API priority list.
      assert.equal(await searchSection.locator('.api-control').count(), 0)
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
    assert.equal(await p.getByText('有活动会话使用该模型，删除将打断会话，模型选择将清空。', { exact: true }).count(), 0)
    await p.getByRole('button', { name: '取消', exact: true }).click()
    assert.ok(findModelMetadata('ui-model'))
    await p.getByRole('button', { name: '删除模型 ui-model-renamed', exact: true }).click()
    await p.getByRole('button', { name: '删除', exact: true }).waitFor()
    held = 'ui-model' // Occupancy changes while the ordinary confirmation is open.
    await p.getByRole('button', { name: '删除', exact: true }).click()
    await p.getByRole('button', { name: '删除并中断', exact: true }).waitFor()
    assert.ok(findModelMetadata('ui-model')); assert.equal(interrupted, 0)
    assert.ok(await p.getByText('有活动会话使用该模型，删除将打断会话，模型选择将清空。', { exact: true }).isVisible())
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
    // API priority list: top-most enabled API serving the model is effective; deletion falls through, never auto-switches on failure.
    await p.getByRole('button', { name: '关闭', exact: true }).click()
    const store = new ModelSettingsStore()
    let state = store.initialize({})
    state = store.saveConnection(state.revision, { id: '', name: 'ui-api', kind: 'openai', baseUrl: 'http://localhost:9', key: 'fixture', models: ['gpt-6.1-sol'] })
    state = store.saveConnection(state.revision, { id: '', name: 'ui-api-2', kind: 'openai', baseUrl: 'http://localhost:10', key: 'fixture', models: ['gpt-6.1-sol'] })
    const apiId = state.connections.find(a => a.name === 'ui-api').id, apiId2 = state.connections.find(a => a.name === 'ui-api-2').id
    let apiHeld = true, apiBusy = false, apiCleared = 0
    const apiConsumer = { isModelConfigurationBusy: () => apiBusy, refreshModelConfigurationIfIdle() {}, getHeldConnectionIds: () => apiHeld ? [apiId] : [], interruptForModelRemoval() { apiCleared++; apiHeld = false } }
    registerSettingsConsumer(apiConsumer)
    const c = structuredClone(state.composition); c.order = [{ id: apiId, enabled: true }, { id: apiId2, enabled: true }]; c.main = { api: '', model: 'gpt-6.1-sol', effort: 'high' }
    store.apply(state.revision, c)
    assert.equal(store.read().applied.composition.main.api, apiId)
    await p.getByRole('button', { name: '重新加载配置', exact: true }).click()
    assert.equal(await p.getByRole('button', { name: 'API 配置', exact: true }).count(), 0, 'no duplicate API manager entry')
    const apiSection = p.getByRole('region', { name: 'API 配置', exact: true })
    const rows = apiSection.getByRole('listitem')
    await rows.first().waitFor()
    assert.deepEqual(await rows.locator('.conn-main strong').allTextContents(), ['ui-api', 'ui-api-2'])
    assert.equal(await rows.nth(0).getByLabel('主模型生效', { exact: true }).count(), 1)
    await apiSection.getByRole('button', { name: '拖动排序 ui-api-2', exact: true }).focus()
    await p.keyboard.press('ArrowUp')
    await p.waitForTimeout(250)
    assert.deepEqual(await rows.locator('.conn-main strong').allTextContents(), ['ui-api-2', 'ui-api'])
    assert.equal(await rows.nth(0).getByLabel('主模型生效', { exact: true }).count(), 1, 'top-most API serving the model becomes effective')
    assert.ok(await p.getByText('未应用', { exact: true }).isVisible())
    await p.getByRole('button', { name: '撤销', exact: true }).click()
    assert.deepEqual(await rows.locator('.conn-main strong').allTextContents(), ['ui-api', 'ui-api-2'])
    await apiSection.getByRole('button', { name: 'ui-api 可用模型 1 个', exact: true }).click()
    const apiDialog = p.getByRole('dialog', { name: '编辑 API', exact: true })
    await apiDialog.waitFor()
    assert.equal(await apiDialog.getByRole('listbox', { name: '可用模型', exact: true }).getByRole('option').count(), 1)
    await apiDialog.getByRole('button', { name: '删除 API', exact: true }).click()
    await p.getByRole('dialog', { name: '删除 API', exact: true }).waitFor()
    const warning = '有活动会话正通过此 API 调用，删除将打断会话；之后由下方符合条件的 API 生效。'
    assert.equal(await p.getByText(warning, { exact: true }).count(), 0)
    apiBusy = true
    await p.getByRole('button', { name: '删除', exact: true }).click()
    await p.getByRole('button', { name: '删除并中断', exact: true }).waitFor()
    assert.ok(await p.getByText(warning, { exact: true }).isVisible())
    assert.equal(apiCleared, 0)
    await p.getByRole('button', { name: '删除并中断', exact: true }).click()
    await p.getByRole('dialog').waitFor({ state: 'detached' })
    assert.equal(apiCleared, 1); apiBusy = false
    assert.equal(store.read().applied.composition.main.api, apiId2, 'the next qualifying API takes over')
    assert.deepEqual(await rows.locator('.conn-main strong').allTextContents(), ['ui-api-2'])
    assert.equal(await rows.nth(0).getByLabel('主模型生效', { exact: true }).count(), 1)
    assert.deepEqual(ui.errors, [])
    assert.ok(!ui.requests.some(r => /\/api\/(send|interrupt|model-settings\/test)/.test(r.url)))
  } finally {
    held = ''; await ui?.close()
    if (previous === undefined) delete process.env.NEO_MODEL_CONFIG_DIR; else process.env.NEO_MODEL_CONFIG_DIR = previous
    await rm(home, { recursive: true, force: true })
  }
})

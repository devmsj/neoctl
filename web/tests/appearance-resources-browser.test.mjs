import { openGlobalSettings } from './settings-navigation.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createAppearanceStore, createAppearanceRoute } from '../appearance-store.mjs'
import { validateImageBytes } from '../../engine/dist/core/image-input.js'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'

// Real HTTP storage, decoding and persistent resources, not mocked success responses.
test('background and fonts persist through service recreation; malformed input stays recoverable', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-appearance-ui-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const makeRoute = () => createAppearanceRoute(createAppearanceStore(dir, { validateImage: validateImageBytes }))
  let route = makeRoute()
  const ui = await createObservabilityBrowser(observabilitySnapshot({ lines: [
    { id: 1, kind: 'user', text: 'Appearance sample' },
    { id: 2, kind: 'assistant', text: 'Paragraph one.\n\nParagraph two.\n\n```js\nconst sample = 42\n```' },
  ] }), async r => {
    if (new URL(r.request().url()).pathname.startsWith('/api/appearance')) { await r.continue(); return true }
  }, { apiHandler: (req, res, url) => route(req, res, url) })
  t.after(() => ui.close())
  const p = ui.page
  const open = async () => {
    await openGlobalSettings(p)
    await p.locator('[data-settings-page="appearance"]').click();if(await p.getByRole('button',{name:'编辑Resources',exact:true}).count())await p.getByRole('button',{name:'编辑Resources',exact:true}).click();else await p.getByRole('button',{name:'设计外观',exact:true}).click()
  }
  await open()
  const finishApply = async () => {
    await p.getByLabel('外观名称',{exact:true}).fill('Resources')
    await p.getByRole('button',{name:'完成设计',exact:true}).click()
    await p.locator('.appearance-preset-grid').waitFor()
    await p.getByRole('button',{name:'应用Resources',exact:true}).click()
    await p.waitForFunction(()=>document.querySelector('[aria-label="应用Resources"]').getAttribute('aria-pressed')==='true')
    await p.getByRole('button',{name:'编辑Resources',exact:true}).click()
  }
  const editor = p.locator('.appearance-editor')
  const png = Buffer.from(await p.evaluate(() => { const c = document.createElement('canvas'); c.width = c.height = 32; const ctx = c.getContext('2d'); ctx.fillStyle = '#906f88'; ctx.fillRect(0, 0, 32, 32); return c.toDataURL().split(',')[1] }), 'base64')
  await editor.getByLabel('上传背景文件').setInputFiles({ name: 'misnamed.jpg', mimeType: 'image/jpeg', buffer: png })
  await editor.locator('.appearance-background-picker img').waitFor()
  const imageSrc = await editor.locator('.appearance-background-picker img').getAttribute('src')
  assert.ok(imageSrc.endsWith('.png'), 'actual bytes determine extension')
  await editor.getByRole('button', { name: '字体', exact: true }).click()
  await editor.locator('#appearance-font-text').fill('Bad;Font')
  await editor.getByRole('alert').waitFor()
  assert.equal(await editor.getByRole('button', { name: '完成设计', exact: true }).isEnabled(), false)
  await editor.locator('#appearance-font-text').fill('Georgia')
  await editor.locator('#appearance-textSize').fill('21')
  await editor.locator('#appearance-codeSize').fill('17')
  await editor.locator('#appearance-lineHeight').fill('1.8')
  await editor.locator('#appearance-textWeight').fill('500')
  await editor.getByRole('button', { name: '布局', exact: true }).click()
  await editor.locator('#appearance-radius').fill('12')
  await editor.locator('#appearance-contentWidth').fill('420')
  await finishApply()

  const saved = await createAppearanceStore(dir).read(), mode = await p.evaluate(() => document.documentElement.dataset.theme)
  assert.equal(saved.config[mode].textSize, 21)
  assert.ok(saved.config[mode].backgroundAsset.endsWith('.png'))
  await editor.getByRole('button',{name:'返回外观',exact:true}).click();await editor.getByRole('button', { name: '返回全局配置', exact: true }).click()
  await p.getByRole('button', { name: '新建会话', exact: true }).first().click()
  // Fixture retains its sample transcript after a reload; no model calls needed.
  route = makeRoute()
  await p.reload()
  await p.locator('.message.user .message-text').waitFor()
  const styles = await p.evaluate(() => {
    const s = q => { const n = document.querySelector(q), c = getComputedStyle(n); return { size: c.fontSize, family: c.fontFamily, lineHeight: c.lineHeight } }
    return { user: s('.message.user .message-text'), assistant: s('.message.assistant .message-text'), code: s('.message-text pre'), background: getComputedStyle(document.querySelector('.shell'), '::before').backgroundImage }
  })
  assert.equal(styles.user.size, '21px'); assert.equal(styles.assistant.size, '21px'); assert.equal(styles.code.size, '17px')
  assert.match(styles.user.family, /Georgia/); assert.equal(styles.user.lineHeight, '37.8px')
  assert.match(styles.background, /\.png/)
  const layout = await p.evaluate(() => {
    const row = document.querySelector('.virtual-message-row'), parent = row.parentElement, r = row.getBoundingClientRect(), b = parent.getBoundingClientRect()
    return { width: r.width, centered: Math.abs((r.left + r.right) - (b.left + b.right)), weight: getComputedStyle(document.querySelector('.message.user .message-text')).fontWeight, radius: getComputedStyle(document.querySelector('.message.user .message-body')).borderRadius, canvas: getComputedStyle(document.querySelector('.rows-transcript')).backgroundColor }
  })
  assert.equal(layout.width, 420); assert.ok(layout.centered < 2); assert.equal(layout.weight, '500'); assert.equal(layout.radius, '12px'); assert.equal(layout.canvas, 'rgba(0, 0, 0, 0)')
  await open()
  await editor.getByRole('button', { name: '恢复' + (mode === 'dark' ? '夜间' : '日间') + '默认', exact: true }).click()
  await finishApply()

  const store = createAppearanceStore(dir)
  await editor.getByLabel('上传背景文件').setInputFiles({ name: 'bad.png', mimeType: 'image/png', buffer: Buffer.from('<html>not an image</html>') })
  await editor.getByRole('alert').waitFor()
  assert.match(await editor.getByRole('alert').innerText(), /解码/)
  // Exercise the actual bundled WOFF2 and browser FontFace sanitizer, not a mock.
  const assetDir = new URL('../dist/assets/', import.meta.url)
  const font = (await fs.readdir(assetDir)).find(name => /^KaTeX_Main-Regular-.*\.woff2$/.test(name))
  await editor.getByRole('button', { name: '字体', exact: true }).click()
  await editor.locator('[data-tooltip="导入正文字体"]').click()
  await editor.getByLabel('上传字体文件').setInputFiles({ name: 'custom.woff2', mimeType: 'font/woff2', buffer: await fs.readFile(new URL(font, assetDir)) })
  await p.waitForFunction(() => [...document.fonts].some(face => face.family.startsWith('neo-') && face.status === 'loaded'))
  await finishApply()

  const fontId = (await store.read()).config[mode].textFontAsset
  assert.ok(fontId.endsWith('.woff2'))
  await p.reload()
  await p.waitForFunction(() => [...document.fonts].some(face => face.family.startsWith('neo-') && face.status === 'loaded'))
  await open()
  await editor.getByRole('button', { name: '字体', exact: true }).click()
  await editor.getByLabel('上传字体文件').setInputFiles({ name: 'bad.woff2', mimeType: 'font/woff2', buffer: Buffer.from('invalid font bytes') })
  await editor.getByRole('alert').waitFor()
  assert.equal((await store.read()).config[mode].textFontAsset, fontId)
  assert.deepEqual(ui.errors, [])
})

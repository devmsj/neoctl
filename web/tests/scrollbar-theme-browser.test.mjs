import test from 'node:test'
import assert from 'node:assert/strict'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'
import { emptyAppearance } from '../shared/appearance.mjs'
import { openGlobalSettings } from './settings-navigation.mjs'

test('scrollbars follow persisted day/night accent, preview and cancel without changing scroll behavior', async () => {
  const config = emptyAppearance(); config.mode = 'light'
  config.light = { accent: '#287b82', radius: 8 }; config.dark = { accent: '#d9a556', radius: 4 }
  const f = await createObservabilityBrowser(observabilitySnapshot({ lines: Array.from({length:30}, (_,i) => ({id:i+1,kind:'user',text:'滚动测试 '+i})) }), async route => {
    if (new URL(route.request().url()).pathname === '/api/appearance') { await route.fulfill({json:{config,revision:'1'}}); return true }
    return false
  })
  const p = f.page
  const colors = async () => { await p.mouse.move(-20, -20); return p.evaluate(() => {
    const thumb = el => getComputedStyle(el, '::-webkit-scrollbar-thumb')
    const root = document.documentElement, transcript = document.querySelector('.transcript') || document.querySelector('.workspace')
    const probe = document.createElement('i'); probe.style.backgroundColor = 'var(--scroll-thumb)'; document.body.append(probe)
    const expected = getComputedStyle(probe).backgroundColor
    probe.style.backgroundColor = 'var(--scroll-thumb-hover)'; const hover = getComputedStyle(probe).backgroundColor; probe.remove()
    // Chromium may report the hovered pseudo style for the root while a native color input is active.
    return { root:thumb(root).backgroundColor, transcript:thumb(transcript).backgroundColor, expected, hover, radius:thumb(root).borderRadius,
      hidden:getComputedStyle(document.querySelector('.quick-scroll')).scrollbarWidth,
      native:getComputedStyle(transcript).scrollbarColor, width:getComputedStyle(transcript,'::-webkit-scrollbar').width }
  }) }
  try {
    await p.waitForFunction(() => document.documentElement.style.getPropertyValue('--appearance-accent'))
    const light = await colors()
    assert.ok([light.expected,light.hover].includes(light.root)); assert.ok([light.expected,light.hover].includes(light.transcript))
    assert.equal(light.radius,'8px');assert.equal(light.width,'10px');assert.equal(light.hidden,'none');assert.equal(light.native,'auto')
    await openGlobalSettings(p); await p.locator('[data-settings-page="appearance"]').click()
    await p.getByRole('button',{name:'设计外观',exact:true}).click()
    await p.getByRole('button',{name:'颜色',exact:true}).click()
    await p.locator('#appearance-accent').fill('#b84591')
    await p.waitForFunction(before => getComputedStyle(document.documentElement,'::-webkit-scrollbar-thumb').backgroundColor !== before, light.root)
    const preview=await colors();assert.ok([preview.expected,preview.hover].includes(preview.root));assert.notEqual(preview.expected,light.expected)
    await p.locator('.appearance-editor').getByRole('button',{name:'撤销修改',exact:true}).click()
    await p.waitForFunction(() => !document.documentElement.style.getPropertyValue('--appearance-accent').includes('b84591'))
    assert.equal((await colors()).expected,light.expected)
    config.mode='dark';await p.reload()
    await p.waitForFunction(() => document.documentElement.dataset.theme === 'dark' && document.documentElement.style.getPropertyValue('--appearance-accent'))
    const dark=await colors();assert.notEqual(dark.root,light.root);assert.ok([dark.expected,dark.hover].includes(dark.root));assert.equal(dark.radius,'4px');assert.equal(dark.hidden,'none')
    await p.emulateMedia({forcedColors:'active'})
    assert.equal((await colors()).native,'auto')
    assert.deepEqual(f.errors,[])
  } finally { await f.close() }
})

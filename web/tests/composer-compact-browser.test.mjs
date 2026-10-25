import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'

test('composer retains all information, single focus outline, grouped actions and responsive disclosures', async () => {
  const cwd = 'C:\\Users\\Local\\Neo Desktop Runtime\\data\\workspaces\\261023194248'
  const model = 'gpt-6-astra'
  const current = observabilitySnapshot({ cwd, modelSettings: { model, reasoning: { effort: 'high' } }, fastMode: true,
    status: { phase: 'ready', metrics: { model, contextWindowTokens: 256000, contextUsageRatio: .47 }, usage: { inputTokens: 120000, outputTokens: 4050 } },
    catalog: { commands: [], modelIds: [model, 'gpt-5.6-sol', 'custom-model-with-a-long-name-for-layout-validation'], reasoning: ['default', 'off', 'low', 'high'] },
    appPrompt: { hasActivePrompt: true, activePrompt: { title: '代码审查', content: '检查实现与回归验证' } },
    lines: [{ id: 1, kind: 'meta', text: 'compacted', compaction: { current: true, summary: '保留实施目标和验证结果。', continuationState: '继续完成界面精调。', createdAt: new Date().toISOString(), modelDriven: true, newWindowMessages: 3, preservedUserMessages: 2, charsFreed: 12000, imageCount: 2 } }],
  })
  const fixture = await createObservabilityBrowser(() => current, async route => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/cwd/scope') { await route.fulfill({json:{ok:true,paths:[cwd]}}); return true }
    if (url.pathname === '/api/cwd') {
      const path = url.searchParams.get('path') || cwd
      await route.fulfill({ json: { cwd: path, parent: 'C:\\', entries: [{ name: 'src', path: path + '\\src', isDirectory: true }, { name: 'tests', path: path + '\\tests', isDirectory: true }], locations: [{ id: 'drive-c', kind: 'drive', label: 'C:', path: 'C:\\' }, { id: 'home', kind: 'home', label: '主目录', path: 'C:\\Users\\Local' }] } }); return true
    }
  })
  try {
    const { page } = fixture
    const composer = page.locator('.composer')
    await composer.waitFor()
    await page.waitForTimeout(500)
    await composer.getByRole('textbox', { name: '消息' }).fill('检查这次修改，保留所有信息与操作。')
    for (const theme of ['dark', 'light']) for (const width of [1720, 1440, 1000, 390, 320]) {
      await page.setViewportSize({ width, height: 950 })
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme)
      await page.mouse.move(0, 0)
      await page.waitForTimeout(200)
      assert.deepEqual(await composer.locator('.metric-chip em').allTextContents(), ['模型', '上下文', '输入', '输出'])
      assert.equal(await composer.locator('.composer-cwd').count(), 0)
      assert.match(await composer.locator('.model-chip strong').innerText(), /gpt-6-astra.*high/)
      assert.equal(await composer.locator('.session-options-toggle').count(), 0)
      for (const label of ['快速模式', '压缩会话', '上传附件', '发送 ↵']) assert.ok(await composer.getByRole('button', { name: label, exact: true }).isVisible(), label)
      const layout = await composer.evaluate(el => {
        const buttons = [...el.querySelectorAll('.composer-actions button')].map(e => { const r=e.getBoundingClientRect(), s=getComputedStyle(e); return { top:r.top, right:r.right, left:r.left, width:r.width, height:r.height, border:s.borderTopWidth } })
        const textarea=getComputedStyle(el.querySelector('textarea'))
        return { overflow: el.scrollWidth > el.clientWidth + 1, buttons, textareaBorder:textarea.borderTopWidth, textareaOutline:textarea.outlineStyle, textareaShadow:textarea.boxShadow, metrics:[...el.querySelectorAll('.metric-chip')].map(e=>({visible:e.getBoundingClientRect().height>0, border:getComputedStyle(e).borderTopWidth})), width:el.clientWidth }
      })
      assert.equal(layout.overflow, false); assert.equal(layout.textareaBorder, '0px'); assert.equal(layout.textareaOutline, 'none'); assert.equal(layout.textareaShadow, 'none')
      for (const metric of layout.metrics) { assert.ok(metric.visible); assert.equal(metric.border, '0px') }
      for (let i=0;i<layout.buttons.length;i++) { const b=layout.buttons[i]; assert.equal(b.border,'0px'); assert.equal(b.width,b.height); assert.equal(b.top,layout.buttons[0].top); if(i) assert.ok(b.left-layout.buttons[i-1].right>=4) }
      const alignment = await composer.evaluate(el => {
        const baseline = node => { const marker=document.createElement('span'); marker.style.cssText='display:inline-block;width:0;height:0;padding:0;margin:0;vertical-align:baseline'; node.append(marker); const y=marker.getBoundingClientRect().top; marker.remove(); return y }
        const chips=[...el.querySelectorAll('.metric-chip')]
        const left = selector => el.querySelector(selector).getBoundingClientRect().left
        const input=el.querySelector('textarea'), style=getComputedStyle(input)
        return { baselines: chips.map(chip=>Math.abs(baseline(chip.querySelector('em'))-baseline(chip.querySelector('strong')))), lefts:[left('.model-chip em'),left('.composer-usage em'),input.getBoundingClientRect().left+parseFloat(style.paddingLeft)], promptShadow:getComputedStyle(el.querySelector('.composer-app-prompt')).boxShadow }
      })
      for(const delta of alignment.baselines) assert.ok(delta<=1, `baseline ${theme}/${width}: ${delta}`)
      if(width<=1000) assert.ok(Math.max(...alignment.lefts)-Math.min(...alignment.lefts)<=1, JSON.stringify(alignment))
      assert.equal(alignment.promptShadow,'none')
      const statusLayout = await composer.evaluate(el => {
        const model = el.querySelector('.model-chip').getBoundingClientRect()
        const usage = [...el.querySelectorAll('.composer-usage .metric-chip')].map(node => node.getBoundingClientRect().toJSON())
        return { modelBottom: model.bottom, usage, footerBorder: getComputedStyle(el.querySelector('.composer-footer')).borderTopWidth }
      })
      assert.equal(statusLayout.footerBorder, '1px')
      for (let i=1;i<statusLayout.usage.length;i++) {
        const current=statusLayout.usage[i], previous=statusLayout.usage[i-1]
        assert.equal(current.top,previous.top,`usage shares row ${theme}/${width}`)
        assert.ok(current.left-previous.right>=6,`usage spacing ${theme}/${width}`)
      }
      if(width<=1000) assert.ok(statusLayout.usage[0].top>=statusLayout.modelBottom,`model separated from usage ${theme}/${width}`)
      await composer.screenshot({ path: join(tmpdir(), `neo-composer-refined-${theme}-${width}.png`) })
      if (![1440,390].includes(width)) continue
      await composer.getByRole('button', { name: '选择模型', exact: true }).click()
      let modal = page.getByRole('dialog', { name: '选择模型', exact: true })
      await modal.waitFor()
      assert.equal(await modal.getByRole('searchbox').evaluate(el => getComputedStyle(el).outlineStyle), 'none')
      const modelAlignment=await modal.locator('.session-model-option').evaluateAll(rows=>rows.map(row=>{const radio=row.querySelector('input').getBoundingClientRect(),text=row.querySelector('span').getBoundingClientRect();return Math.abs((radio.top+radio.bottom-text.top-text.bottom)/2)}))
      for(const delta of modelAlignment) assert.ok(delta<=1,`model center: ${delta}`)
      assert.deepEqual(await modal.locator('.context-window-actions button').allTextContents(),['',''])
      await modal.screenshot({ path: join(tmpdir(), `neo-composer-model-${theme}-${width}.png`) })
      await modal.getByRole('button', { name: '取消', exact: true }).click()
      await composer.locator('.context-window-trigger:not(.model-trigger)').click()
      modal = page.getByRole('dialog', { name: '上下文窗口', exact: true })
      await modal.waitFor()
      const inputStyle=await modal.locator('input').evaluate(el=>({border:getComputedStyle(el).borderTopWidth,outline:getComputedStyle(el).outlineStyle,shadow:getComputedStyle(el).boxShadow}))
      assert.deepEqual(inputStyle,{border:'0px',outline:'none',shadow:'none'})
      await modal.screenshot({ path: join(tmpdir(), `neo-composer-context-${theme}-${width}.png`) })
      await modal.getByRole('button', { name: '取消', exact: true }).click()
      await composer.getByRole('button', { name: '工作区范围', exact: true }).click()
       await page.getByRole('dialog', {name:'工作区范围',exact:true}).getByRole('button',{name:'添加路径',exact:true}).click()
      modal = page.getByRole('dialog', { name: '选择工作目录', exact: true })
      await modal.locator('.cwd-tree-row').first().waitFor()
      await modal.getByRole('textbox', { name: '工作目录路径' }).focus()
      assert.equal(await modal.getByRole('textbox').evaluate(el => getComputedStyle(el).outlineStyle), 'none')
      await modal.locator('.cwd-tree-toggle[aria-expanded="false"]').first().click()
      await modal.locator('.cwd-tree-branch .cwd-tree-branch .cwd-tree-branch').first().waitFor()
      assert.equal(await modal.locator('.cwd-tree-delete').count(), 0, 'read-only tree descendants keep delete disabled')
      assert.ok(await modal.evaluate(el=>el.scrollWidth<=el.clientWidth+1))
      const treeAlignment = await modal.locator('.cwd-tree-row').evaluateAll(rows => rows.map(row => {
        const rect = selector => row.querySelector(selector).getBoundingClientRect()
        const toggle=rect('.cwd-tree-toggle'), icon=rect('.cwd-tree-name svg'), text=rect('.cwd-tree-name strong')
        return { centers:[(toggle.top+toggle.bottom)/2,(icon.top+icon.bottom)/2,(text.top+text.bottom)/2], gap:text.left-icon.right }
      }))
      for(const row of treeAlignment) { assert.ok(Math.max(...row.centers)-Math.min(...row.centers)<=1,JSON.stringify(row)); assert.equal(row.gap,8) }
      assert.deepEqual(await modal.locator('.cwd-picker-actions button').allTextContents(),['',''])
      await modal.screenshot({ path: join(tmpdir(), `neo-composer-cwd-${theme}-${width}.png`) })
      await modal.getByRole('button', { name: '取消', exact: true }).click()
      await page.getByRole('dialog',{name:'工作区范围',exact:true}).getByRole('button',{name:'关闭',exact:true}).click()
      await page.locator('.compaction-context-bar').click()
      modal=page.getByRole('dialog',{name:'压缩上下文详情',exact:true})
      await modal.screenshot({path:join(tmpdir(),`neo-composer-compaction-${theme}-${width}.png`)})
      await page.keyboard.press('Escape')
      await composer.getByRole('textbox', { name: '消息' }).focus()
    }
    assert.deepEqual(fixture.errors, [])
    assert.ok(fixture.requests.every(r=>r.method==='GET'))
  } finally { await fixture.close() }
})

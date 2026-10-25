// Run after npm run build. Uses real Edge with read-only mocked API data.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'

for (const theme of ['dark', 'light']) {
  test(`${theme}: command observations omit duplicate icons in every phase`, async () => {
    let phase = 'queued'
    const command = 'node tests/example.test.mjs'
    const snapshot = () => observabilitySnapshot({ busy: true, status: { phase: 'running_tools' }, lines: [
      { id: 'command', kind: 'tool', toolName: 'terminal_run', toolUseId: 'command-call', live: true,
        activity: { phase, input: { cmd: command } }, observation: { stdout: 'visible output' } },
    ] })
    const fixture = await createObservabilityBrowser(snapshot)
    try {
      const { page } = fixture
      await page.addInitScript(value => localStorage.setItem('neoctl-web.theme', value), theme)
      for (const value of ['queued', 'generating', 'running', 'completed', 'failed', 'interrupted']) {
        phase = value
        await page.reload()
        await page.locator('.tool-activity-row').waitFor()
        // Pin explicitly to cover terminal states as well as automatic observations.
        await page.locator('.tool-activity-row').click()
        const observation = page.locator('.is-pinned')
        const row = observation.locator('.observation-command')
        await row.waitFor()
        assert.equal(await row.getAttribute('data-command-phase'), value)
        assert.equal(await row.innerText(), command)
        assert.equal(await observation.locator('.command-phase,.observation-command svg').count(), 0)
        assert.equal(await observation.locator('.command-running').count(), value === 'running' ? 1 : 0)
        assert.equal(await page.locator('.tool-activity-row > .activity-icon').count(), 1, 'keep the consistent tool-row icon')
        assert.ok((await observation.innerText()).includes('visible output'))
        const style = await row.evaluate(el => {
          const s = getComputedStyle(el)
          return { background: s.backgroundColor, padding: s.padding, border: s.borderTopWidth,
            inset: el.querySelector('pre').getBoundingClientRect().left - el.parentElement.getBoundingClientRect().left }
        })
        assert.deepEqual(style, { background: 'rgba(0, 0, 0, 0)', padding: '0px', border: '0px', inset: 0 }, `${theme}/${value}`)
      }
      assert.deepEqual(fixture.errors, [])
    } finally { await fixture.close() }
  })
}

import test from 'node:test'
import assert from 'node:assert/strict'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'

const speedSamples = now => [
  { at: now, model: 'model-a', firstTokenMs: 1200, tokensPerSecond: 60 },
  { at: now, model: 'model-a', firstTokenMs: 2400 },
  { at: now, model: 'model-b', firstTokenMs: 95_000, tokensPerSecond: 80 },
]

test('model speed: without requests the card keeps its layout, with a dashed axis and a hint', async () => {
  const f = await createObservabilityBrowser(observabilitySnapshot({ modelSpeed: { samples: [], live: [] } }))
  try {
    const speed = f.page.locator('[data-card="speed"]')
    await speed.locator('.speed-empty').waitFor()
    assert.equal(await speed.locator('.speed-empty').innerText(), '等待模型请求')
    assert.deepEqual(await speed.locator('.speed-row strong').allInnerTexts(), ['—', '—'])
    assert.equal(await speed.locator('.speed-wave-axis[data-empty]').count(), 1)
    assert.equal(Math.round((await speed.locator('.speed-chart').boundingBox()).height), 80)
    assert.equal(await speed.locator('.memory-trend-empty').count(), 0)
    // Nothing to hover yet.
    const box = await speed.locator('.speed-chart').boundingBox()
    await f.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await f.page.waitForTimeout(150)
    assert.equal(await f.page.locator('.memory-tooltip').count(), 0)
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

test('model speed: a request in flight runs a stopwatch on the axis and grows its first-token bar', async () => {
  const now = new Date().toISOString()
  const snapshot = observabilitySnapshot({ modelSpeed: { samples: speedSamples(now), live: [{ id: 'live-1', model: 'model-b', elapsedMs: 1500 }] } })
  const f = await createObservabilityBrowser(snapshot)
  try {
    const p = f.page, speed = p.locator('[data-card="speed"]')
    const timer = speed.locator('.speed-timer')
    await timer.waitFor()
    const first = await timer.innerText()
    assert.match(first, /^\d+\.\d{2} s$/)
    assert.equal(await timer.getAttribute('data-waiting'), 'true')
    const barHeight = () => speed.locator('.speed-wave-live-bar').evaluate(rect => Number(rect.getAttribute('height')))
    const before = await barHeight()
    await p.waitForTimeout(400)
    assert.ok(Number.parseFloat(await timer.innerText()) > Number.parseFloat(first))
    assert.ok(await barHeight() > before)
    // The timer stands on the axis inside its own lane: right of every completed wave, inside the chart.
    const [chart, timerBox, wavesRight] = await Promise.all([
      speed.locator('.speed-chart').boundingBox(),
      timer.boundingBox(),
      speed.locator('.speed-wave').evaluate(svg => {
        const rect = svg.getBoundingClientRect()
        return Math.max(...[...svg.querySelectorAll('.speed-wave-area')].map(area => { const box = area.getBBox(); return rect.left + (box.x + box.width) / 260 * rect.width }))
      }),
    ])
    const axisY = chart.y + chart.height * 40 / 80
    assert.ok(timerBox.x >= wavesRight && timerBox.x + timerBox.width <= chart.x + chart.width + 0.5, JSON.stringify({ chart, timerBox, wavesRight }))
    assert.ok(timerBox.y + timerBox.height <= axisY && timerBox.y >= chart.y, JSON.stringify({ timerBox, axisY }))
    // Same model as the last sample: the live slot continues its axis piece.
    assert.equal(await speed.locator('.speed-wave-axis').count(), 2)
    await p.mouse.move(timerBox.x + timerBox.width / 2, axisY + 6)
    await p.waitForFunction(() => /进行中 \d+\.\d{2} s[\s\S]*首字 等待中[\s\S]*model-b/.test(document.querySelector('.memory-tooltip')?.innerText || ''))
    assert.equal(await speed.locator('.speed-timer-count').count(), 0)
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

test('model speed: the stopwatch stops at the first token; many requests at once share the lane as thin bars', async () => {
  const now = new Date().toISOString()
  const live = Array.from({ length: 12 }, (_, index) => ({ id: `r${index}`, model: 'model-b', elapsedMs: 9000 - index * 600, ...(index < 9 ? { firstTokenMs: 800 + index * 150 } : {}) }))
  const many = Array.from({ length: 30 }, (_, index) => ({ at: now, model: 'model-b', firstTokenMs: 900 + index * 40, tokensPerSecond: 50 + index }))
  const snapshot = observabilitySnapshot({ modelSpeed: { samples: many, live } })
  const f = await createObservabilityBrowser(snapshot)
  try {
    const p = f.page, speed = p.locator('[data-card="speed"]')
    const timer = speed.locator('.speed-timer')
    await timer.waitFor()
    assert.equal(await speed.locator('.speed-wave-live-bar').count(), 12)
    assert.equal(await speed.locator('.speed-wave-live-bar[data-waiting]').count(), 3)
    assert.equal(await speed.locator('.speed-timer-count').innerText(), '×12')
    // Some are still waiting: the stopwatch follows the newest waiting request and keeps running.
    assert.equal(await timer.getAttribute('data-waiting'), 'true')
    const timerText = () => timer.evaluate(el => el.lastChild.textContent.trim())
    const before = Number.parseFloat(await timerText())
    await p.waitForTimeout(300)
    assert.ok(Number.parseFloat(await timerText()) > before)
    // Bars stay inside the lane, apart from each other, and right of the history.
    const bars = await speed.locator('.speed-wave-live-bar').evaluateAll(rects => rects.map(rect => ({ x: Number(rect.getAttribute('x')), width: Number(rect.getAttribute('width')) })))
    bars.forEach((bar, order) => { if (order) assert.ok(bar.x >= bars[order - 1].x + bars[order - 1].width, JSON.stringify(bars)) })
    assert.ok(bars[0].x >= 260 - 64 && bars.at(-1).x + bars.at(-1).width <= 260)
    // Hovering one bar tells that request's own state.
    const box = await speed.locator('.speed-chart').boundingBox()
    const barX = bar => box.x + (bar.x + bar.width / 2) / 260 * box.width
    await p.mouse.move(barX(bars[0]), box.y + box.height * 0.75)
    await p.waitForFunction(() => /进行中 \d+\.\d{2} s[\s\S]*首字 0\.8 s/.test(document.querySelector('.memory-tooltip')?.innerText || ''))
    await p.mouse.move(barX(bars.at(-1)), box.y + box.height * 0.75)
    await p.waitForFunction(() => /首字 等待中/.test(document.querySelector('.memory-tooltip')?.innerText || ''))
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

test('model speed: once every request in flight has its first token, the stopwatch stands still', async () => {
  const now = new Date().toISOString()
  const snapshot = observabilitySnapshot({ modelSpeed: { samples: speedSamples(now), live: [{ id: 'live-1', model: 'model-b', elapsedMs: 4000, firstTokenMs: 1234 }] } })
  const f = await createObservabilityBrowser(snapshot)
  try {
    const timer = f.page.locator('[data-card="speed"] .speed-timer')
    await timer.waitFor()
    assert.equal(await timer.getAttribute('data-waiting'), null)
    assert.equal(await timer.innerText(), '1.23 s')
    await f.page.waitForTimeout(300)
    assert.equal(await timer.innerText(), '1.23 s')
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

test('right panel is its own component: quota rotation, memory hover and task details still work', async () => {
  const now = new Date().toISOString()
  const agent = { kind: 'agent', taskId: 'task_rp', agentId: 'agent_rp', description: 'Subagent not listed', status: 'running', createdAt: now, progress: {} }
  const task = { kind: 'terminal', taskId: 'terminal:run_rp', type: '终端', ownerSessionId: 'obs-session', sessionId: 'run_rp', description: 'Right panel task', command: 'npm run dev', status: 'running', createdAt: now }
  const done = { ...task, taskId: 'terminal:run_done', sessionId: 'run_done', description: 'Finished task', status: 'exited', exitCode: 0, completedAt: now }
  const finishedAgent = { ...agent, taskId: 'task_old', agentId: 'agent_old', description: 'Finished subagent not listed', status: 'completed', completedAt: now }
  const snapshot = observabilitySnapshot({ session: { sessionId: 'obs-session', title: 'Right panel' }, backgroundTasks: [agent, task], backgroundTaskCount: 2, agentTaskHistory: [finishedAgent], terminalTaskHistory: [done], modelSpeed: { samples: speedSamples(now), live: [] } })
  const f = await createObservabilityBrowser(snapshot, async route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/cpa-quota') { await route.fulfill({ json: { quotas: [{ account: 'alpha@example.com', remainingPercent: 80, resetAt: now }, { account: 'beta@example.com', remainingPercent: 35, resetAt: now }], config: { url: '', hasPassword: false } } }); return true }
    if (path === '/api/memory') { await route.fulfill({ json: { current: { at: now, rss: 209715200 }, history: [{ at: '2026-01-01T00:00:00Z', rss: 104857600 }, { at: '2026-01-01T00:01:00Z', rss: 157286400 }, { at: '2026-01-01T00:02:00Z', rss: 209715200 }], sampleMs: 60000 } }); return true }
    return false
  })
  try {
    const p = f.page, panel = p.locator('.right-panel')
    await panel.locator('.quota-card-controls').waitFor()
    // Quota rotation is emitted to App, which owns the index.
    const progress = panel.locator('.quota-progress')
    assert.equal(await progress.getAttribute('aria-valuenow'), '80')
    assert.equal(await panel.locator('.quota-card-controls small').innerText(), '1/2')
    await panel.getByRole('button', { name: '下一个凭据' }).click()
    assert.equal(await progress.getAttribute('aria-valuenow'), '35')
    assert.equal(await panel.locator('.quota-card-controls small').innerText(), '2/2')
    await panel.getByRole('button', { name: '上一个凭据' }).click()
    assert.equal(await panel.locator('.quota-card-controls small').innerText(), '1/2')
    // Memory hover is local state of the panel; the tooltip floats in <body>, fully inside the window.
    const viewport = p.viewportSize()
    async function assertTooltipUnclipped() {
      const tooltip = p.locator('.memory-tooltip')
      await p.waitForFunction(() => document.querySelector('.memory-tooltip')?.style.visibility !== 'hidden')
      const rect = await tooltip.boundingBox()
      assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= viewport.width && rect.y + rect.height <= viewport.height, JSON.stringify(rect))
      assert.equal(await tooltip.evaluate(el => el.parentElement === document.body), true)
    }
    assert.equal(await panel.locator('.memory-card-head strong').innerText(), '200 MB')
    const chart = panel.locator('[data-card="memory"] .memory-chart'), box = await chart.boundingBox()
    await p.mouse.move(box.x + box.width - 2, box.y + box.height / 2)
    await p.locator('.memory-tooltip').waitFor()
    assert.match(await p.locator('.memory-tooltip strong').innerText(), /200 MB/)
    await assertTooltipUnclipped()
    await p.mouse.move(box.x + 2, box.y + box.height / 2)
    assert.match(await p.locator('.memory-tooltip strong').innerText(), /100 MB/)
    await assertTooltipUnclipped()
    await p.mouse.move(0, 0); await p.locator('.memory-tooltip').waitFor({ state: 'detached' })
    // Model speed: one wave per model (two models here), latest values above and below; hovering a
    // request highlights its column and shows its values, model and time.
    const speed = panel.locator('[data-card="speed"]')
    assert.equal(await speed.locator('.speed-wave-axis').count(), 2)
    assert.equal(await speed.locator('.speed-wave-missing').count(), 1)
    assert.equal(await speed.locator('.speed-wave-over').count(), 1)
    assert.deepEqual(await speed.locator('.speed-row strong').allInnerTexts(), ['80 tok/s', '>30 s'])
    const speedBox = await speed.locator('.speed-chart').boundingBox()
    await p.mouse.move(speedBox.x + speedBox.width - 2, speedBox.y + speedBox.height / 2)
    await p.locator('.memory-tooltip').waitFor()
    await assertTooltipUnclipped()
    assert.equal(await speed.locator('.speed-wave-hover').count(), 1)
    assert.match(await p.locator('.memory-tooltip').innerText(), /速度 80 tok\/s[\s\S]*首字 >30 s[\s\S]*model-b/)
    // The first request sits left of the newest ones (right-aligned); hovering it shows that request.
    const firstX = await speed.locator('.speed-wave').evaluate(svg => {
      const rect = svg.getBoundingClientRect(), area = svg.querySelector('.speed-wave-area').getBBox()
      return rect.left + (area.x + 1) / 260 * rect.width
    })
    await p.mouse.move(firstX, speedBox.y + speedBox.height / 2)
    await p.waitForFunction(() => /1\.2 s/.test(document.querySelector('.memory-tooltip')?.innerText || ''))
    await assertTooltipUnclipped()
    assert.match(await p.locator('.memory-tooltip').innerText(), /速度 60 tok\/s[\s\S]*首字 1\.2 s[\s\S]*model-a/)
    await p.mouse.move(0, 0); await p.locator('.memory-tooltip').waitFor({ state: 'detached' })
    // Subagents are not background tasks (they are reached via the agent switch).
    assert.doesNotMatch(await panel.locator('.background-task-section').innerText(), /not listed/)
    assert.equal(await panel.locator('.background-task-count').innerText(), '1')
    // Task entries resolve back to the live task object by key.
    await panel.locator('.background-task-summary').first().click()
    await p.locator('.background-task-detail').waitFor()
    assert.match(await p.locator('.background-task-detail').innerText(), /Right panel task/)
    await p.keyboard.press('Escape'); await p.locator('.background-task-detail').waitFor({ state: 'detached' })
    await panel.locator('summary').filter({ hasText: '最近结束' }).click()
    assert.deepEqual(await panel.locator('.background-task-history-item strong').allInnerTexts(), ['Finished task'])
    await panel.locator('.background-task-history-item').first().click()
    await p.locator('.background-task-detail').waitFor()
    assert.match(await p.locator('.background-task-detail').innerText(), /Finished task/)
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

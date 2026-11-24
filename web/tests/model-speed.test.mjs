import assert from 'node:assert/strict'
import test from 'node:test'
import { SPEED_LIVE_BARS, SPEED_LIVE_LANE, SPEED_SERIES, SPEED_WAVE_HEIGHT, SPEED_WAVE_WIDTH, formatElapsed, formatSpeed, speedFirstTokenY, latestSpeed, speedFastness, speedWave, speedWaveHit } from '../src/model-speed.mjs'

const [tokensPerSecond, firstToken] = SPEED_SERIES
const sample = (firstTokenMs, tps, model = 'm1') => ({ at: '2026-11-23T00:00:00.000Z', model, firstTokenMs, ...(tps === undefined ? {} : { tokensPerSecond: tps }) })

test('fixed log scales: speed is up, first token is down', () => {
  assert.equal(tokensPerSecond.side, 'up')
  assert.equal(firstToken.side, 'down')
  assert.equal(speedFastness(firstToken, 500), 1)
  assert.equal(speedFastness(firstToken, 30_000), 0)
  assert.equal(speedFastness(tokensPerSecond, 300), 1)
  assert.equal(speedFastness(tokensPerSecond, 1), 0)
  assert.ok(speedFastness(firstToken, 1_500) > speedFastness(firstToken, 4_000))
  assert.ok(speedFastness(tokensPerSecond, 150) > speedFastness(tokensPerSecond, 40))
})

test('values beyond the outer bound read as ">bound" and get an edge marker', () => {
  assert.equal(formatSpeed(firstToken, 95_000), '>30 s')
  assert.equal(formatSpeed(firstToken, 1_250), '1.3 s')
  assert.equal(formatSpeed(firstToken, 12_400), '12 s')
  assert.equal(formatSpeed(tokensPerSecond, 61.6), '62 tok/s')
  assert.equal(formatSpeed(tokensPerSecond, 900), '>300 tok/s')
  assert.equal(formatSpeed(tokensPerSecond, undefined), '—')
  const wave = speedWave([sample(1_000, 50), sample(95_000, 900)])
  assert.deepEqual(wave.over.map(mark => [mark.index, mark.side]), [[1, 'up'], [1, 'down']])
  assert.equal(wave.over[1].y, SPEED_WAVE_HEIGHT)
  // Clamped: the outlier sits on the edge of its side, not beyond.
  const depths = wave.waves.filter(item => item.side === 'down').flatMap(item => item.line.match(/-?\d+(\.\d+)?/g).map(Number).filter((_, i) => i % 2))
  assert.ok(Math.max(...depths) < SPEED_WAVE_HEIGHT)
})

test('one wave per model: the axis and the wave break only where the model changes', () => {
  const samples = [sample(1000, 50), sample(1200, 60), sample(1100), sample(1300, 70), sample(900, 120, 'm2'), sample(800, 130, 'm2')]
  const wave = speedWave(samples)
  assert.equal(wave.axis.length, 2)
  assert.equal(wave.waves.filter(item => item.side === 'up').length, 2)
  assert.equal(wave.waves.filter(item => item.side === 'down').length, 2)
  // The missing speed inside m1 is skipped by the line (3 points), and marked with a hollow dot.
  const m1Up = wave.waves.find(item => item.side === 'up')
  assert.equal(m1Up.line.split(' ').filter(part => part === 'M' || part === 'L').length, 3)
  assert.deepEqual(wave.missing.map(dot => dot.index), [2])
  // The model gap is wider than a slot step.
  assert.ok(wave.xs[4] - wave.xs[3] > wave.slot + 1)
  assert.equal(wave.axis[1].x2, SPEED_WAVE_WIDTH)
})

test('a single request in a model is a block; few requests stay narrow and right-aligned', () => {
  const wave = speedWave([sample(1000, 50), sample(1000, 50, 'm2')])
  assert.ok(wave.waves.every(item => item.line === '' && item.area.endsWith('Z')))
  assert.ok(wave.slot <= SPEED_WAVE_WIDTH / 12 + 0.1)
  assert.ok(wave.xs[0] > SPEED_WAVE_WIDTH / 2)
  assert.equal(Math.round(wave.xs[1] + wave.slot), SPEED_WAVE_WIDTH)
})

test('requests in flight share one lane at the right edge and turn into the wave once done', () => {
  const samples = [sample(1000, 50), sample(1200, 60)]
  const idle = speedWave(samples)
  const live = speedWave(samples, [{ id: 'live-1', model: 'm1' }])
  // The lane is a fixed width at the right edge; completed requests keep their slot and stay left of it.
  assert.deepEqual(live.lane, { x: SPEED_WAVE_WIDTH - SPEED_LIVE_LANE, width: SPEED_LIVE_LANE })
  assert.equal(live.xs.length, 2)
  assert.equal(live.slot, idle.slot)
  assert.ok(live.xs[1] + live.slot <= live.lane.x + 0.1)
  // Same model: the lane continues the last axis piece.
  assert.equal(live.axis.length, 1)
  assert.equal(live.axis[0].x2, SPEED_WAVE_WIDTH)
  assert.equal(live.liveBars.length, 1)
  const [bar] = live.liveBars
  assert.ok(bar.x >= live.lane.x && bar.x + bar.width <= SPEED_WAVE_WIDTH)
  // Another model in flight opens its own axis piece after a gap.
  assert.equal(speedWave(samples, [{ id: 'live-2', model: 'm2' }]).axis.length, 2)
  // Done: the same request is now a regular sample in the wave, at the right edge, and the lane is gone.
  const done = speedWave([...samples, sample(900, 70)])
  assert.equal(done.lane, null)
  assert.deepEqual(done.liveBars, [])
  assert.equal(Math.round(done.xs[2] + done.slot), SPEED_WAVE_WIDTH)
  assert.equal(done.waves.find(item => item.side === 'down').line.split(' ').filter(part => part === 'L').length, 2)
  // The waiting bar grows with time, up to the edge of the scale.
  assert.ok(speedFirstTokenY(3000) > speedFirstTokenY(800))
  assert.equal(speedFirstTokenY(120_000), speedFirstTokenY(30_000))
  assert.equal(formatElapsed(1234), '1.23 s')
  assert.equal(formatElapsed(65_000), '65.00 s')
})

test('many requests at once: thinner bars in the same lane, the history never narrows', () => {
  const samples = Array.from({ length: 30 }, (_, index) => sample(1000 + index * 50, 60 + index))
  const idle = speedWave(samples)
  const live = count => Array.from({ length: count }, (_, index) => ({ id: `r${index}`, model: 'm1' }))
  const three = speedWave(samples, live(3))
  const twelve = speedWave(samples, live(12))
  const many = speedWave(samples, live(40))
  // The history only gives up the lane once, whatever the concurrency.
  assert.equal(three.slot, twelve.slot)
  assert.equal(twelve.slot, many.slot)
  assert.ok(twelve.slot < idle.slot)
  // More requests: more, thinner bars, all inside the lane and never overlapping.
  assert.equal(twelve.liveBars.length, 12)
  assert.ok(twelve.liveBars[0].width < three.liveBars[0].width)
  for (const wave of [three, twelve, many]) {
    wave.liveBars.forEach((bar, order) => {
      assert.ok(bar.width >= 1)
      assert.ok(bar.x >= wave.lane.x && bar.x + bar.width <= SPEED_WAVE_WIDTH + 0.1)
      if (order) assert.ok(bar.x >= wave.liveBars[order - 1].x + wave.liveBars[order - 1].width)
    })
  }
  // Beyond the cap only the newest are drawn; `order` still points into the full list.
  assert.equal(many.liveBars.length, SPEED_LIVE_BARS)
  assert.equal(many.liveBars[0].order, 40 - SPEED_LIVE_BARS)
  assert.equal(many.liveBars.at(-1).id, 'r39')
})

test('hover picks the nearest request or bar in flight; latest value skips requests without one', () => {
  const wave = speedWave([sample(1000, 50), sample(1000, 60), sample(1000, 70, 'm2')])
  const center = index => wave.xs[index] + wave.slot / 2
  assert.deepEqual(speedWaveHit(wave, center(0)), { sample: 0 })
  assert.deepEqual(speedWaveHit(wave, center(2) + 2), { sample: 2 })
  assert.equal(speedWaveHit(wave, wave.xs[0] - wave.slot), null)
  assert.equal(speedWaveHit(speedWave([]), 10), null)
  const live = speedWave([sample(1000, 50)], [{ id: 'a', model: 'm1' }, { id: 'b', model: 'm1' }])
  const [first, second] = live.liveBars
  assert.deepEqual(speedWaveHit(live, first.hitX + first.hitWidth / 2), { live: 0 })
  assert.deepEqual(speedWaveHit(live, second.hitX + second.hitWidth / 2), { live: 1 })
  assert.deepEqual(speedWaveHit(live, SPEED_WAVE_WIDTH), { live: 1 })
  assert.deepEqual(speedWaveHit(live, live.xs[0] + live.slot / 2), { sample: 0 })
  assert.equal(latestSpeed([sample(1, 40), sample(2)], tokensPerSecond), 40)
  assert.equal(latestSpeed([], tokensPerSecond), undefined)
})

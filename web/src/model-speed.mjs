// Model speed indicator: a mirrored waveform over the latest model requests, in time order.
// Above the axis: tokens per second (taller is faster). Below: time to first token (deeper is slower).
// Both use a fixed log scale between a fast and a slow bound, so a height means the same speed in every
// session, and the color follows the height (one fast-to-slow gradient per side).
// Each model gets its own wave: a gap and a broken axis mean another model, never missing data. Inside
// one model a missing value (an output too short to measure) is skipped and marked with a hollow dot.
// A value beyond the outer bound (e.g. a very slow first token) sits on the edge, is marked, and reads
// as ">bound", never at its raw size, so one outlier cannot flatten the rest.

const seconds = ms => {
  const value = ms / 1000
  return `${value < 10 ? value.toFixed(1).replace(/\.0$/, '') : Math.round(value)} s`
}

export const SPEED_SERIES = [
  { key: 'tokensPerSecond', label: '速度', side: 'up', fast: 300, slow: 5, format: value => `${Math.round(value)} tok/s` },
  { key: 'firstTokenMs', label: '首字', side: 'down', fast: 500, slow: 30_000, format: seconds },
]

export const SPEED_WAVE_WIDTH = 260
const ROOM = 32
// 6 units above the speed side and below the first-token side keep room for the beyond-scale markers.
const AXIS = ROOM + 8
export const SPEED_WAVE_HEIGHT = AXIS + ROOM + 8
const MODEL_GAP = 10
/** At most this many request slots' width per request: a few requests stay narrow, aligned right. */
const MIN_SLOTS = 12
/** Width of the newest in-flight request's lane, in chart units: room for its stopwatch ("12.34 s"). */
export const SPEED_LIVE_LANE = 64

export function speedValue(sample, series) {
  const value = Number(sample?.[series.key])
  return Number.isFinite(value) && value > 0 ? value : undefined
}

/** Position in [0, 1] on the series' log scale: 1 at the fast bound, 0 at the slow bound, clamped. */
export function speedFastness(series, value) {
  const ratio = 1 - Math.log(value / series.fast) / Math.log(series.slow / series.fast)
  return Math.min(1, Math.max(0, ratio))
}

const outerBound = series => Math.max(series.fast, series.slow)

export function formatSpeed(series, value) {
  if (value === undefined) return '—'
  const bound = outerBound(series)
  return value > bound ? `>${series.format(bound)}` : series.format(value)
}

/** Latest measured value of a series (the newest request may lack one). */
export function latestSpeed(samples, series) {
  for (let index = samples.length - 1; index >= 0; index--) {
    const value = speedValue(samples[index], series)
    if (value !== undefined) return value
  }
  return undefined
}

const round = value => Math.round(value * 10) / 10

const offset = (series, value) => {
  const depth = Math.max(2, (series.side === 'up' ? speedFastness(series, value) : 1 - speedFastness(series, value)) * ROOM)
  return series.side === 'up' ? AXIS - 2 - depth : AXIS + 2 + depth
}

/** Bottom edge of a first-token bar of `ms` (a request in flight grows its bar while it waits). */
export function speedFirstTokenY(ms) {
  return round(offset(SPEED_SERIES[1], Math.max(1, ms)))
}

/** Live timer text: seconds with two decimals, like a stopwatch. */
export function formatElapsed(ms) {
  return `${(Math.max(0, ms) / 1000).toFixed(2)} s`
}

/** At most this many in-flight bars are drawn (the newest); the count badge still tells the total. */
export const SPEED_LIVE_BARS = 24

/**
 * Waveform layout in a SPEED_WAVE_WIDTH x SPEED_WAVE_HEIGHT box.
 *
 * Completed requests are slots (right-aligned, newest last), one axis piece and one wave per model run,
 * hollow dots for missing values and markers for values beyond the scale. Requests in flight, however
 * many, share one fixed lane at the right edge: the history never narrows because of concurrency. The lane
 * holds one thin first-token bar per request (the newest SPEED_LIVE_BARS) below the axis and leaves the
 * space above the axis free for the stopwatch.
 */
export function speedWave(samples, live = []) {
  const count = samples.length
  const lane = live.length ? SPEED_LIVE_LANE : 0
  const lastModel = samples.at(-1)?.model
  // The lane continues the last model's axis when everything in flight is that model, else a model gap.
  const laneGap = lane && count && live.some(entry => entry.model !== lastModel) ? MODEL_GAP : 0
  const area = SPEED_WAVE_WIDTH - lane - laneGap
  const switches = samples.filter((sample, index) => index && sample.model !== samples[index - 1].model).length
  const slot = Math.min((area - switches * MODEL_GAP) / Math.max(count, 1), SPEED_WAVE_WIDTH / MIN_SLOTS)
  const xs = []
  let cursor = area - (slot * count + switches * MODEL_GAP)
  samples.forEach((sample, index) => {
    if (index && sample.model !== samples[index - 1].model) cursor += MODEL_GAP
    xs.push(cursor)
    cursor += slot
  })
  const center = index => xs[index] + slot / 2
  const runs = []
  samples.forEach((sample, index) => {
    if (!index || sample.model !== samples[index - 1].model) runs.push({ start: index, end: index })
    else runs.at(-1).end = index
  })
  const waves = []
  for (const run of runs) {
    for (const series of SPEED_SERIES) {
      const points = []
      for (let index = run.start; index <= run.end; index++) {
        const value = speedValue(samples[index], series)
        if (value !== undefined) points.push({ index, x: round(center(index)), y: round(offset(series, value)) })
      }
      if (!points.length) continue
      const base = series.side === 'up' ? AXIS - 2 : AXIS + 2
      if (points.length === 1) {
        const [point] = points
        const left = round(xs[point.index] + 1)
        const right = round(xs[point.index] + slot - 1)
        waves.push({ side: series.side, area: `M ${left} ${base} L ${left} ${point.y} L ${right} ${point.y} L ${right} ${base} Z`, line: '' })
        continue
      }
      const line = points.map((point, order) => `${order ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ')
      waves.push({ side: series.side, area: `M ${points[0].x} ${base} ${line.replace(/^M/, 'L')} L ${points.at(-1).x} ${base} Z`, line })
    }
  }
  const axis = runs.map(run => ({ x1: round(xs[run.start]), x2: round(xs[run.end] + slot) }))
  const laneX = SPEED_WAVE_WIDTH - lane
  if (lane) {
    if (axis.length && !laneGap) axis.at(-1).x2 = SPEED_WAVE_WIDTH
    else axis.push({ x1: round(laneX), x2: SPEED_WAVE_WIDTH })
  }
  const [up, down] = SPEED_SERIES
  const missing = samples.flatMap((sample, index) => speedValue(sample, up) === undefined ? [{ index, x: round(center(index)), y: AXIS - 5 }] : [])
  const over = samples.flatMap((sample, index) => {
    const marks = []
    const tps = speedValue(sample, up)
    if (tps !== undefined && tps > outerBound(up)) marks.push({ index, x: round(center(index)), y: 0, side: 'up' })
    const first = speedValue(sample, down)
    if (first !== undefined && first > outerBound(down)) marks.push({ index, x: round(center(index)), y: SPEED_WAVE_HEIGHT, side: 'down' })
    return marks
  })
  // Top of each request's column (for anchoring a tooltip): its speed point, else the axis.
  const tops = samples.map(sample => {
    const tps = speedValue(sample, up)
    return round(tps === undefined ? AXIS : offset(up, tps))
  })
  // In-flight bars: one pitch per request, as wide as a history slot at most and thinner as more run at
  // once; the group is centered in the lane, oldest left, newest right.
  const shown = live.slice(-SPEED_LIVE_BARS)
  const first = live.length - shown.length
  const pitch = shown.length ? Math.min(slot, SPEED_WAVE_WIDTH / MIN_SLOTS, (lane - 8) / shown.length) : 0
  const barWidth = Math.max(1, Math.min(pitch - Math.max(1, pitch * 0.3), 10))
  const start = laneX + (lane - pitch * shown.length) / 2
  const liveBars = shown.map((entry, order) => ({
    order: first + order,
    id: entry.id,
    x: round(start + order * pitch + (pitch - barWidth) / 2),
    width: round(barWidth),
    hitX: round(start + order * pitch),
    hitWidth: round(pitch),
  }))
  return {
    slot: round(slot), xs: xs.map(round), axis, waves, missing, over, tops, axisY: AXIS, reach: ROOM + 2,
    lane: lane ? { x: round(laneX), width: lane } : null, liveBars,
  }
}

/**
 * What a pointer x (chart units) is over: { live: order } for an in-flight bar (the nearest in the lane),
 * { sample: index } for a completed request (the nearest slot), or null left of everything.
 */
export function speedWaveHit(wave, x) {
  if (wave.lane && x >= wave.lane.x - MODEL_GAP / 2 && wave.liveBars.length) {
    const distance = bar => x < bar.hitX ? bar.hitX - x : x > bar.hitX + bar.hitWidth ? x - bar.hitX - bar.hitWidth : 0
    const bar = wave.liveBars.reduce((best, item) => distance(item) < distance(best) ? item : best)
    return { live: bar.order }
  }
  if (!wave.xs.length || x < wave.xs[0] - wave.slot / 2) return null
  let best = 0
  wave.xs.forEach((left, index) => {
    if (Math.abs(left + wave.slot / 2 - x) < Math.abs(wave.xs[best] + wave.slot / 2 - x)) best = index
  })
  return { sample: best }
}

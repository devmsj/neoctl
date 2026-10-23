// Decode terminal SGR protocol only. No HTML, URL, CSS or command is accepted from output.
// stdout/stderr each own a decoder so split control sequences and style resets remain independent.
const byte = value => Number.isInteger(value) && value >= 0 && value <= 255
const indexed = index => {
  if (index < 16) return `var(--terminal-color-${index})`
  if (index >= 232) { const grey = 8 + (index - 232) * 10; return `rgb(${grey}, ${grey}, ${grey})` }
  const cube = [0, 95, 135, 175, 215, 255], n = index - 16
  return `rgb(${cube[Math.floor(n / 36)]}, ${cube[Math.floor(n / 6) % 6]}, ${cube[n % 6]})`
}
function applySgr(state, parameters) {
  // Both semicolon SGR and ISO colon RGB forms are emitted by real terminal programs.
  const groups = parameters.split(';')
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i], code = Number(group.split(':')[0] || 0)
    if (group.includes(':') && [38, 48].includes(code)) {
      const parts = group.split(':').slice(1), mode = Number(parts.shift())
      if (mode === 2) {
        // Optional colour-space identifier precedes r:g:b.
        if (parts.length === 4) parts.shift()
        const rgb = parts.map(v => v === '' ? NaN : Number(v))
        if (rgb.length === 3 && rgb.every(byte)) state[code === 38 ? 'fg' : 'bg'] = `rgb(${rgb.join(', ')})`
      } else if (mode === 5 && parts.length === 1 && parts[0] !== '' && byte(Number(parts[0]))) state[code === 38 ? 'fg' : 'bg'] = indexed(Number(parts[0]))
      continue
    }
    if (code === 0) { for (const key of Object.keys(state)) delete state[key] }
    else if (code === 1) state.bold = true
    else if (code === 2) state.dim = true
    else if (code === 3) state.italic = true
    else if (code === 4 || code === 21) state.underline = true
    else if (code === 7) state.inverse = true
    else if (code === 9) state.strike = true
    else if (code === 22) { delete state.bold; delete state.dim }
    else if (code === 23) delete state.italic
    else if (code === 24) delete state.underline
    else if (code === 27) delete state.inverse
    else if (code === 29) delete state.strike
    else if (code >= 30 && code <= 37) state.fg = indexed(code - 30)
    else if (code >= 90 && code <= 97) state.fg = indexed(code - 90 + 8)
    else if (code >= 40 && code <= 47) state.bg = indexed(code - 40)
    else if (code >= 100 && code <= 107) state.bg = indexed(code - 100 + 8)
    else if (code === 39) delete state.fg
    else if (code === 49) delete state.bg
    else if (code === 38 || code === 48) {
      const mode = Number(groups[++i]), count = mode === 2 ? 3 : mode === 5 ? 1 : 0
      const values = groups.slice(i + 1, i + 1 + count).map(v => v === '' ? NaN : Number(v))
      i += count
      if (count && values.length === count && values.every(byte)) state[code === 38 ? 'fg' : 'bg'] = mode === 5 ? indexed(values[0]) : `rgb(${values.join(', ')})`
    }
  }
}
function styleFor(state) {
  const style = {}
  if (state.fg) style.color = state.fg
  if (state.bg) style.backgroundColor = state.bg
  if (state.inverse) { style.color = state.bg || 'var(--terminal-background)'; style.backgroundColor = state.fg || 'var(--terminal-foreground)' }
  if (state.bold) style.fontWeight = '700'
  if (state.dim) style.opacity = '.7'
  if (state.italic) style.fontStyle = 'italic'
  if (state.underline || state.strike) style.textDecoration = [state.underline && 'underline', state.strike && 'line-through'].filter(Boolean).join(' ')
  return style
}
export function createTerminalAnsi({ maxChars = 40000 } = {}) {
  if (!(maxChars === Infinity || Number.isSafeInteger(maxChars) && maxChars > 0)) throw new TypeError('maxChars must be a positive integer or Infinity')
  let state = {}, mode = 'text', control = '', stringEscape = false, spans = [], length = 0
  function append(text) {
    if (!text) return
    const style = styleFor(state), key = JSON.stringify(style), last = spans.at(-1)
    if (last?.key === key) spans[spans.length - 1] = { text: last.text + text, style, key }
    else spans.push({ text, style, key })
    length += text.length
  }
  function trim() {
    let remove = length - maxChars, consumed = 0
    while (remove > 0 && consumed < spans.length) {
      const span = spans[consumed]
      if (span.text.length <= remove) { remove -= span.text.length; length -= span.text.length; consumed++ }
      else {
        let start = remove
        if (/^[\uDC00-\uDFFF]$/.test(span.text[start] || '')) start++
        spans[consumed] = { ...span, text: span.text.slice(start) }; length -= start; remove = 0
      }
    }
    if (consumed) spans = spans.slice(consumed)
  }
  return {
    push(value) {
      let plain = ''
      const flush = () => { append(plain); plain = '' }
      for (const ch of String(value ?? '')) {
        const code = ch.codePointAt(0)
        if (mode === 'string') {
          if (code === 7 || code === 0x9c || stringEscape && ch === '\\') { mode = 'text'; stringEscape = false }
          else stringEscape = code === 27
          continue
        }
        if (mode === 'escape') {
          if (ch === '[') { mode = 'csi'; control = '' }
          else if ([']', 'P', 'X', '^', '_'].includes(ch)) { mode = 'string'; stringEscape = false }
          else if (code >= 0x30 && code <= 0x7e) mode = 'text'
          continue
        }
        if (mode === 'csi') {
          if (code >= 0x40 && code <= 0x7e) {
            if (ch === 'm' && /^[\d;:]*$/.test(control)) applySgr(state, control)
            mode = 'text'; control = ''
          } else if (code === 27) { mode = 'escape'; control = '' }
          else if (control.length < 512) control += ch
          else control = '!'
          continue
        }
        if (code === 27 || code === 0x9b || [0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(code)) {
          flush(); mode = code === 27 ? 'escape' : code === 0x9b ? 'csi' : 'string'; control = ''; stringEscape = false
        } else if (ch === '\n' || ch === '\t' || code >= 32 && !(code >= 0x7f && code <= 0x9f)) plain += ch
      }
      flush(); trim()
      return spans.slice()
    },
    reset() { state = {}; mode = 'text'; control = ''; stringEscape = false; spans = []; length = 0 },
  }
}
export function terminalAnsiSegments(text) {
  return createTerminalAnsi({ maxChars: Infinity }).push(text)
}

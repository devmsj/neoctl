import katex from 'katex'

const escapeHtml = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const placeholder = (tex, display) => `<code class="language-neo-math-${display ? 'display' : 'inline'}">${escapeHtml(tex)}</code>`

// Tokenize before Markdown can consume TeX backslashes/underscores. The output is
// inert code until AFTER the host sanitizer; no extra HTML/SVG whitelist is needed.
export const mathExtensions = [
  {
    name: 'mathBlock', level: 'block',
    start(source) { return source.search(/^(?: {0,3})(?:\$\$|\\\[)/m) },
    tokenizer(source) {
      const match = /^(?: {0,3})(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])(?:[ \t]*(?:\n|$))/.exec(source)
      if (!match) return
      return { type: 'mathBlock', raw: match[0], text: (match[1] ?? match[2]).trim() }
    },
    renderer(token) { return `<pre>${placeholder(token.text, true)}</pre>\n` },
  },
  {
    name: 'mathInline', level: 'inline',
    start(source) { return source.search(/\$|\\\(/) },
    tokenizer(source) {
      const parens = /^\\\(([^\n]+?)\\\)/.exec(source)
      if (parens) return { type: 'mathInline', raw: parens[0], text: parens[1], display: false }
      const display = /^\$\$([^\n]+?)\$\$/.exec(source)
      if (display) return { type: 'mathInline', raw: display[0], text: display[1], display: true }
      // No opening/closing whitespace, newline, or numeric suffix: ordinary
      // prices such as "$5 and $10" and escaped dollars remain plain text.
      if (source[0] !== '$' || source[1] === '$' || /\s/.test(source[1] || ' ')) return
      for (let i = 1; i < source.length && source[i] !== '\n'; i++) {
        if (source[i] === '\\') { i++; continue }
        if (source[i] !== '$') continue
        if (/\s/.test(source[i - 1]) || /[\d$]/.test(source[i + 1] || '')) return
        return { type: 'mathInline', raw: source.slice(0, i + 1), text: source.slice(1, i), display: false }
      }
    },
    renderer(token) { return placeholder(token.text, token.display) },
  },
]

export function mathHtml(tex, displayMode) {
  if (tex.length > 8000) throw new Error('Formula too long')
  return katex.renderToString(tex, {
    displayMode, throwOnError: true, trust: false, strict: 'ignore',
    maxExpand: 200, maxSize: 20, output: 'htmlAndMathml',
  })
}

export function renderMath(root) {
  for (const code of root.querySelectorAll('code.language-neo-math-inline, code.language-neo-math-display')) {
    const tex = code.textContent || ''
    const displayMode = code.classList.contains('language-neo-math-display')
    const node = code.ownerDocument.createElement('span')
    node.className = displayMode ? 'math-expression math-display' : 'math-expression'
    if (displayMode) { node.tabIndex = 0; node.setAttribute('role', 'region'); node.setAttribute('aria-label', '数学公式') }
    try {
      node.innerHTML = mathHtml(tex, displayMode)
    } catch {
      // Invalid/incomplete streamed formulas stay readable, never execute HTML.
      node.classList.add('math-fallback')
      node.textContent = displayMode ? '$$' + tex + '$$' : '$' + tex + '$'
      node.title = '公式暂无法解析，显示原文'
    }
    const target = code.parentElement?.tagName === 'PRE' ? code.parentElement : code
    target.replaceWith(node)
  }
}

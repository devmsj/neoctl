import hljs from 'highlight.js/lib/core'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import python from 'highlight.js/lib/languages/python'
import bash from 'highlight.js/lib/languages/bash'
import json from 'highlight.js/lib/languages/json'
import css from 'highlight.js/lib/languages/css'
import xml from 'highlight.js/lib/languages/xml'
import markdown from 'highlight.js/lib/languages/markdown'
import yaml from 'highlight.js/lib/languages/yaml'
import diff from 'highlight.js/lib/languages/diff'

hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('js', javascript)
hljs.registerLanguage('jsx', javascript)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('ts', typescript)
hljs.registerLanguage('tsx', typescript)
hljs.registerLanguage('python', python)
hljs.registerLanguage('py', python)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('sh', bash)
hljs.registerLanguage('shell', bash)
hljs.registerLanguage('json', json)
hljs.registerLanguage('css', css)
hljs.registerLanguage('html', xml)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('vue', xml)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('md', markdown)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('yml', yaml)
hljs.registerLanguage('diff', diff)

export function normalizeCodeLanguage(className) {
  const match = /(?:^|\s)language-([\w-]+)/.exec(className || '') || /(?:^|\s)lang-([\w-]+)/.exec(className || '')
  if (!match) return ''
  const value = match[1].toLowerCase()
  const aliases = {
    cjs: 'javascript',
    mjs: 'javascript',
    node: 'javascript',
    shell: 'bash',
    zsh: 'bash',
    powershell: 'bash',
    ps1: 'bash',
    python3: 'python',
    yml: 'yaml',
    html: 'xml',
    vue: 'xml',
  }
  return aliases[value] || value
}


export function highlightSource(source, language, auto = true) {
  // Keep completed/history rendering bounded too; large blocks remain readable.
  if (source.length > 100000) return undefined
  try {
    const result = language && hljs.getLanguage(language)
      ? hljs.highlight(source, { language, ignoreIllegals: true })
      : auto && source.length <= 20000 ? hljs.highlightAuto(source) : undefined
    return result ? { html: result.value, language: result.language || language } : undefined
  } catch { return undefined }
}

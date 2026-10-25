import { highlightSource } from './code-highlight.mjs'

self.onmessage = ({ data: { id, source, language } }) => {
  const start = performance.now()
  const result = highlightSource(source, language, !language)
  self.postMessage({ id, ...result, duration: performance.now() - start })
}

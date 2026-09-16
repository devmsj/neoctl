// Legacy engine image.src is an original only on these known resource endpoints.
// Never treat arbitrary preview/thumbnail URLs as originals.
export function originalImageResource(item, dataUrl = '') {
  const explicit = item?.originalSrc || item?.original?.src || item?.originalUrl || dataUrl
  if (explicit) return explicit
  const src = item?.src
  if (typeof src !== 'string') return ''
  if (/^data:image\//i.test(src)) return src
  try {
    const url = new URL(src, 'http://localhost')
    if (/\/api\/images\/(?:by-id\/[^/]+|[^/]+\/\d+)$/.test(url.pathname) && !url.searchParams.has('thumbnail')) return src
  } catch {}
  return ''
}

export function generatedImageMetadata(line, item) {
  const images = line?.imageResult?.images
  if (!Array.isArray(images) || !item?.label) return undefined
  const matches = images.filter(image => image?.label === item.label)
  // Never assign metadata by position: image lists may be deduplicated/reordered.
  return matches.length === 1 ? matches[0] : undefined
}

export function alphaChannelLabel(value) {
  return value === true ? '有' : value === false ? '无' : '未知'
}

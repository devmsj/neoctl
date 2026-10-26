// Inspect content rather than trusting browser/OS MIME metadata. No size ceiling.
export function imageMimeFromBytes(bytes) {
  const b = new Uint8Array(bytes), ascii = (a, z) => String.fromCharCode(...b.slice(a, z))
  if (b[0] === 137 && ascii(1, 4) === 'PNG' && b[4] === 13 && b[5] === 10) return 'image/png'
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg'
  if (['GIF87a', 'GIF89a'].includes(ascii(0, 6))) return 'image/gif'
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp'
  if (ascii(0, 2) === 'BM') return 'image/bmp'
  if (/<svg[\s>]/i.test(new TextDecoder().decode(b))) return 'image/svg+xml'
  return ''
}
export async function imageFileType(file) {
  const actual = imageMimeFromBytes(await file.slice(0, 1024).arrayBuffer())
  if (actual) return actual
  if (String(file.type).startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg|avif|heic|tiff?)$/i.test(file.name || '')) {
    throw new Error(`${file.name || '图片'}：无法识别图片内容，请重新导出后添加`)
  }
  return ''
}

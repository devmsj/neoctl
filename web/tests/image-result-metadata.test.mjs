import test from 'node:test'
import assert from 'node:assert/strict'
import { originalImageResource, generatedImageMetadata, alphaChannelLabel } from '../src/image-result-metadata.mjs'

test('legacy engine originals are recognized, thumbnails never become originals', () => {
  for (const src of ['/api/images/by-id/img_1', '/api/images/message-id/1?sessionId=a', '/neo/api/images/by-id/img_2?ownerUsername=user']) assert.equal(originalImageResource({ src }), src)
  for (const item of [{ thumbnailSrc: '/thumb.png' }, { previewUrl: '/preview.png' }, { src: '/thumb.png' }, { src: '/api/images/by-id/img_1/thumbnail' }, { src: '/api/images/by-id/img_1?thumbnail=1' }]) assert.equal(originalImageResource(item), '')
  assert.equal(originalImageResource({ src: '/thumb', originalSrc: '/original' }), '/original')
  assert.equal(originalImageResource({ originalUrl: '/explicit-original' }), '/explicit-original')
})

test('metadata binds only to unambiguous labels; false is not unknown', () => {
  const line = { imageResult: { images: [{ label: 'opaque', hasAlphaChannel: true, hasTransparentPixels: false }, { label: 'transparent', hasAlphaChannel: true, hasTransparentPixels: true }] } }
  assert.equal(generatedImageMetadata(line, { label: 'opaque' }).hasTransparentPixels, false)
  assert.equal(generatedImageMetadata(line, { label: 'missing' }), undefined)
  assert.equal(generatedImageMetadata({ imageResult: { images: [{ label: 'x' }, { label: 'x' }] } }, { label: 'x' }), undefined)
  assert.equal(alphaChannelLabel(false), '无'); assert.equal(alphaChannelLabel(true), '有'); assert.equal(alphaChannelLabel(undefined), '未知')
})

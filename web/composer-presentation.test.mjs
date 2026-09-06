import test from 'node:test'
import assert from 'node:assert/strict'
import { formatModelDisplay } from './src/composer-presentation.mjs'

test('model display keeps the live reasoning effort next to the model name', () => {
  assert.equal(formatModelDisplay('gpt-5.6-sol', 'high'), 'gpt-5.6-sol（high）')
  assert.equal(formatModelDisplay(' gpt-5.6-sol ', ' xhigh '), 'gpt-5.6-sol（xhigh）')
})

test('model display omits empty reasoning effort and handles an unconfigured model', () => {
  assert.equal(formatModelDisplay('gpt-5.6-sol', undefined), 'gpt-5.6-sol')
  assert.equal(formatModelDisplay('gpt-5.6-sol', '  '), 'gpt-5.6-sol')
  assert.equal(formatModelDisplay('', 'high'), '模型未配置')
})

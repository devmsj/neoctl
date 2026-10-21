import test from 'node:test'
import assert from 'node:assert/strict'
import { executionLabel } from '../src/execution-label.mjs'

test('timer labels are short and have no dot separators or ellipses', () => {
  const cases = [
    [{ runState: 'paused' }, '已暂停'], [{ runState: 'interrupted' }, '已中断'],
    [{ runState: 'resuming' }, '恢复中'], [{ loading: true }, '加载会话'],
    [{ phase: 'compacting' }, '压缩中'], [{ phase: 'running_tools' }, '执行工具'],
    [{ phase: 'calling_model' }, '调用模型'], [{ phase: 'calling_model', outputKind: 'text' }, '生成回复'],
    [{ phase: 'calling_model', outputKind: 'tool_call' }, '准备工具'],
    [{ image: true }, '生成图片'], [{ image: true, imagePending: true }, '加载图片'],
    [{ image: true, imageQueued: true }, '排队中'], [{ phase: 'thinking' }, '思考中'],
    [{ phase: 'injecting_context' }, '更新上下文'], [{ phase: 'unknown' }, '处理中'],
  ]
  for (const [input, expected] of cases) {
    const label = executionLabel(input)
    assert.equal(label, expected)
    assert.doesNotMatch(label, /[.·•…。]/u)
    assert.ok(label.length <= 5)
  }
})

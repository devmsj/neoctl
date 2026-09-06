import test from 'node:test'
import assert from 'node:assert/strict'
import { agentTaskResult, agentTaskArchives, agentTaskDelivery, agentToolStatus, agentTaskNeedsResume } from './src/agent-task-presentation.mjs'

test('running generation never exposes stale result; archives are separate and bounded', () => {
 const task = { status: 'running', runGeneration: 5, result: { content: 'old' }, runHistory: Array.from({length:5},(_,i)=>({runGeneration:i+1,status:'completed',result:{content:'old'}})) }
 assert.equal(agentTaskResult(task), '')
 assert.deepEqual(agentTaskArchives(task).map(x => x.runGeneration), [4,3,2])
 assert.equal(agentTaskResult(agentTaskArchives(task)[0]), 'old')
 assert.match(agentTaskResult({status:'completed',result:{content:'preview',truncated:true}}), /预览已截断/)
})
test('retained delivery count is independent of cropped receipts; missing fields are unknown', () => {
 assert.deepEqual(agentTaskDelivery({runGeneration: 2, pendingMessageCount: 1, deliveredRetainedThisRun: 128, messageReceipts: []}), {queued:1,delivered:128})
 assert.deepEqual(agentTaskDelivery({}), {queued:'未提供',delivered:'未提供'})
 assert.equal(agentTaskNeedsResume({status:'completed',pendingMessageCount:1}),true)
 assert.equal(agentTaskNeedsResume({status:'running',pendingMessageCount:1}),false)
})
test('queued for resume and unknown are never green completed', () => {
 const line={toolName:'subagent_message', toolDisplay:{facts:[{label:'任务状态',value:'queued_for_resume'}]}}
 assert.equal(agentToolStatus(line).label, '待续跑')
 assert.equal(agentToolStatus(line).key, 'running')
 assert.equal(agentToolStatus({...line,titleStatus:'failure'}).label,'调用失败')
 assert.equal(agentToolStatus({toolName:'subagent_run'}).key,'unknown')
 assert.equal(agentToolStatus({...line,toolDisplay:{facts:[{label:'任务状态',value:'future_status'}]}}).key,'unknown')
})

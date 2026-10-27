import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
process.env.NEO_CORE_SOURCE='local'
process.env.NEO_EXECUTION_BACKEND='local'
const {createWebRuntime,WebRepl,WebRuntimeRouter,handleWebRequest}=await import('../core-runtime.mjs')
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='
test('queue previews are small, scoped and reloadable; activity query never restores extra sessions',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'neo-queue-preview-'))
 const first=new WebRepl(await createWebRuntime({cwd:root,sessionRootDir:root}))
 const second=new WebRepl(await createWebRuntime({cwd:root,sessionRootDir:root}))
 const router=new WebRuntimeRouter({createRuntime:()=>assert.fail('status query must not restore anything')})
 router.repls.set('session:first',Promise.resolve(first));router.repls.set('session:second',Promise.resolve(second))
 const server=http.createServer((req,res)=>void handleWebRequest(req,res,router))
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(root,{recursive:true,force:true})})
 const base=`http://127.0.0.1:${server.address().port}`
 const request=(url)=>fetch(base+url)
 first.busy=true
 const imageId='image_11111111-1111-4111-a111-111111111111'
 await first.submit('next\n\n[img#1]',[{kind:'image',imageId,label:'[img#1]',mimeType:'image/png',data:png},{kind:'file',name:'report.txt',size:7,mimeType:'text/plain',absolutePath:path.join(root,'report.txt')}])
 const snap=first.snapshot();assert.equal(snap.queuedAttachments.length,2)
 assert.equal(JSON.stringify(snap.queuedAttachments).includes(png),false)
 assert.deepEqual(snap.queuedAttachments[1],{kind:'file',name:'report.txt'})
 const preview=snap.queuedAttachments[0].previewUrl
 const image=await request(preview+'?sessionId=first');assert.equal(image.status,200);assert.equal(image.headers.get('content-type'),'image/png')
 assert.equal((await request(preview+'?sessionId=second')).status,404)
 assert.equal((await (await request('/api/state?sessionId=first')).json()).queuedAttachments[0].previewUrl,preview)
 const ids=await (await request('/api/sessions/running')).json()
 assert.deepEqual(ids.runningSessionIds,[first.runtime.engine.snapshot().session.sessionId])
 assert.equal(router.repls.size,2)
 first.busy=false
 assert.deepEqual((await (await request('/api/sessions/running')).json()).runningSessionIds,[])
 await first.cancelQueue()
 assert.equal((await request(preview+'?sessionId=first')).status,404)
})

import test from "node:test";
import assert from "node:assert/strict";
import { pngPixel } from "../fixtures/png-pixel.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateImageBytes, validateImageInput } from "../../src/core/image-input.js";
import { persistMessageImages, resolveImageBlockDataSync } from "../../src/core/image-storage.js";
import { SessionImageStore } from "../../src/core/session-images.js";
import { SessionStore } from "../../src/session/session-store.js";
import { createLoadImageTool } from "../../src/tools/builtins/image-loader-tool.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { InMemoryAppState } from "../../src/app/app-state.js";
import { buildResponsesInput } from "../../src/model/openai-mappers.js";
import { createTextMessage, type MessageBlock } from "../../src/types/messages.js";
import { messageFileAttachments } from "../../src/web/file-attachments.js";


const png=pngPixel().toString('base64');
test('actual bytes override misleading MIME without transcoding',()=>{
  assert.equal(validateImageInput(`data:image/jpeg;base64,${png}`).mimeType,'image/png');
  assert.equal(validateImageInput(png).data,png);
  for(const bad of [Buffer.from('<html>error</html>'),Buffer.from('{"error":"oops"}'),pngPixel().subarray(0,40)])assert.throws(()=>validateImageBytes(bad));
  const corrupt=pngPixel();corrupt[45]^=1;assert.throws(()=>validateImageBytes(corrupt));
});
test('no new encoded size ceiling: valid PNG with a large ancillary chunk',()=>{
  // Trailing bytes do not alter valid PNG pixels; this exceeds the separate generated-output limit.
  const bytes=Buffer.concat([pngPixel(),Buffer.alloc(51*1024*1024)]);
  assert.equal(validateImageBytes(bytes),'image/png');
});
test('durable image identity and exact model payload survive reopen; invalid history is safe',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'neo-input-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const block:MessageBlock={type:'image',imageId:'image_00000000-0000-4000-a000-000000000001',label:'[img#1]',mimeType:'image/png',data:png};
  const [stored]=await persistMessageImages([block],{sessionDir:dir});assert.equal(stored.type,'image');if(stored.type!=='image')return;
  assert.equal(resolveImageBlockDataSync(stored),png);assert.equal(stored.imageId,block.imageId);
  assert.deepEqual((await persistMessageImages([stored],{sessionDir:dir}))[0],stored);
  const request=(b:MessageBlock)=>buildResponsesInput([{...createTextMessage('user',''),id:'stable',blocks:[b]}]);
  assert.deepEqual(request(block),request(stored));
  const source={...createTextMessage('user',''),blocks:[stored]};
  const session=await SessionStore.open({rootDir:dir,sessionId:'reopen',agentId:'main'});session.recordMessage(source);
  const reopened=await SessionStore.open({rootDir:dir,sessionId:'reopen',agentId:'main',resume:true});
  assert.deepEqual(request(reopened.getInitialMessages()[0].blocks[0]),request(stored));
  const bad={...block,data:Buffer.from('not a PNG').toString('base64')};
  assert.doesNotThrow(()=>request(bad));assert.ok(!JSON.stringify(request(bad)).includes('input_image'));
  await assert.rejects(persistMessageImages([bad],{sessionDir:dir}));
});
test('image_inspect corrects a false extension and isolates bad refs without poisoning registry',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'neo-inspect-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const good=path.join(dir,'wrong.jpg'), bad=path.join(dir,'bad.png');await fs.writeFile(good,pngPixel());await fs.writeFile(bad,'not image');
  const imageStore=await SessionImageStore.open(dir);
  const context={agentId:'test',imageStore,tools:new ToolRegistry(),appState:new InMemoryAppState('test',dir),messages:[],emit(){}};
  const result=await createLoadImageTool().call!({imageRefs:[bad,good]},context,{});
  assert.equal(result.ok,true);const output=result.output as {loadedImages:{mimeType:string}[];failedRefs:string[]};
  assert.equal(output.loadedImages.length,1);assert.equal(output.failedRefs.length,1);assert.equal(output.loadedImages[0].mimeType,'image/png');
});
test('legacy malformed inline image does not prevent session catalog migration',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'neo-old-image-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const message={...createTextMessage('user',''),blocks:[{type:'image',data:Buffer.from('bad').toString('base64'),mimeType:'image/png'}]};
  await fs.writeFile(path.join(dir,'transcript.jsonl'),JSON.stringify({type:'message',message})+'\n');
  await assert.doesNotReject(SessionImageStore.open(dir));
});
test('file display metadata recovers from unchanged transcript across restart',()=>{
  const location=path.resolve('report.txt');
  const message=createTextMessage('user',`review\n<<ATTACHMENT_MANIFEST>>\nFiles attached by the user for this turn:\n- file1: report.txt\n  path: ${location}\n  mimeType: text/plain\n  size: 42 bytes\n<</ATTACHMENT_MANIFEST>>`);
  const original=JSON.stringify(message), files=messageFileAttachments(message);
  assert.equal(files.length,1);assert.equal(files[0].size,42);assert.equal(files[0].absolutePath,location);
  assert.deepEqual(messageFileAttachments(JSON.parse(original)),files);assert.equal(JSON.stringify(message),original);
  assert.deepEqual(messageFileAttachments({...message,role:'assistant'}),[]);
});

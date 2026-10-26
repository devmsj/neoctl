import test from 'node:test';
import assert from 'node:assert/strict';
import { imageFileType } from '../src/attachment-input.mjs';
import { openResource, openExternalLink } from '../src/local-resources.mjs';

test('image classification follows bytes even with an unrelated extension or MIME', async () => {
  const jpeg = new File([new Uint8Array([255,216,255,224,0,16])], 'wrong.png', { type: 'image/png' });
  assert.equal(await imageFileType(jpeg), 'image/jpeg');
  assert.equal(await imageFileType(new File([jpeg], 'photo.dat')), 'image/jpeg');
  assert.equal(await imageFileType(new File(['notes'], 'notes.txt', {type:'text/plain'})), '');
  await assert.rejects(imageFileType(new File(['<html>error</html>'], 'bad.png')), /无法识别/);
});
test('desktop opens the original file, browser does not invoke the native bridge', async () => {
  const calls=[];
  const scope={location:{origin:'http://127.0.0.1:1234'},__TAURI__:{core:{invoke:async (...args)=>calls.push(args)}}};
  await openResource('/api/message-files/a/0', {scope, fetch:async (_url, init)=>{
    assert.equal(init.method,'HEAD');
    return new Response(null,{headers:{'X-Neo-Resource-Path':encodeURIComponent('C:\\files\\report.txt')}});
  }});
  assert.deepEqual(calls,[['plugin:local-resources|reveal_file',{path:'C:\\files\\report.txt'}]]);
  assert.equal(await openResource('/file',{scope:{},fetch:()=>assert.fail()}),false);
});
test('external links use the system browser and reject executable protocols', async () => {
  const calls=[];const scope={__TAURI__:{core:{invoke:async(...args)=>calls.push(args)}}};
  await openExternalLink('https://example.com/a',scope);
  assert.equal(calls[0][0],'plugin:local-resources|open_external');
  for(const url of ['file:///C:/bad.exe','javascript:alert(1)','https://user:pass@example.com'])await assert.rejects(openExternalLink(url,scope));
  assert.equal(calls.length,1);
});

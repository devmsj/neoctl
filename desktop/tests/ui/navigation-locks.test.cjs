const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=name=>fs.readFileSync(path.join(__dirname,'../../src-tauri/src',name),'utf8');
test('window authorization releases runtime mutex before dispatching WebView URL reads',()=>{
 const authorize=read('desktop_chrome.rs').split('fn authorize(')[1].split('#[derive')[0];
 assert.match(authorize,/let runtime = \{[\s\S]*?let guard = state\.runtime_url\.lock\(\)[\s\S]*?guard\.clone\(\)\s*\};\s*let current = window\.url\(\)/);
 assert.match(authorize,/trusted_page\(/,'origin authorization must not be removed');
 const local=read('local_resources.rs').split('fn authorize(')[1].split('#[tauri::command]')[0];
 assert.match(local,/\.clone\(\);\s*let current = window\.url\(\)/);
});
test('file-drop subscription commands do not block native UI message dispatch',()=>{
 const source=read('local_file_drop.rs');
 for(const name of ['watch_file_drops','unwatch_file_drops']){
  assert.match(source,new RegExp('async fn '+name+'\\('));
  assert.match(source.split('async fn '+name+'(')[1].split('#[tauri::command]')[0],/local_resources::authorize\(&window\)\?/);
 }
});

const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const root=path.resolve(__dirname,'../..');
test('native glass starts from zero RGB/alpha; no additive backing color survives clear mode',()=>{
 const config=JSON.parse(fs.readFileSync(path.join(root,'src-tauri/tauri.conf.json'),'utf8'));
 const main=config.app.windows.find(w=>w.label==='main');assert.equal(main.transparent,true);assert.equal(main.backgroundColor,'#00000000');
 const source=fs.readFileSync(path.join(root,'src-tauri/src/desktop_chrome.rs'),'utf8');
 assert.match(source,/let surface = if transparent \{ tauri::window::Color\(0, 0, 0, 0\) \}/);
 assert.match(source,/webview\.window\(\)\.set_background_color\(Some\(surface\)\)/);
 assert.match(source,/webview\.set_background_color\(Some\(surface\)\)/);
 assert.match(source,/DwmSetWindowAttribute\(hwnd, 38, &none/);
 assert.match(source,/else if frost > 0 \{ 4 \}/);
 assert.doesNotMatch(source,/let acrylic: u32 = 3|WCA_FORCE_ACTIVEWINDOW/);
 assert.doesNotMatch(source,/accent\.state = 3|2 \+ frost/);
});

test('system appearance clears native forced scheme and observes mode-only changes',()=>{
 const source=fs.readFileSync(path.join(root,'src-tauri/src/desktop_chrome.rs'),'utf8');
 assert.match(source,/Some\("system"\) => None/);
 assert.match(source,/AppsUseLightTheme/);
 assert.match(source,/RegGetValueW/);
 assert.match(fs.readFileSync(path.join(root,'src-tauri/build.rs'),'utf8'), /"system_theme"/);
 assert.ok(JSON.parse(fs.readFileSync(path.join(root,'src-tauri/capabilities/desktop-chrome.json'),'utf8')).permissions.includes('desktop-chrome:allow-system-theme'));
 const script=fs.readFileSync(path.join(root,'ui/window-chrome.js'),'utf8');
 assert.match(script,/frost: Math.round\(frost\), themeMode/);
 assert.match(script,/attributeFilter: \['data-theme', 'data-appearance-mode', 'style', 'class'\]/);
});

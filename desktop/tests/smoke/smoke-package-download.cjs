// Real npm/download smoke in a throwaway directory, never touches installed runtimes.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'neo-download-'));
const desktop=path.resolve(__dirname,'../..'),node=path.join(desktop,'resources/node/node.exe'),npm=path.join(desktop,'resources/node/node_modules/npm/bin/npm-cli.js');
const script=fs.readFileSync(path.join(desktop,'src-tauri/src/package-download.cjs'),'utf8');
const project=path.join(root,'project');fs.mkdirSync(project);fs.writeFileSync(path.join(project,'package.json'),JSON.stringify({name:'neo-download-smoke',version:'1.0.0',private:true,dependencies:{'is-number':'7.0.0',ms:'2.1.3'}}));
const env={...process.env};for(const key of Object.keys(env))if(/^(npm_config_|node_options$|node_path$)/i.test(key))delete env[key];
Object.assign(env,{npm_config_cache:path.join(root,'cache'),npm_config_userconfig:path.join(root,'user.npmrc'),npm_config_globalconfig:path.join(root,'global.npmrc')});
fs.writeFileSync(env.npm_config_userconfig,'');fs.writeFileSync(env.npm_config_globalconfig,'');
try{for(const offline of [false,true]){
 const result=spawnSync(node,['-e',script,npm,project],{env:{...env,...(offline?{npm_config_offline:'true'}:{})},encoding:'utf8',timeout:180000,maxBuffer:4*1024*1024});
 fs.writeFileSync(path.join(desktop,'.cache',`download-smoke-${offline?'cached':'network'}.txt`),result.stdout+'\n'+result.stderr);
 assert.equal(result.status,0,result.stderr);
 const events=result.stdout.split(/\r?\n/).filter(l=>l.startsWith('@neo-progress ')).map(l=>JSON.parse(l.slice(14)));
 const counted=events.filter(e=>e.completed);assert.equal(counted.length,2);assert.equal(counted.at(-1).completed,2);assert.equal(counted.at(-1).total,2);assert.equal(events.at(-1).percent,80);
 assert.equal(JSON.parse(fs.readFileSync(path.join(project,'node_modules/is-number/package.json'))).version,'7.0.0');
 console.log('PASS real npm '+(offline?'offline verified cache reuse':'network download')+': 2/2 packages, ci complete');
}}finally{fs.rmSync(root,{recursive:true,force:true});}

import assert from "node:assert/strict";
import test from "node:test";
import { ExecProcessManager } from "../../src/tools/builtins/exec-process-manager.js";

test("abort kills current foreground command without waiting for exit, not unrelated terminals", async t => {
  const manager = new ExecProcessManager();
  t.after(async () => {
    manager.terminateAll();
    await Promise.all(manager.list().map(item => manager.interact(item.session_id, { yieldTimeMs: 3000 })));
  });
  const options = { command: 'setInterval(() => {}, 1000)', cwd: process.cwd(),
    shell: { requested: "node", file: process.execPath, args: ["-e"] }, env: {},
    timeoutMs: 10000, maxOutputChars: 4000, tty: false };
  const background = await manager.execute(options, 0);
  const abort = new AbortController();
  const running = manager.execute(options, 10000, undefined, abort.signal);
  abort.abort("user pause");
  const result = await Promise.race([running, new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error("abort waited for process completion")), 1000); timer.unref();
  })]);
  assert.equal(manager.list().find(item => item.session_id === background.session_id)?.status, "running");
  const finished = await manager.interact(result.session_id, { yieldTimeMs: 3000 });
  assert.equal(finished.status, "killed");
});

test('silent process exposes its real identity immediately at spawn',async t=>{
 const manager=new ExecProcessManager();t.after(()=>manager.terminateAll());let identity='';
 const options={command:'setInterval(() => {}, 1000)',cwd:process.cwd(),shell:{requested:'node',file:process.execPath,args:['-e']},env:{},timeoutMs:10000,maxOutputChars:4000,tty:false};
 const running=manager.execute(options,0,undefined,undefined,id=>{identity=id;assert.ok(manager.list().some(run=>run.session_id===id))});
 assert.ok(identity);const result=await running;assert.equal(result.session_id,identity);
 manager.terminateAll();await manager.interact(identity,{yieldTimeMs:3000});
});

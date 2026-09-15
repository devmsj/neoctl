import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.NEO_CORE_SOURCE = 'local';
process.env.NEO_EXECUTION_BACKEND = 'local';
const { createWebRuntime, WebRepl } = await import('./core-runtime.mjs');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

for (const action of ['queue', 'draft', 'stop']) {
  test(`${action}: waits for aborted engine cleanup before starting another query`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-interrupt-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const runtime = await createWebRuntime({ cwd: root, sessionRootDir: root });
    const repl = new WebRepl(runtime);
    const aborted = deferred(), cleanup = deferred(), secondStarted = deferred(), finish = deferred();
    const prompts = [];
    let running = false;
    runtime.engine.sendUserText = async function* (text, options) {
      assert.equal(running, false, 'query engine must not overlap');
      running = true;
      prompts.push(text);
      try {
        if (prompts.length === 1) {
          options.abortSignal.addEventListener('abort', () => aborted.resolve(), { once: true });
          await aborted.promise;
          await cleanup.promise;
        } else {
          secondStarted.resolve();
          await finish.promise;
        }
      } finally { running = false; }
    };
    await repl.submit('first');
    assert.equal(repl.snapshot().busy, true);
    if (action === 'queue') await repl.submit('queued');
    const request = action === 'queue' ? repl.sendQueuedNow() : action === 'draft' ? repl.submitImmediately('replacement') : repl.interrupt();
    await aborted.promise;
    assert.equal(repl.snapshot().busy, true, 'must not advertise idle during cancellation');
    assert.equal((await repl.submit('duplicate')).ok, false);
    if (action === 'queue') assert.equal(repl.sendQueuedNow(), request, 'duplicate click shares pending request');
    assert.deepEqual(prompts, ['first']);
    cleanup.resolve();
    assert.equal((await request).ok, true);
    if (action === 'stop') {
      assert.equal(repl.snapshot().busy, false);
      await repl.submit('after-stop');
    }
    await secondStarted.promise;
    assert.equal(prompts.length, 2);
    assert.equal(repl.snapshot().busy, true);
    const run = repl.foregroundRun;
    finish.resolve();
    await run;
    assert.equal(repl.snapshot().busy, false);
    assert.equal(repl.snapshot().lines.some(line => line.kind === 'error'), false);
  });
}

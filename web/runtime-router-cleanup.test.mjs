import assert from 'node:assert/strict';
import test from 'node:test';
import { WebRuntimeRouter } from 'neoctl/web/index.js';
import { installRuntimeRouterIdleCleanup, runtimeScopeKey } from './runtime-router-cleanup.mjs';

installRuntimeRouterIdleCleanup({ maxSessions: 64 });

function createTestRouter() {
  let sequence = 0;
  const created = [];
  const router = new WebRuntimeRouter({
    async createRuntime(options = {}) {
      const sessionId = options.sessionId || `new-${++sequence}`;
      created.push(sessionId);
      return {
        engine: {
          snapshot: () => ({ session: { sessionId } }),
        },
      };
    },
    createRepl(runtime) {
      return {
        runtime,
        busy: false,
        subscribers: new Set(),
        backgroundSessionRuns: new Map(),
        backgroundTaskCount: 0,
      };
    },
  });
  return { router, created };
}

test('session scope takes precedence over tab scope', () => {
  assert.equal(runtimeScopeKey({ tabId: 'tab-a', sessionId: 'session-a' }), 'session:session-a');
  assert.equal(runtimeScopeKey({ tabId: 'tab-a' }), 'tab:tab-a');
  assert.equal(runtimeScopeKey({}), '__default__');
});

test('a bootstrap tab runtime is promoted without creating a duplicate engine', async () => {
  const { router, created } = createTestRouter();
  const bootstrap = await router.get({ tabId: 'tab-a' });
  const sessionId = bootstrap.runtime.engine.snapshot().session.sessionId;
  const promoted = await router.get({ tabId: 'tab-a', sessionId });

  assert.equal(promoted, bootstrap);
  assert.deepEqual(created, [sessionId]);
  assert.equal(router.repls.has('tab:tab-a'), false);
  assert.equal(await router.repls.get(`session:${sessionId}`), bootstrap);
});

test('different tabs observing one session share the same repl', async () => {
  const { router } = createTestRouter();
  const first = await router.get({ sessionId: 'shared-session', tabId: 'tab-a' });
  const second = await router.get({ sessionId: 'shared-session', tabId: 'tab-b' });

  assert.equal(second, first);
  assert.equal(router.activeScopes().filter((key) => key === 'session:shared-session').length, 1);
});

test('navigating away from a bootstrap tab creates a separate session hub', async () => {
  const { router, created } = createTestRouter();
  const bootstrap = await router.get({ tabId: 'tab-b' });
  const target = await router.get({ tabId: 'tab-b', sessionId: 'existing-session' });

  assert.notEqual(target, bootstrap);
  assert.equal(target.runtime.engine.snapshot().session.sessionId, 'existing-session');
  assert.deepEqual(created, ['new-1', 'existing-session']);
  assert.equal(await router.repls.get('tab:tab-b'), bootstrap);
  assert.equal(await router.repls.get('session:existing-session'), target);
});

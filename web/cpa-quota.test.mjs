import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchCpaQuotas, parseWeeklyQuota } from './cpa-quota.mjs';

test('parses weekly quota and reset time', () => {
  const value = parseWeeklyQuota({
    email: 'user@example.com',
    plan_type: 'prolite',
    rate_limit: {
      primary_window: {
        used_percent: 12.5,
        limit_window_seconds: 604800,
        reset_at: 1787801847,
      },
    },
  }, { label: 'Codex account' });
  assert.equal(value.usedPercent, 12.5);
  assert.equal(value.remainingPercent, 87.5);
  assert.equal(value.resetAt, '2026-08-27T03:37:27.000Z');
  assert.equal(value.account, 'Codex account');
  assert.equal(value.planType, 'prolite');
});

test('returns null without a usable weekly window', () => {
  assert.equal(parseWeeklyQuota({ rate_limit: {} }), null);
});

test('normalizes a CPA host URL without creating a double slash', async () => {
  const requestedUrls = [];
  const fetchImpl = async (url) => {
    requestedUrls.push(url);
    return new Response(JSON.stringify({ files: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  await fetchCpaQuotas({ url: 'http://127.0.0.1:8317', password: 'secret' }, { fetchImpl });
  assert.deepEqual(requestedUrls, ['http://127.0.0.1:8317/v0/management/auth-files']);
});

test('queries a non-disabled Codex credential even when CPA reports a transient error status', async () => {
  const requestedUrls = [];
  const fetchImpl = async (url) => {
    requestedUrls.push(url);
    if (url.endsWith('/auth-files')) {
      return new Response(JSON.stringify({
        files: [{ type: 'codex', auth_index: 'credential-1', status: 'error', disabled: false, label: 'Codex account' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      status_code: 200,
      body: JSON.stringify({
        rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 604800, reset_at: 1787801847 } },
      }),
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const quotas = await fetchCpaQuotas({ url: 'http://127.0.0.1:8317', password: 'secret' }, { fetchImpl });
  assert.equal(quotas.length, 1);
  assert.equal(quotas[0].remainingPercent, 75);
  assert.deepEqual(requestedUrls, [
    'http://127.0.0.1:8317/v0/management/auth-files',
    'http://127.0.0.1:8317/v0/management/api-call',
  ]);
});

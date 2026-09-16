import test from 'node:test';
import assert from 'node:assert/strict';
import { withAppBase } from '../src/app-url.mjs';

test('root deployment remains unchanged', () => {
  assert.equal(withAppBase('/api/state?a=1', '/'), '/api/state?a=1');
});
test('subpath covers API, SSE, assets served by runtime, and links', () => {
  for (const url of ['/api/state?a=1', '/events?tabId=t', '/vendor/a.js', '/api/downloads/id']) {
    assert.equal(withAppBase(url, '/neo/'), '/neo' + url);
    assert.equal(withAppBase('/neo' + url, '/neo/'), '/neo' + url);
  }
});
test('external and non-application URLs are not rewritten', () => {
  for (const url of ['https://example.com/api/state', '/other-service', 'data:image/png;base64,abc', 'blob:abc', '//example.com/api/a']) {
    assert.equal(withAppBase(url, '/neo/'), url);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { paginateSessions, sessionPageOptions } from '../../src/session/session-pagination.js';

const sessions = Array.from({ length: 25 }, (_, i) => ({ sessionId: `s${i}`, title: `Title ${i}`, ownerUsername: i % 2 ? 'Alice' : 'Bob', updatedAt: new Date(1700000000000 + i * 1000).toISOString() }));
test('server pagination sorts globally, slices one page and reports totals without mutating source', () => {
  const first = paginateSessions(sessions, { page: '1', pageSize: '10' });
  const second = paginateSessions(sessions, { page: '2', pageSize: '10' });
  assert.equal(first.total, 25); assert.equal(first.totalPages, 3);
  assert.equal(first.sessions.length, 10); assert.equal(second.sessions.length, 10);
  assert.equal(first.sessions[0].sessionId, 's24'); assert.equal(second.sessions[0].sessionId, 's14');
  assert.equal(sessions[0].sessionId, 's0');
  assert.equal(paginateSessions(sessions, { page: 99 }).sessions.length, 5);
});
test('search happens before slicing and includes owner, title and id', () => {
  const result = paginateSessions(sessions, { q: ' alice ', page: 2, pageSize: 10 });
  assert.equal(result.total, 12); assert.equal(result.totalCount, 25); assert.equal(result.sessions.length, 2);
  assert.ok(result.sessions.every(s => s.ownerUsername === 'Alice'));
  assert.equal(paginateSessions(sessions, { q: 's24' }).sessions[0].sessionId, 's24');
  assert.equal(paginateSessions(sessions, { q: 'Title 24' }).total, 1);
  assert.deepEqual(paginateSessions(sessions, { q: 'absent', page: 3 }).sessions, []);
});
test('paging validates boundaries, handles empty/deleted last pages and preserves legacy requests', () => {
  assert.equal(paginateSessions(sessions, { page: '-1', pageSize: 'NaN' }).page, 1);
  assert.equal(paginateSessions(sessions, { pageSize: Infinity }).pageSize, 10);
  assert.equal(paginateSessions(sessions, { pageSize: 100000 }).pageSize, 100);
  assert.equal(paginateSessions([], { page: 3 }).page, 1);
  assert.equal(paginateSessions(sessions.slice(0, 20), { page: 3 }).page, 2);
  assert.equal(sessionPageOptions(new URLSearchParams('tabId=x')), undefined);
  assert.equal(sessionPageOptions(new URLSearchParams('page=2'))?.page, '2');
});

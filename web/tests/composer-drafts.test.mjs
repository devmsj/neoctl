import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createComposerDrafts, composerDraftKey, PENDING_NEW_SESSION } from '../src/composer-drafts.mjs'

const A = composerDraftKey('a'), B = composerDraftKey('b')
const draft = (text, attachments = []) => ({ text, attachments })

test('drafts follow their session across switches', () => {
  const drafts = createComposerDrafts()
  drafts.adopt(A)
  assert.equal(drafts.owner, A)
  assert.deepEqual(drafts.switchTo(B, draft('typed in A', [{ label: '[img#1]' }])), draft(''))
  assert.deepEqual(drafts.switchTo(A, draft('typed in B')), draft('typed in A', [{ label: '[img#1]' }]))
  assert.deepEqual(drafts.switchTo(B, draft('A again')), draft('typed in B'))
  assert.equal(drafts.switchTo(B, draft('ignored')), null, 'already shown: nothing to swap')
  assert.deepEqual(drafts.switchTo(A, draft('')), draft('A again'))
  assert.equal(drafts.has(B), false, 'empty drafts are not kept')
})

test('a new session keeps its live text when it receives an id, including in-flight work', () => {
  const drafts = createComposerDrafts()
  drafts.adopt(A)
  assert.deepEqual(drafts.switchTo(PENDING_NEW_SESSION, draft('A text')), draft(''))
  const uploadOwner = drafts.owner
  drafts.adopt(composerDraftKey('')) // id-less new session
  drafts.adopt(composerDraftKey('n')) // id assigned: rename only, no swap
  assert.equal(drafts.owner, composerDraftKey('n'))
  assert.equal(drafts.isLive(uploadOwner), true)
  assert.equal(drafts.appendAttachments(uploadOwner, [{ label: '[file#1]' }]), false, 'still live: caller appends to the composer')
  drafts.adopt(B) // unrelated id changes never steal ownership
  assert.equal(drafts.owner, composerDraftKey('n'))
  assert.deepEqual(drafts.switchTo(A, draft('new text')), draft('A text'))
  assert.equal(drafts.appendAttachments(uploadOwner, [{ label: '[file#2]' }]), true)
  assert.deepEqual(drafts.switchTo(composerDraftKey('n'), draft('')), draft('new text', [{ label: '[file#2]' }]))
})

test('a fresh new session does not reuse a stale rename', () => {
  const drafts = createComposerDrafts()
  drafts.adopt(A)
  drafts.switchTo(PENDING_NEW_SESSION, draft(''))
  drafts.adopt(composerDraftKey('n1'))
  drafts.switchTo(PENDING_NEW_SESSION, draft(''))
  const owner = drafts.owner
  drafts.switchTo(A, draft('second new'))
  assert.equal(drafts.appendAttachments(owner, [{ label: 'x' }]), true)
  assert.deepEqual(drafts.switchTo(PENDING_NEW_SESSION, draft('')), draft('second new', [{ label: 'x' }]))
  assert.equal(drafts.has(composerDraftKey('n1')), false)
})

test('failed sends restore into their own session without overwriting newer text', () => {
  const drafts = createComposerDrafts()
  drafts.adopt(A)
  drafts.switchTo(B, draft(''))
  assert.equal(drafts.stashIfEmpty(A, draft('failed send')), true)
  assert.equal(drafts.stashIfEmpty(A, draft('older')), false)
  assert.equal(drafts.stashIfEmpty(B, draft('live')), false, 'live session is handled by the caller')
  assert.deepEqual(drafts.switchTo(A, draft('')), draft('failed send'))
})

test('deleting a session drops its draft and frees the live composer', () => {
  const drafts = createComposerDrafts()
  drafts.adopt(A)
  drafts.switchTo(B, draft('A text'))
  assert.equal(drafts.release(A), false)
  assert.equal(drafts.has(A), false)
  assert.equal(drafts.release(B), true)
  assert.equal(drafts.owner, PENDING_NEW_SESSION)
  // The caller clears the live composer after release(); the replacement session then loads.
  assert.deepEqual(drafts.switchTo(A, draft('')), draft(''))
  assert.equal(drafts.size, 0, 'nothing stored for a released session')
})

test('admin views are keyed by owner', () => {
  assert.notEqual(composerDraftKey('s', 'alice'), composerDraftKey('s', 'bob'))
  assert.equal(composerDraftKey('s'), ':s')
})

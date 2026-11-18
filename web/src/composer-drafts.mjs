// Unsent composer content per session, kept in page memory only (a reload or core restart may drop it).
// Nothing runs while typing: the live composer is stashed and restored only when the user switches session.
export const PENDING_NEW_SESSION = '\u0000new'

export function composerDraftKey(sessionId, ownerUsername = '') {
  return `${ownerUsername || ''}:${sessionId || ''}`
}

export function createComposerDrafts() {
  const drafts = new Map()
  // A pending/id-less session that later received its id: old key -> new key, for in-flight sends/uploads.
  const aliases = new Map()
  let owner = null

  function resolve(key) {
    for (let hops = 0; key !== null && aliases.has(key) && hops < 8; hops++) key = aliases.get(key)
    return key
  }

  function store(key, draft) {
    if (draft && (draft.text || draft.attachments?.length)) drafts.set(key, { text: draft.text || '', attachments: [...(draft.attachments || [])] })
    else drafts.delete(key)
  }

  return {
    /** Session key the live composer currently belongs to (null until the first session is known). */
    get owner() { return owner },
    /** Bind the live composer to a key without swapping content (initial load, new session getting its id). */
    adopt(key) {
      if (owner === key) return
      if (owner === null || owner === PENDING_NEW_SESSION || (owner.endsWith(':') && !key.endsWith(':'))) {
        if (owner !== null) aliases.set(owner, key)
        owner = key
      }
    },
    /**
     * User-initiated switch: stash the live draft under the current owner and return the draft to show
     * for `key` (empty when none). Returns null when `key` already owns the composer (nothing to change).
     */
    switchTo(key, live) {
      if (owner === key) return null
      if (owner !== null) store(owner, live)
      owner = key
      aliases.delete(key)
      const next = drafts.get(key)
      drafts.delete(key)
      return next || { text: '', attachments: [] }
    },
    /** Keep content for a session that is not shown now, without overwriting newer content. */
    stashIfEmpty(key, draft) {
      key = resolve(key)
      if (key === null || key === owner || drafts.has(key)) return false
      store(key, draft)
      return drafts.has(key)
    },
    /** Attachments finished after the user left `key`: add them to that session's stash. False = live composer. */
    appendAttachments(key, attachments) {
      key = resolve(key)
      if (key === null || key === owner) return false
      const draft = drafts.get(key) || { text: '', attachments: [] }
      drafts.set(key, { text: draft.text, attachments: [...draft.attachments, ...attachments] })
      return true
    },
    /** True when `key` (following id assignment) is the session shown in the live composer. */
    isLive(key) { return resolve(key) === owner },
    /** Forget a deleted session's draft. Returns true when it owned the live composer (caller clears it). */
    release(key) {
      drafts.delete(key)
      if (owner !== key) return false
      owner = PENDING_NEW_SESSION
      aliases.delete(PENDING_NEW_SESSION)
      return true
    },
    has(key) { return drafts.has(key) },
    get size() { return drafts.size },
  }
}

# Control implementation contract (final)

Node >=20 native ESM/Web Crypto, no runtime dependencies. `npm start`; `npm test`.

## Startup

`await createControlServer({adminToken,dataDir,sharedDeviceKey?,autoEnroll?,publicDir?,viewerDir?,publicOrigin?,limits?})` returns a native **not-yet-listening** http.Server. Caller owns listen/close. CLI environment: mandatory `CONTROL_ADMIN_TOKEN`; `CONTROL_HOST=127.0.0.1`, `CONTROL_PORT=8787`, default `CONTROL_DATA_DIR=control/.data`. Use a high-entropy random token. `CONTROL_PUBLIC_ORIGIN=https://control.example` is an exact trusted external origin (no path/trailing slash), also accepted as `options.publicOrigin`. Browser requests may use that configured origin or direct HTTP Host origin. No CORS, cross-site fetch metadata denied. X-Forwarded-* is never trusted; IP comes from socket.remoteAddress. Static assets need no Bearer, every `/api/*` does.

Enrollment gate: `CONTROL_AUTO_ENROLL=true` (or explicit `options.autoEnroll: true`) enables `POST /enroll` only with a valid `CONTROL_SHARED_DEVICE_KEY` / `options.sharedDeviceKey`. Default is off; a shared key alone is not opt-in, and an absent shared key keeps enrollment unavailable; a supplied malformed key fails startup validation. `options.autoEnroll` must be boolean and the environment opt-in is exactly `true`. A device key equal to the admin token is rejected. The key is canonical base64 of 32 random bytes. Existing shared-key startup migration changes stored device keys without resetting IDs, sessions, commands, acknowledgements or replay history; removing the option does not rotate existing keys. Disabling auto-enrollment must not implicitly revoke already registered devices.

## Desktop / Web bootstrap

The Rust desktop launcher handles the custom EXE's built-in Control URL/IP, `allowHttp` policy and application-level shared device key. No admin/SSH credentials, preassigned deviceId, external `control-pairing.json`, bundled `control/pairing.json`, or `NEO_DESKTOP_CONTROL_FILE` provisioning path is part of the replacement flow.

The managed Web startup receives `NEO_DESKTOP_CONTROL_CONFIG`, a JSON object `{enabled,url,allowHttp,key}`. Consume and delete the environment variable at the earliest startup stage, before initializing the runtime or spawning tools/child processes; keep the validated config in memory only. Do not log, persist, expose to browser/model context or forward the JSON/key. Deletion reduces inherited-environment exposure, not process-memory extraction risk. No config means an ordinary Web launch stays disabled; disabled/invalid config must not enroll/sync or fall back to legacy pairing files. Require explicit `allowHttp: true` for non-loopback HTTP; prefer HTTPS and reject URLs containing credentials.

Web resolves `NEO_WEB_DATA_DIR` (or its normal default) and passes that directory as `options.dataDir`; direct sync-client calls without a valid data directory stay disabled. `control-device.json` stores only `{deviceId}`, a persistent locally generated random UUID, with no key, URL or configuration. Reuse this ID after restarts; do not derive it from machine identity, embed one per app build, or regenerate it on retry/revocation. Identity metadata remains `{machineCode,hostname,model,platform}`, not authentication proof; machineCode is a hash derived from the installation UUID, not a hardware identifier. Cursor and command-ack persistence remain separate and must not be reset by enrollment. A stable per-install data directory is required; cloning it duplicates identity.

Enroll first on process startup, validate the encrypted enrolled response, then run the existing sync loop. Enrollment and synchronization are silent (no popups/chat messages), single-flight, timeout-bounded and use capped retry backoff. Failure must not advance cursors, acknowledge unapplied commands, or create a new device ID. The enrollment/sync retry loop caps its delay at 30 seconds.

## Encryption protocol

`protocol.mjs` exports async `seal(keyBase64,deviceId,direction,payload)` and `open(keyBase64,deviceId,direction,envelope)`; **await both**. Direction is exclusively **up/down**. Copy this file byte-for-byte into web/control-protocol.mjs. Browser/Node native Web Crypto only, no Node imports. Device PSK is standard base64 of 32 random bytes. AES-256-GCM uses random 12-byte nonce and 16-byte tag; AAD is UTF8 `JSON.stringify([deviceId,direction])`. Envelope `{v:1,nonce:base64,ciphertext:base64}` has the authentication tag appended to ciphertext.

### Enrollment

POST `/enroll`, application/json, outer body `{deviceId,envelope}`. The client supplies its persistent random UUID as deviceId. Seal with the shared key, this deviceId and direction `up`:

```js
{
  requestId: crypto.randomUUID(),
  sentAt: Date.now(),
  kind: 'enroll',
  device: identity // {machineCode,hostname,model,platform}
}
```

Success response outer JSON is only `{envelope}`. Decrypt using the same key/deviceId and direction `down` into `{requestId,deviceId,kind:'enrolled'}`. Verify requestId, deviceId and kind before starting `/sync`. The server must validate outer ID/envelope, authenticated kind/identity and fresh timestamp/requestId before creating a record. The shared key is never sent as a plaintext request field; there is no admin token in this protocol.

- Enrollment validates requestId syntax and the same +/-120-second timestamp window. It is intentionally idempotent even for the same requestId/envelope inside that window: an existing active ID is acknowledged without any state mutation. `/sync` separately persists and rejects duplicate requestIds as described below. The enrollment payload must have `kind: enroll`.
- New devices inherit the current broadcast as a pending command for normal `/sync` application/acknowledgement. Enrollment itself does not apply or acknowledge model settings.
- Re-enrolling an existing active ID must not recreate it or reset creation time, notes, pending command/ID, last acknowledgement, session offsets or replay state. Enrollment does not update heartbeat/identity observations of an existing record; only sync updates them.
- `DELETE /api/devices/:id` must durably record revocation in server state, not merely remove the device row. Both `/enroll` and `/sync` reject that ID even after server restart; re-enrollment cannot undo revocation. Keep historical sessions for admins. Revocation bookkeeping must obey storage limits without silently evicting revoked IDs to admit new ones.
- Enforce device/state/body/concurrency quotas on registration. Rate-limit socket-IP attempts and failed enrollment/authentication as well as accepted device traffic; failures must consume a bounded abuse budget, and arbitrary new IDs must not evade the IP budget. Keep IP buckets bounded, do not trust X-Forwarded-* or weaken existing sync limits. Defaults per socket IP per minute are 60 enrollment attempts, 600 combined device-route attempts, and 30 failed device responses (all HTTP 4xx/5xx). Buckets are bounded to 2048 entries; concurrency is capped at 64. Configurable limits are `enrollPerMinute`, `deviceRequestsPerMinute`, `authFailuresPerMinute`, and `concurrentRequests`.
- `/enroll` and `/sync` are device-protocol routes; they do not bypass or grant `/api/*` admin privileges. Keep same-origin/cross-site protections and the separate admin Bearer check. Before authenticated decryption, return generic rejection without leaking keys or device existence; authenticated errors may use encrypted responses, never echo secret config.

### Synchronization (unchanged)

POST `/sync`, application/json, body `{deviceId,envelope}`. Encrypt upload with up:

```js
{
  requestId: crypto.randomUUID(), sentAt: Date.now(),
  device: {machineCode,hostname,model,platform},
  ackCommandId, // optional; only after successful local application
  deltas: [{sessionId,file:'transcript.jsonl',offset:0,data:'base64'}]
}
```

Response outer JSON is **only `{envelope}`**, decrypted using down into `{requestId,acks:[{sessionId,file,offset,conflict?:true}],command?:{id,profile}}`. Client verifies requestId. Only meta.json/transcript.jsonl allowed. Offsets and data lengths are bytes, not characters.

- At EOF: append and fsync, ack absolute next byte.
- Client offset ahead: no write, ack current server EOF (rewind).
- Matching overlap: compare stored bytes, ack only compared end `min(serverEOF,sentOffset+sentBytes)`, never skip unchecked bytes. Partial overlap retries its tail next request.
- Conflicting overlap: no write, `{offset:sentOffset,conflict:true}`. Client persistently freezes the conflicted file/session and reports diagnostic; do not silently advance.
- Empty probe: ack `min(serverEOF,sentOffset)`, so fully synced files can discover server loss, and a lost client cursor recovers by comparing chunks from zero.
- No truncation/reset/overwrite API; client freezes local truncation conflicts rather than replacing uploaded content.

`sentAt` must be an integer within +/-120 seconds of server time. Recent request IDs are consumed durably before file/ack effects and retained until sentAt+120 seconds (future clock skew can require up to four minutes of wall-clock retention). Duplicate IDs return encrypted HTTP409, do not refresh heartbeat or apply stale ack. Retries **must use a fresh requestId and sentAt**; file offsets and command IDs provide idempotency. Device limit 120 accepted requests/minute; transport limit 600 combined sync/enrollment attempts/minute per socket IP, max2048 IP buckets. Use a reverse-proxy/WAF rate limit as additional protection, especially shared NAT/proxy deployments.

Once decrypted, input/quota/replay errors return encrypted envelopes (400/413/409/429 etc.) with `{requestId,acks:[],error}`. A failed batch may have appended earlier files; fresh-ID retry safely negotiates offsets. Unknown/revoked key, tampering, malformed outer body and pre-decryption limits produce generic plaintext `{error:'request rejected'}` only.

## Profiles

Strict schema `{provider:'openai',values:{...}}`. No other top-level fields. `apiKey` and `model` are required nonempty strings. Allowed values keys only: apiKey, baseUrl, model, endpoint, reasoningEffort, reasoningSummary, maxOutputTokens, timeoutMs, streamIdleTimeoutMs, maxRetries. Values must be strings of at most 8192 characters (model at most 256), matching the Desktop login adapter; no objects, booleans, env aliases or engine/tool/session settings. Optional nonempty baseUrl must be http(s) without URL credentials. Values are passed to engine `/api/login`, not environment variables. Additional model-specific semantic validation remains with the client/engine. Admin GET state includes profile API keys because admins manage profiles, but never device PSKs.

## Admin API and UI

Bearer `CONTROL_ADMIN_TOKEN` required. POST/PATCH use application/json. Shared viewer/UI sessionStorage token key: **neo-control-token** (frontend convention, not a server cookie).

- GET `/api/state` => `{devices,profiles,broadcastProfileId,sessions}`. Device records contain deviceId and id alias, name, ip, createdAt, lastSeen (epoch ms/null), online (<30s), machineId alias for machineCode, machineCode/hostname/model/platform after sync, nested device, lastAckCommandId and sanitized pendingCommand metadata. No key/replay-cache contents. Profiles `{id,name,profile,updatedAt}`. Sessions `{deviceId,sessionId,files:{filename:byteLength},updatedAt}`; title may be obtained from meta, UI should fall back to sessionId.
- POST `/api/devices` `{name?}` => 201 `{deviceId,key}`. PSK returned **once** by this compatibility admin endpoint; custom clients instead self-register through `/enroll`.
- PATCH `/api/devices/:id` `{name}` => public device record.
- DELETE `/api/devices/:id` => `{ok:true}`, persists the ID in `revokedDeviceIds` and removes the active record; historical sessions retained for admins. This does not revoke knowledge of a shared key.
- POST `/api/profiles` `{id?,name,profile}` => profile record, 201 create/200 update.
- DELETE `/api/profiles/:id` => `{ok:true}`.
- POST `/api/broadcast` `{profileId:null|id}` => `{ok:true}`.
- POST `/api/dispatch` `{profileId,deviceIds}` => `{ok:true,commands:[{deviceId,id}]}`.
- GET `/api/sessions/:deviceId/:sessionId` => `{meta,transcript}`, meta parsed JSON or null if missing/incomplete, transcript exact UTF8 text or empty. Treat both as untrusted input, never render raw HTML.

One pending command per device. Latest broadcast/direct operation wins; stale ack cannot clear a newer command. Ack is persisted before responding without command, so restart does not resend acknowledged commands. Unacked commands retain the same ID. Current broadcast reaches offline/current/newly registered devices. Updating selected broadcast profile creates a newer broadcast. Setting broadcast null cancels pending broadcast commands, not independent direct snapshots; no rollback of already applied client settings. Deleting a profile cancels its broadcast; **direct command snapshots remain** independently of source deletion/editing.

## Static viewer and storage security

Public GET/HEAD routes `/`, `/index.html`, `/app.js`, `/style.css` map to control/public. `/viewer`, `/viewer/`, `/viewer/index.html` map to control/viewer-dist/index.html; `/viewer/assets/<safe-name>.js|css|woff2` map only to assets. Other paths404; no directory listing/data serving. CSP script/style/connect only self; img-src self data (no external image requests), frame-ancestors none, no-referrer/nosniff. Viewer is read-only and this server does not start engine.

State write/fsync/atomic same-directory rename; append/fsync sessions under sessions/deviceId/sessionId. Startup derives offsets from actual file lengths. Serialized in-process queue, **one process per dataDir** (no cross-process lock). Directory/file creation modes0700/0600, state chmod600 best-effort; use Windows ACLs. Data directory must be private and protected from local modification; IDs are restricted ASCII and Windows reserved names rejected; files are whitelisted and existing symlinks/nonregular files denied.

Control is the **trusted decryption endpoint** and stores plaintext sessions, PSKs and model keys. This is application-layer encrypted transport, **not browser-only E2EE that hides data from the server**. Use HTTPS/SSH tunnel outside loopback, especially for admin Bearer and pairing PSKs. Back up/protect data separately; no at-rest encryption or automatic historical cleanup.

Default limits: actual complete HTTP JSON body **256KiB including base64 envelope overhead**, 128KiB per decoded delta,128 deltas,16MiB/file,1GiB total session contents,1000 devices,1000 sessions/device,128 profiles,64KiB/profile,32MiB state JSON,64 concurrent requests,15s request/20s processing deadline. Override via limits using server.mjs field names. Metadata/temp files need additional disk capacity; OS disk quotas recommended. Client budget should leave encoding overhead (e.g. ~128KiB raw upload across32KiB fair session chunks).

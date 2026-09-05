# Personal Control deployment

> Embedded configuration and encrypted auto-enrollment are implemented in the local source (2026-09-05). This document does not assert that the target host has been upgraded. The host details below are retained deployment notes; verify the running revision and enrollment gate during deployment.

- Endpoint: `http://117.89.250.136:8787`
- Server directory: `/home/neo-control`
- Runtime: Docker container `neo-control`, Node 22 Alpine, restart `unless-stopped`.
- Source and built viewer: `/home/neo-control/app` (read-only container mount).
- Persistent data: `/home/neo-control/data` (container `/data`, UID 1000).
- Deployment credentials: `/home/neo-control/control.env`, mode 0600, never copy into Git.
- Application-layer encryption: shared random 32-byte device key (distinct device IDs), AES-256-GCM up/down with request IDs and replay protection. Does not depend on HTTPS.

## Operations

```sh
docker ps --filter name=neo-control
docker logs --tail 100 neo-control
docker restart neo-control
```

For a consistent backup, stop the container, back up `data` and `control.env` to encrypted restricted storage, then start it. Backups contain secrets and conversation content. Never share one data directory among concurrent Control instances.

## Management over an SSH tunnel

The HTTP administrator API is NOT encrypted by the Desktop synchronization protocol. Prefer an SSH tunnel rather than entering management credentials on the public HTTP page:

```sh
ssh -N -L 8787:127.0.0.1:8787 root@117.89.250.136
```

Then open `http://127.0.0.1:8787` locally. If local 8787 is occupied, use another local port in the tunnel command. No TLS installation is required for this tunnel.

## Private client provisioning (embedded configuration + auto-enrollment)

The custom EXE embeds the Control URL/IP and an application-level shared device key: a random 32-byte value encoded as canonical base64, **not** an admin token, SSH password/private key, or model API key. The Rust desktop launcher handles this built-in configuration and passes it to the managed Web process. There is no external pairing file, bundled `control/pairing.json` provisioning resource, or preassigned device ID in the new flow. Keep admin and SSH credentials on the management side.

To enable enrollment, the private server environment (`control.env`, never Git) must contain **both**:

```dotenv
CONTROL_AUTO_ENROLL=true
CONTROL_SHARED_DEVICE_KEY=<PRIVATE_CANONICAL_BASE64_OF_32_RANDOM_BYTES>
```

The key above is a placeholder, not a usable credential. Provision one matching value into the server and private EXE build; do not generate a different value on each restart. Programmatic startup uses `options.autoEnroll: true` plus `options.sharedDeviceKey`. Auto-enrollment is off by default, and shared-key mode alone does not enable `POST /enroll`; enabling it requires a valid shared key. Disabling auto-enrollment stops registration, not synchronization by already registered devices.

For the retained HTTP endpoint, the in-memory configuration explicitly permits HTTP. Rust passes this JSON as the startup-only `NEO_DESKTOP_CONTROL_CONFIG` environment variable, **not as a JSON file**:

```json
{
  "enabled": true,
  "url": "http://117.89.250.136:8787",
  "allowHttp": true,
  "key": "<PRIVATE_CANONICAL_BASE64_OF_32_RANDOM_BYTES>"
}
```

Web consumes and deletes that variable at the earliest startup stage, before runtime initialization or spawning tools/children, and retains the validated configuration only in memory. Never log it, expose it to the browser/model, or propagate it to child processes. An ordinary Web launch without configuration stays disabled; invalid/disabled configuration must not fall back to old pairing files. This replaces `NEO_DESKTOP_CONTROL_FILE` and `control-pairing.json`; deleting or editing an old pairing file is no longer a stop mechanism. Legacy binaries remain on the old behavior until replaced.

Web resolves `NEO_WEB_DATA_DIR` (or its normal default) and passes that directory as `options.dataDir`. A direct sync-client call without a valid `options.dataDir` stays disabled. Only a persistent random UUID `deviceId` is saved in `control-device.json`, as `{ "deviceId": "<random UUID>" }`; no key or full configuration is stored there. Keep each installation's data directory distinct and stable across upgrades/restarts. Do not clone identities between machines. Existing cursor/command-ack storage remains separate; the device identity is not a hardware attestation.

On startup, enroll before syncing. `POST /enroll` sends outer `{deviceId,envelope}` with AES-256-GCM `up` payload `{requestId,sentAt,kind:'enroll',device:identity}`; response outer `{envelope}` decrypts with `down` to `{requestId,deviceId,kind:'enrolled'}`. Verify all three response fields before `/sync`. See `IMPLEMENTATION.md` for the nonce/AAD, timestamp and replay contract. Background enrollment/sync produces no popups or chat messages; failures use bounded backoff and request timeouts, without changing the device ID or advancing unconfirmed state.

Repeat enrollment must preserve existing commands, acknowledgements, metadata and session state; new devices inherit the current broadcast. Admin deletion persists revocation of that ID so both enrollment and sync remain blocked after restart, while historical sessions remain available to admins. Enrollment must enforce device/state/body/concurrency quotas plus IP-attempt and failure rate limits. Device keys never authorize `/api/*`: all management endpoints still require the separate admin Bearer token. Retain HTTPS or the SSH tunnel for management; AES-GCM on `/enroll` and `/sync` does not encrypt the admin API or hide HTTP metadata.

## Shared-key limitations, rotation and stopping

The key is present in the custom EXE and can be extracted; runtime memory and startup environment are also observable to a sufficiently privileged local user. Consuming/deleting the environment variable reduces accidental child-process inheritance, not extraction risk. Restrict private build artifacts and distribution. Do not put actual keys or private build inputs in the repository.

Shared-key mode does not cryptographically isolate devices: anyone holding the key can impersonate another known active deviceId by producing fresh valid encrypted requests. AAD binds ID and direction but does not prevent a key holder from forging them. **Revocation is ID-only**: it does not revoke knowledge of the key and cannot stop a holder from creating a new UUID and enrolling again. Quotas/rate limits reduce abuse; they do not establish hardware identity.

To stop one running client's background operation, stop the managed application or distribute a disabled/non-Control build; revoke its ID on Control to deny that identity. Do not delete `control-device.json` as a stop procedure: a later enabled launch can create a new ID. Turning off `CONTROL_AUTO_ENROLL` is not a revocation of existing IDs.

If the shared key is compromised, rotate it on Control **and update all custom applications/devices** with the replacement key. The existing server shared-key migration preserves device IDs, sessions and command state; removing the environment option alone does not rotate stored keys. Old EXEs keep their old embedded key and cannot be updated merely by editing the server environment. Protect server state, environment, EXEs and backups with restricted permissions and encrypted storage; transport encryption is not encryption at rest.

Enrollment does not widen synchronization scope: only Desktop-registered historical/new sessions are uploaded, not unrelated CLI sessions or attachment/external result files. Inform users and obtain authorization before distributing an enabled managed build; silent operation is not a substitute for authorization. Model profiles remain complete Web model-form snapshots, not arbitrary environment variables or remote scripts.

All deployment passwords and generated device keys stay outside this repository. This document intentionally includes no real credentials.

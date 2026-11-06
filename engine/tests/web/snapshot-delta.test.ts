import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";
import test, { type TestContext } from "node:test";
import { compactLineOperations, WebRepl, type WebRuntime } from "../../src/web/index.js";

type Operation = Parameters<typeof compactLineOperations>[0][number];
type Line = ReturnType<WebRepl["snapshot"]>["lines"][number];
type Internals = {
  lines: Line[];
  pendingDeltaTimer?: NodeJS.Timeout;
  terminalOutputTimer?: NodeJS.Timeout;
  queueDeltaOperation(operation: Operation): void;
  flushDeltaOperations(): void;
  broadcastSync(): void;
  publishRuntimeContext(): void;
};
type Frame = { event: string; data: { operations?: Operation[]; lines?: Line[]; status?: unknown } };

const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "neo-snapshot-delta-"));
const previousConfigHome = process.env.NEO_MODEL_CONFIG_DIR;
process.env.NEO_MODEL_CONFIG_DIR = configHome;
test.after(() => {
  if (previousConfigHome === undefined) delete process.env.NEO_MODEL_CONFIG_DIR;
  else process.env.NEO_MODEL_CONFIG_DIR = previousConfigHome;
  fs.rmSync(configHome, { recursive: true, force: true });
});

function fixture(t: TestContext) {
  const runtime = {
    engine: {
      getDisplayEntries: () => [],
      snapshot: () => ({ session: { sessionId: "snapshot-delta" } }),
      isFastMode: () => false,
      getAppPrompt: () => ({ hasActivePrompt: false }),
      onSessionTitleChange: () => () => undefined,
      refreshModelConfigurationIfIdle: () => undefined,
    },
    taskStore: { subscribe: () => () => undefined, list: () => [] },
    execProcessManager: { subscribe: () => () => undefined, subscribeOutput: () => () => undefined, list: () => [] },
  } as unknown as WebRuntime;
  const repl = new WebRepl(runtime);
  const internal = repl as unknown as Internals;
  internal.publishRuntimeContext = () => undefined;
  internal.lines = [{ id: 1, kind: "assistant", text: "" }];
  const responses: EventEmitter[] = [];
  t.after(() => {
    clearTimeout(internal.pendingDeltaTimer);
    clearTimeout(internal.terminalOutputTimer);
    for (const response of responses) response.emit("close");
  });
  return {
    internal,
    append(text: string) {
      internal.lines[0]!.text += text;
      internal.queueDeltaOperation({ type: "line.text.append", id: 1, text });
    },
    flush() {
      clearTimeout(internal.pendingDeltaTimer);
      internal.flushDeltaOperations();
    },
    connect() {
      const frames: Frame[] = [];
      const response = Object.assign(new EventEmitter(), {
        destroyed: false,
        blocked: false,
        writeHead() {},
        write(frame: string) {
          const event = /^event: (.+)$/m.exec(frame)?.[1];
          const data = /^data: (.+)$/m.exec(frame)?.[1];
          if (event && data) frames.push({ event, data: JSON.parse(data) });
          return !response.blocked;
        },
      });
      responses.push(response);
      repl.subscribe(response as unknown as ServerResponse);
      return { frames, response };
    },
  };
}

function delta(frames: Frame[]): Operation[] {
  assert.equal(frames.at(-1)?.event, "delta");
  assert.ok(frames.at(-1)!.data.status, "status must still be delivered with an empty delta");
  return frames.at(-1)!.data.operations!;
}

for (const kind of ["assistant", "thinking"] as const) {
  test(`SSE ${kind} snapshot includes queued appends without replaying them`, (t) => {
    const f = fixture(t);
    f.internal.lines[0]!.kind = kind;
    const existing = f.connect();
    f.append("first ");
    f.append("second");
    const joined = f.connect();
    assert.equal(joined.frames[0]!.data.lines![0]!.text, "first second");
    f.flush();
    assert.deepEqual(delta(existing.frames), [{ type: "line.text.append", id: 1, text: "first second" }]);
    assert.deepEqual(delta(joined.frames), []);
  });
}

test("different subscribers skip only their own snapshot prefix before compaction", (t) => {
  const f = fixture(t);
  f.append("A");
  const first = f.connect();
  f.append("B");
  const second = f.connect();
  f.append("C");
  f.append("D");
  f.flush();
  assert.deepEqual(delta(first.frames), [{ type: "line.text.append", id: 1, text: "BCD" }]);
  assert.deepEqual(delta(second.frames), [{ type: "line.text.append", id: 1, text: "CD" }]);
  f.append("E");
  f.flush();
  for (const client of [first, second]) assert.deepEqual(delta(client.frames), [{ type: "line.text.append", id: 1, text: "E" }]);
});

test("backpressure recovery snapshot skips queued text but preserves later appends", (t) => {
  const f = fixture(t);
  const client = f.connect();
  client.response.blocked = true;
  f.append("A");
  f.flush(); // write accepted, but transport reports backpressure
  f.append("B");
  f.flush(); // blocked subscriber must recover using a snapshot
  f.append("C");
  client.response.blocked = false;
  client.response.emit("drain");
  assert.equal(client.frames.at(-1)!.event, "sync");
  assert.equal(client.frames.at(-1)!.data.lines![0]!.text, "ABC");
  f.append("D");
  f.flush();
  assert.deepEqual(delta(client.frames), [{ type: "line.text.append", id: 1, text: "D" }]);
});

test("full sync discards pending offsets so the next batch is delivered", (t) => {
  const f = fixture(t);
  f.append("old");
  const client = f.connect();
  f.internal.broadcastSync();
  assert.equal(client.frames.at(-1)!.event, "sync");
  f.append("new");
  f.flush();
  assert.deepEqual(delta(client.frames), [{ type: "line.text.append", id: 1, text: "new" }]);
});

test("model settings sync discards queued appends already in its snapshot", (t) => {
  const f = fixture(t);
  const client = f.connect();
  f.append("queued");
  (f.internal as unknown as { settingsListener(): void }).settingsListener();
  assert.equal(client.frames.at(-1)!.event, "sync");
  assert.equal(client.frames.at(-1)!.data.lines![0]!.text, "queued");
  f.append(" next");
  f.flush();
  assert.deepEqual(delta(client.frames), [{ type: "line.text.append", id: 1, text: " next" }]);
});

test("snapshot offset counts all operation types, not only text appends", (t) => {
  const f = fixture(t);
  f.internal.queueDeltaOperation({ type: "line.append", line: { id: 2, kind: "meta", text: "queued" } });
  f.internal.queueDeltaOperation({ type: "line.patch", id: 1, patch: { title: "queued" } });
  const client = f.connect();
  f.append("new");
  f.flush();
  assert.deepEqual(delta(client.frames), [{ type: "line.text.append", id: 1, text: "new" }]);
});

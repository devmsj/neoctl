import assert from "node:assert/strict";
import test from "node:test";
import { dockerArgs, dockerEnabled, dockerHostEnv, executionCwd } from "../../src/execution/docker.js";
import { executionLaunch } from "../../src/execution/process.js";
import { executionFs } from "../../src/execution/filesystem.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("default backend preserves local filesystem and command behavior", async () => {
  delete process.env.NEO_EXECUTION_BACKEND;
  assert.equal(dockerEnabled(), false);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "neo-local-backend-"));
  try {
    const file = path.join(dir, "test.txt");
    await executionFs.writeFile(file, "unchanged");
    assert.equal(await executionFs.readFile(file, "utf8"), "unchanged");
    const launch = executionLaunch("sh", ["-c", "echo ok"], dir, { TEST: "yes" });
    assert.equal(launch.file, "sh");
    assert.equal(launch.cwd, dir);
    assert.equal(launch.env.TEST, "yes");
    assert.equal(launch.signal, undefined);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("Docker arguments do not interpret command text or inherit secrets", () => {
  process.env.NEO_EXECUTION_BACKEND = "docker";
  process.env.NEO_EXECUTION_CONTAINER = "neo-test";
  process.env.NEO_TEST_SECRET = "host-only";
  try {
    const args = dockerArgs(["bash", "-lc", "echo '; docker run --privileged x'"], "/workspace/a b", { TEST: "a b;" });
    assert.deepEqual(args.slice(0, 8), ["exec", "-i", "--user", "0", "--workdir", "/workspace/a b", "--env", "TEST=a b;"]);
    assert.equal(args[8], "neo-test");
    assert.equal(dockerHostEnv().NEO_TEST_SECRET, undefined);
    assert.equal(executionCwd("../root"), "/root");
    assert.throws(() => dockerArgs(["true"], "/", { "-bad": "x" }));
    process.env.NEO_EXECUTION_CONTAINER = "--privileged";
    assert.throws(() => dockerArgs(["true"]));
  } finally {
    delete process.env.NEO_EXECUTION_BACKEND;
    delete process.env.NEO_EXECUTION_CONTAINER;
    delete process.env.NEO_TEST_SECRET;
  }
});

test("invalid backend fails closed", () => {
  process.env.NEO_EXECUTION_BACKEND = "dockre";
  try { assert.throws(() => dockerEnabled()); assert.throws(() => executionFs.readFile); }
  finally { delete process.env.NEO_EXECUTION_BACKEND; }
});

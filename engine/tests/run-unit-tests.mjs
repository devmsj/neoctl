import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function findTests(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    return entry.isDirectory() ? findTests(file) : entry.name.endsWith(".test.ts") ? [file] : [];
  });
}

// Explicit paths work on Windows and Node 20 without shell glob expansion.
// Smoke scripts are intentionally excluded: some require external services.
const files = findTests(join(root, "tests")).sort();
if (files.length === 0) throw new Error("No engine unit tests found");
const result = spawnSync(process.execPath, [fileURLToPath(import.meta.resolve("tsx/cli")), "--test", ...process.argv.slice(2), ...files], {
  cwd: root,
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);

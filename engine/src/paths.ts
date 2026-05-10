import { homedir } from "node:os";
import { resolve } from "node:path";

/**
 * Returns the neoctl user home directory.
 *
 * - Windows: `%USERPROFILE%\.neoctl` (e.g. `C:\Users\<user>\.neoctl`)
 * - Linux / macOS: `~/.neoctl`
 */
export function getNeoctlHome(): string {
  return resolve(homedir(), ".neoctl");
}

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CLIPBOARD_COMMAND_TIMEOUT_MS = 5000;
const MAX_BUFFER_BYTES = 128 * 1024 * 1024;

export interface ClipboardImagePayload {
  mimeType: string;
  data: string;
}

export type ClipboardPayload =
  | { type: "image"; image: ClipboardImagePayload }
  | { type: "text"; text: string }
  | { type: "empty" };

export async function readClipboard(): Promise<ClipboardPayload> {
  const image = await readClipboardImage().catch(() => undefined);
  if (image) return { type: "image", image };

  const text = await readClipboardText().catch(() => undefined);
  if (text && text.length > 0) return { type: "text", text };
  return { type: "empty" };
}

async function readClipboardImage(): Promise<ClipboardImagePayload | undefined> {
  if (process.platform === "win32") return readWindowsClipboardImage();
  if (process.platform === "darwin") return readDarwinClipboardImage();
  return readLinuxClipboardImage();
}

async function readClipboardText(): Promise<string | undefined> {
  if (process.platform === "win32") return readWindowsClipboardText();
  if (process.platform === "darwin") return runTextCommand("pbpaste", []);
  return readLinuxClipboardText();
}

async function readWindowsClipboardImage(): Promise<ClipboardImagePayload | undefined> {
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms;",
    "Add-Type -AssemblyName System.Drawing;",
    "if (-not [System.Windows.Forms.Clipboard]::ContainsImage()) { exit 2 }",
    "$img = [System.Windows.Forms.Clipboard]::GetImage();",
    "$ms = New-Object System.IO.MemoryStream;",
    "$img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png);",
    "[Convert]::ToBase64String($ms.ToArray());",
  ].join(" ");
  const output = await runTextCommand("powershell.exe", ["-NoProfile", "-Sta", "-Command", script]);
  const data = output?.replace(/\s+/g, "") ?? "";
  return data ? { mimeType: "image/png", data } : undefined;
}

async function readWindowsClipboardText(): Promise<string | undefined> {
  const script = "Get-Clipboard -Raw -Format Text";
  return runTextCommand("powershell.exe", ["-NoProfile", "-Sta", "-Command", script]);
}

async function readDarwinClipboardImage(): Promise<ClipboardImagePayload | undefined> {
  const pngpaste = await runBinaryCommand("pngpaste", ["-"]).catch(() => undefined);
  if (pngpaste && pngpaste.length > 0) return { mimeType: "image/png", data: pngpaste.toString("base64") };
  return undefined;
}

async function readLinuxClipboardImage(): Promise<ClipboardImagePayload | undefined> {
  const wl = await runBinaryCommand("wl-paste", ["--no-newline", "--type", "image/png"]).catch(() => undefined);
  if (wl && wl.length > 0) return { mimeType: "image/png", data: wl.toString("base64") };

  const xclip = await runBinaryCommand("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]).catch(() => undefined);
  if (xclip && xclip.length > 0) return { mimeType: "image/png", data: xclip.toString("base64") };
  return undefined;
}

async function readLinuxClipboardText(): Promise<string | undefined> {
  const wl = await runTextCommand("wl-paste", ["--no-newline"]).catch(() => undefined);
  if (wl !== undefined) return wl;
  const xclip = await runTextCommand("xclip", ["-selection", "clipboard", "-o"]).catch(() => undefined);
  if (xclip !== undefined) return xclip;
  return runTextCommand("xsel", ["--clipboard", "--output"]);
}

async function runTextCommand(command: string, args: string[]): Promise<string | undefined> {
  const { stdout } = await execFileAsync(command, args, {
    encoding: "utf8",
    timeout: CLIPBOARD_COMMAND_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER_BYTES,
    windowsHide: true,
  });
  return typeof stdout === "string" ? stripTrailingNewline(stdout) : undefined;
}

async function runBinaryCommand(command: string, args: string[]): Promise<Buffer | undefined> {
  const { stdout } = await execFileAsync(command, args, {
    encoding: "buffer",
    timeout: CLIPBOARD_COMMAND_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER_BYTES,
    windowsHide: true,
  });
  return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? []);
}

function stripTrailingNewline(value: string): string {
  return value.replace(/\r?\n$/u, "");
}

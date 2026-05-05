export type ReplCommand =
  | { type: "help" }
  | { type: "exit" }
  | { type: "log"; path?: string; off?: boolean }
  | { type: "reset" }
  | { type: "state" }
  | { type: "input"; text: string };

export function parseReplCommand(line: string): ReplCommand {
  const trimmed = line.trim();
  if (trimmed === "/help") return { type: "help" };
  if (trimmed === "/exit" || trimmed === "/quit") return { type: "exit" };
  if (trimmed === "/log" || trimmed.startsWith("/log ")) {
    const argument = trimmed.slice("/log".length).trim();
    if (argument.toLowerCase() === "off") return { type: "log", off: true };
    return { type: "log", path: argument || undefined };
  }
  if (trimmed === "/reset") return { type: "reset" };
  if (trimmed === "/state") return { type: "state" };
  return { type: "input", text: line };
}

export const helpText = [
  "Commands:",
  "  /help       Show commands",
  "  /log <dir>  Write model communication logs to an absolute directory",
  "  /log off    Disable model communication logs",
  "  /state      Show query engine state",
  "  /reset      Clear in-memory transcript",
  "  /exit       Quit",
].join("\n");

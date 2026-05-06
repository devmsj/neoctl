export type ReplCommand =
  | { type: "help" }
  | { type: "exit" }
  | { type: "log"; path?: string; off?: boolean }
  | { type: "reset" }
  | { type: "resume"; sessionId?: string }
  | { type: "sessions"; limit?: number }
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
  if (trimmed === "/resume" || trimmed.startsWith("/resume ")) {
    const argument = trimmed.slice("/resume".length).trim();
    return { type: "resume", sessionId: argument || undefined };
  }
  if (trimmed === "/sessions" || trimmed.startsWith("/sessions ")) {
    const argument = trimmed.slice("/sessions".length).trim();
    const limit = argument ? Number(argument) : undefined;
    return { type: "sessions", limit: Number.isFinite(limit) && limit !== undefined && limit > 0 ? Math.floor(limit) : undefined };
  }
  if (trimmed === "/state") return { type: "state" };
  return { type: "input", text: line };
}

export const helpText = [
  "Commands:",
  "  /help                 Show commands",
  "  /log <dir>            Write model communication logs to an absolute directory",
  "  /log off              Disable model communication logs",
  "  /sessions [limit]     List saved sessions, newest first",
  "  /resume [session_id]  Resume a saved session (default/latest uses newest)",
  "  /state                Show query engine state",
  "  /reset                Clear current transcript and add a reset marker",
  "  /exit                 Quit",
].join("\n");

export type ReplCommand =
  | { type: "help" }
  | { type: "cost" }
  | { type: "exit" }
  | { type: "log"; path?: string; off?: boolean }
  | { type: "reset" }
  | { type: "resume"; sessionId?: string }
  | { type: "sessions"; pageSize?: number }
  | { type: "state" }
  | { type: "input"; text: string };

export interface ReplCommandDefinition {
  name: string;
  usage: string;
  description: string;
  aliases?: string[];
}

export const replCommandDefinitions: ReplCommandDefinition[] = [
  { name: "/help", usage: "/help", description: "Show commands" },
  { name: "/cost", usage: "/cost", description: "Show total token usage for this REPL session" },
  { name: "/log", usage: "/log <dir>", description: "Write model communication logs to an absolute directory" },
  { name: "/log off", usage: "/log off", description: "Disable model communication logs" },
  { name: "/sessions", usage: "/sessions [page_size]", description: "Browse saved sessions (↑/↓ select, ←/→ page, Enter resume)" },
  { name: "/resume", usage: "/resume [session_id]", description: "Resume a saved session (default/latest uses newest)" },
  { name: "/state", usage: "/state", description: "Show query engine state" },
  { name: "/reset", usage: "/reset", description: "Clear current transcript and add a reset marker" },
  { name: "/exit", usage: "/exit", description: "Quit", aliases: ["/quit"] },
];

export function parseReplCommand(line: string): ReplCommand {
  const trimmed = line.trim();
  if (trimmed === "/help") return { type: "help" };
  if (trimmed === "/cost") return { type: "cost" };
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
    const pageSize = argument ? Number(argument) : undefined;
    return { type: "sessions", pageSize: Number.isFinite(pageSize) && pageSize !== undefined && pageSize > 0 ? Math.floor(pageSize) : undefined };
  }
  if (trimmed === "/state") return { type: "state" };
  return { type: "input", text: line };
}

const helpUsageWidth = Math.max(...replCommandDefinitions.map((command) => command.usage.length));

export const helpText = [
  "Commands:",
  ...replCommandDefinitions.map((command) => `  ${command.usage.padEnd(helpUsageWidth)}  ${command.description}`),
].join("\n");

export type ReplCommand =
  | { type: "help" }
  | { type: "exit" }
  | { type: "reset" }
  | { type: "state" }
  | { type: "input"; text: string };

export function parseReplCommand(line: string): ReplCommand {
  const trimmed = line.trim();
  if (trimmed === "/help") return { type: "help" };
  if (trimmed === "/exit" || trimmed === "/quit") return { type: "exit" };
  if (trimmed === "/reset") return { type: "reset" };
  if (trimmed === "/state") return { type: "state" };
  return { type: "input", text: line };
}

export const helpText = [
  "Commands:",
  "  /help   Show commands",
  "  /state  Show query engine state",
  "  /reset  Clear in-memory transcript",
  "  /exit   Quit",
].join("\n");

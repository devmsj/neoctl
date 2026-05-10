export type ModelReasoningArgument = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "default" | "off";

export type ReplCommand =
  | { type: "help" }
  | { type: "cost" }
  | { type: "compact" }
  | { type: "pure" }
  | { type: "env" }
  | { type: "exit" }
  | { type: "export"; path: string }
  | { type: "login" }
  | { type: "log"; path?: string; off?: boolean }
  | { type: "model"; model?: string; reasoning?: ModelReasoningArgument }
  | { type: "new" }
  | { type: "reset" }
  | { type: "sessions" }
  | { type: "state" }
  | { type: "input"; text: string };

export type ReplCommandArgumentSpec = "none" | "required" | "optional" | "log";

export interface ReplCommandDefinition {
  name: string;
  usage: string;
  description: string;
  arguments: ReplCommandArgumentSpec;
  aliases?: string[];
}

export const replCommandDefinitions: ReplCommandDefinition[] = [
  { name: "/help", usage: "/help", description: "Show commands", arguments: "none" },
  { name: "/cost", usage: "/cost", description: "Show total token usage for this REPL session", arguments: "none" },
  { name: "/compact", usage: "/compact", description: "Manually compact earlier context", arguments: "none" },
  { name: "/pure", usage: "/pure", description: "Sanitize context after WAF/risk blocks without resetting", arguments: "none" },
  { name: "/export", usage: "/export <absolute-md-path>", description: "Export the current session transcript as detailed Markdown", arguments: "required" },
  { name: "/env", usage: "/env", description: "Open the neoctl configuration directory", arguments: "none" },
  { name: "/login", usage: "/login", description: "Configure and save a model provider to the env file", arguments: "none" },
  { name: "/model", usage: "/model [model-id] [effort|default|off]", description: "Show or switch model and supported reasoning effort", arguments: "optional" },
  { name: "/new", usage: "/new", description: "Start a new session; running current session continues in background", arguments: "none" },
  { name: "/log", usage: "/log <dir>", description: "Write model communication logs to an absolute directory", arguments: "required" },
  { name: "/log off", usage: "/log off", description: "Disable model communication logs", arguments: "none" },
  { name: "/sessions", usage: "/sessions", description: "Browse saved sessions", arguments: "none" },
  { name: "/state", usage: "/state", description: "Show query engine state", arguments: "none" },
  { name: "/reset", usage: "/reset", description: "Clear current transcript and add a reset marker", arguments: "none" },
  { name: "/exit", usage: "/exit", description: "Quit", arguments: "none", aliases: ["/quit"] },
];

export function parseReplCommand(line: string): ReplCommand {
  const parsed = parseSlashCommandLine(line);
  if (!parsed.valid) return { type: "input", text: line };

  const { name, argument } = parsed;
  if (name === "/help") return { type: "help" };
  if (name === "/cost") return { type: "cost" };
  if (name === "/compact") return { type: "compact" };
  if (name === "/pure") return { type: "pure" };
  if (name === "/export") return { type: "export", path: argument };
  if (name === "/env") return { type: "env" };
  if (name === "/login") return { type: "login" };
  if (name === "/exit" || name === "/quit") return { type: "exit" };
  if (name === "/model") return parseModelCommand(argument) ?? { type: "input", text: line };
  if (name === "/new") return { type: "new" };
  if (name === "/log") {
    if (argument.toLowerCase() === "off") return { type: "log", off: true };
    return { type: "log", path: argument };
  }
  if (name === "/reset") return { type: "reset" };
  if (name === "/sessions") return { type: "sessions" };
  if (name === "/state") return { type: "state" };
  return { type: "input", text: line };
}

export function isValidReplCommandLine(line: string): boolean {
  return parseSlashCommandLine(line).valid && parseReplCommand(line).type !== "input";
}

export function isModelReasoningArgument(value: string): value is ModelReasoningArgument {
  return value === "none" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max" || value === "default" || value === "off";
}

function parseModelCommand(argument: string): Extract<ReplCommand, { type: "model" }> | undefined {
  const tokens = argument.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { type: "model" };
  if (tokens.length > 2) return undefined;

  if (tokens.length === 1) {
    const [single] = tokens;
    return isModelReasoningArgument(single)
      ? { type: "model", reasoning: single }
      : { type: "model", model: single };
  }

  const [model, reasoning] = tokens;
  if (!isModelReasoningArgument(reasoning)) return undefined;
  return { type: "model", model, reasoning };
}

function parseSlashCommandLine(line: string): { valid: true; name: string; argument: string } | { valid: false } {
  if (!line.startsWith("/")) return { valid: false };
  const trimmed = line.trimEnd();
  const match = /^(\/\S+)(?:\s+(.*))?$/.exec(trimmed);
  if (!match) return { valid: false };

  const typedName = match[1].toLowerCase();
  const argument = match[2]?.trim() ?? "";
  const definition = replCommandDefinitions.find((command) =>
    command.name.toLowerCase() === typedName || command.aliases?.some((alias) => alias.toLowerCase() === typedName)
  );
  if (!definition) return { valid: false };

  if (definition.arguments === "none" && argument.length > 0) return { valid: false };
  if (definition.arguments === "required" && argument.length === 0) return { valid: false };
  if (definition.arguments === "log" && argument.length === 0) return { valid: false };

  return { valid: true, name: typedName, argument };
}

const helpUsageWidth = Math.max(...replCommandDefinitions.map((command) => command.usage.length));

export const helpText = [
  "Commands:",
  ...replCommandDefinitions.map((command) => `  ${command.usage.padEnd(helpUsageWidth)}  ${command.description}`),
].join("\n");

export interface CliReplCommandParseResult {
  line: string;
  definition: ReplCommandDefinition;
}

export function parseCliReplCommandArgs(argv: string[]): CliReplCommandParseResult | undefined {
  if (argv.length === 0) return undefined;
  const first = argv[0];
  const match = /^--?([^=\s]+)(?:=(.*))?$/.exec(first);
  if (!match) return undefined;

  const commandName = `/${match[1].toLowerCase()}`;
  const definition = replCommandDefinitions.find((command) =>
    command.name.toLowerCase() === commandName || command.aliases?.some((alias) => alias.toLowerCase() === commandName)
  );
  if (!definition) return undefined;

  const inlineArgument = match[2];
  const rest = inlineArgument === undefined ? argv.slice(1) : [inlineArgument, ...argv.slice(1)];
  if (definition.arguments === "none" && rest.length > 0) return undefined;
  if ((definition.arguments === "required" || definition.arguments === "log") && rest.length === 0) return undefined;

  const line = rest.length === 0 ? definition.name : `${definition.name} ${rest.join(" ")}`;
  return { line, definition };
}

const cliUsageWidth = Math.max(...replCommandDefinitions.map((command) => command.usage.replace(/^\//, "-").length));

export function cliHelpText(binaryName = "neo"): string {
  return [
    `Usage: ${binaryName} [command]`,
    "",
    "CLI commands mirror REPL slash commands. Use '-' or '--' in place of '/'.",
    "",
    "Commands:",
    ...replCommandDefinitions.map((command) => {
      const usage = command.usage.replace(/^\//, "-");
      return `  ${usage.padEnd(cliUsageWidth)}  ${command.description}`;
    }),
    "",
    "Examples:",
    `  ${binaryName} -help`,
    `  ${binaryName} -model`,
    `  ${binaryName} -model gpt-5.5 high`,
    `  ${binaryName} -new`,
    "",
    "Inside the REPL, use the original slash form such as /help or /model.",
  ].join("\n");
}

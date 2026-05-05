import type { ToolUseContext } from "../tools/tool";

export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__";

export interface PromptSection {
  name: string;
  content: string;
  cacheStable?: boolean;
}

export interface EffectiveSystemPromptOptions {
  overrideSystemPrompt?: string;
  coordinatorPrompt?: string;
  agentPrompt?: string | ((context?: ToolUseContext) => string);
  agentPromptMode?: "replace" | "proactive_append";
  customSystemPrompt?: string;
  appendSystemPrompt?: string;
  toolUseContext?: ToolUseContext;
}

export function buildDefaultSystemPromptSections(enabledTools: readonly string[] = []): PromptSection[] {
  return [
    {
      name: "Agent Scaffold",
      cacheStable: true,
      content: [
        "You are an engineering agent running inside a TypeScript scaffold.",
        "Drive tasks through the shared query loop, tool system, context manager, and model gateway.",
      ].join("\n"),
    },
    {
      name: "Doing Tasks",
      cacheStable: true,
      content: [
        "Keep work concrete and verifiable.",
        "Use tools for real workspace changes and report validation results precisely.",
      ].join("\n"),
    },
    {
      name: "Using Tools",
      cacheStable: true,
      content: enabledTools.length
        ? `Available tools are provided separately. Stable tool prefix: ${enabledTools.join(", ")}.`
        : "Available tools are provided separately by the runtime.",
    },
    {
      name: "Tone And Output",
      cacheStable: true,
      content: "Be direct, concise, and action-oriented. Avoid inventing file contents or command results.",
    },
  ];
}

export function buildEffectiveSystemPrompt(
  sections: readonly PromptSection[] = buildDefaultSystemPromptSections(),
  options: EffectiveSystemPromptOptions = {},
): string {
  const replacement = promptReplacement(options);
  const base = replacement ?? renderSectionGroups(sections);
  const withProactiveAgent = !replacement && options.agentPrompt && options.agentPromptMode === "proactive_append"
    ? `${base}\n\n${renderLooseSection("Agent Prompt", resolveAgentPrompt(options))}`
    : base;

  if (!options.appendSystemPrompt?.trim()) return withProactiveAgent;
  return `${withProactiveAgent}\n\n${renderLooseSection("Appended System Prompt", options.appendSystemPrompt.trim())}`;
}

export function splitSystemPromptPrefix(systemPrompt: string): { stablePrefix: string; dynamicSuffix: string } {
  const index = systemPrompt.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
  if (index < 0) return { stablePrefix: systemPrompt, dynamicSuffix: "" };
  return {
    stablePrefix: systemPrompt.slice(0, index).trimEnd(),
    dynamicSuffix: systemPrompt.slice(index + SYSTEM_PROMPT_DYNAMIC_BOUNDARY.length).trimStart(),
  };
}

function promptReplacement(options: EffectiveSystemPromptOptions): string | undefined {
  if (options.overrideSystemPrompt?.trim()) return options.overrideSystemPrompt.trim();
  if (options.coordinatorPrompt?.trim()) return options.coordinatorPrompt.trim();
  if (options.agentPrompt && options.agentPromptMode !== "proactive_append") return resolveAgentPrompt(options);
  if (options.customSystemPrompt?.trim()) return options.customSystemPrompt.trim();
  return undefined;
}

function renderSectionGroups(sections: readonly PromptSection[]): string {
  const stable = sections.filter((section) => section.cacheStable !== false).map(renderSection);
  const dynamic = sections.filter((section) => section.cacheStable === false).map(renderSection);
  return [...stable, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, ...dynamic].filter(Boolean).join("\n\n");
}

function renderSection(section: PromptSection): string {
  return renderLooseSection(section.name, section.content);
}

function renderLooseSection(name: string, content: string): string {
  return `## ${name}\n${content}`;
}

function resolveAgentPrompt(options: EffectiveSystemPromptOptions): string {
  const prompt = typeof options.agentPrompt === "function" ? options.agentPrompt(options.toolUseContext) : options.agentPrompt;
  return prompt?.trim() ?? "";
}

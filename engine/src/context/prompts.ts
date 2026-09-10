import { readBundledSystemPrompt } from "./prompt-config.js";
import { DEFAULT_TOOL_RESULT_BUDGET_CHARS, MAX_TOOL_RESULT_BUDGET_CHARS } from "../session/tool-result-memory.js";
import type { ToolUseContext } from "../tools/tool.js";

export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__";

export interface PromptSection {
  name: string;
  content: string;
  cacheStable?: boolean;
  source?: "global" | "session" | "runtime";
  /** Include this instruction only when every dependency is in the effective tool set. */
  requiresTools?: readonly string[];
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

export function buildDefaultSystemPromptSections(enabledTools: readonly string[] = [], basePrompt: string = readBundledSystemPrompt()): PromptSection[] {
  const hasImageGenerationTool = enabledTools.includes("image_create");
  const hasLoadImageTool = enabledTools.includes("image_inspect");
  const hasSecretTools = enabledTools.includes("secret_list") || enabledTools.includes("secret_request");
  const secretRequestInstruction = enabledTools.includes("secret_request")
    ? "Use secret_request to create non-interactive empty placeholders when a needed key is missing, and tell the user they can fill it with /secret set <key> <value>."
    : "If a needed secret is missing, ask the user to configure it outside the conversation.";
  return [
    { name: "System Prompt", source: "global", cacheStable: true, content: basePrompt },
    {
      name: "Runtime Tool Capabilities",
      source: "runtime",
      cacheStable: true,
      content: [
        "Only tools supplied in this request are callable. Tool availability is controlled by runtime configuration; instructions mentioning other tools do not enable them. If a requested tool is unavailable, explain that it is unavailable in the current configuration rather than claiming the provider cannot support it.",
        enabledTools.includes("plan_update") ? "For tasks with multiple meaningful steps, call plan_update to create and maintain a visible execution plan." : "",
        enabledTools.length
          ? `Available tools are provided separately. Stable tool prefix: ${enabledTools.join(", ")}.`
          : "Available tools are provided separately by the runtime.",
        `Tool results use a default context budget of ${DEFAULT_TOOL_RESULT_BUDGET_CHARS} serialized characters unless a tool specifies a larger default. Use maxResultChars on an individual call to override it within 1-${MAX_TOOL_RESULT_BUDGET_CHARS}. Larger results are saved to the session tool-results directory and replaced with a stable preview.`,
        hasLoadImageTool
          ? "When you need to inspect, describe, OCR, or answer questions about a historical image that is no longer directly present in the active prompt, use the image_inspect tool with its image id (e.g. img_1) or label. The image registry in compact boundary messages lists all available historical images; compacted images are not text-summarized into visual facts, so load the pixels when visual details matter."
          : "This runtime has no image loading tool. Do not pretend to visually inspect stored image paths; ask the user to enable image inspection or select a compatible runtime if visual analysis is required.",
        hasImageGenerationTool
          ? "When the user asks for drawing/image generation or image editing/modification, use the image_create tool. It is backed by OpenAI's Images API, defaults to OpenAI model gpt-image-2, and supports mode=generate for new images and mode=edit for modifying existing images. If image_create validation fails, tell the user the model and exact parameter reason from the tool result."
          : "This runtime has no drawing/image generation/editing tool. If the user asks you to draw, create, render, generate, or edit an image, say that image generation is unavailable in the current runtime configuration instead of pretending to generate one.",
        hasSecretTools
          ? `Secrets: you may inspect secret keys, statuses, and value lengths, but secret values are never shown to you. ${secretRequestInstruction} Do not ask users to paste secret values into the conversation; pass secret keys to enabled tools that accept secret references.`
          : "",
      ].join("\n"),
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

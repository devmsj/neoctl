import type { SessionPromptExportSnapshot } from "../session/session-export.js";
import type { JsonSchema, ToolDefinition } from "../tools/tool.js";

export const WEB_RUNTIME_CONTEXT_PROTOCOL_VERSION = 1 as const;

export interface WebRuntimePromptSection {
  name: string;
  content: string;
  cacheStable: boolean;
  chars: number;
}

export interface WebRuntimeToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  strict: boolean;
}

export interface WebRuntimeContextPayload {
  protocolVersion: typeof WEB_RUNTIME_CONTEXT_PROTOCOL_VERSION;
  revision: number;
  generatedAt: string;
  sessionId?: string;
  model?: string;
  reasoning?: unknown;
  prompt: {
    systemPrompt: string;
    chars: number;
    stableSections: number;
    dynamicSections: number;
    sections: WebRuntimePromptSection[];
    appPrompt?: unknown;
    userContext?: unknown;
    systemContext?: unknown;
    userContextPrompt?: string;
  };
  tools: WebRuntimeToolDefinition[];
  capabilities: {
    commands: string[];
    agents: string[];
    skills: string[];
    plugins: string[];
  };
}

export function createWebRuntimeContextPayload(
  snapshot: SessionPromptExportSnapshot,
  options: { revision: number; sessionId?: string; generatedAt?: string },
): WebRuntimeContextPayload {
  const sections = normalizePromptSections(snapshot.promptSections);
  const systemPrompt = typeof snapshot.systemPrompt === "string" ? snapshot.systemPrompt : "";
  return {
    protocolVersion: WEB_RUNTIME_CONTEXT_PROTOCOL_VERSION,
    revision: options.revision,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    sessionId: options.sessionId,
    model: snapshot.model,
    reasoning: snapshot.reasoning,
    prompt: {
      systemPrompt,
      chars: systemPrompt.length,
      stableSections: sections.filter((section) => section.cacheStable).length,
      dynamicSections: sections.filter((section) => !section.cacheStable).length,
      sections,
      appPrompt: snapshot.appPrompt,
      userContext: snapshot.userContext,
      systemContext: snapshot.systemContext,
      userContextPrompt: snapshot.userContextPrompt,
    },
    tools: normalizeToolDefinitions(snapshot.toolDefinitions),
    capabilities: {
      commands: normalizeStringArray(snapshot.commands),
      agents: normalizeStringArray(snapshot.agents),
      skills: normalizeStringArray(snapshot.skills),
      plugins: normalizeStringArray(snapshot.plugins),
    },
  };
}

function normalizePromptSections(value: unknown): WebRuntimePromptSection[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((section) => {
    if (!isRecord(section) || typeof section.name !== "string" || typeof section.content !== "string") return [];
    return [{
      name: section.name,
      content: section.content,
      cacheStable: section.cacheStable !== false,
      chars: section.content.length,
    }];
  });
}

function normalizeToolDefinitions(value: unknown): WebRuntimeToolDefinition[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((tool) => {
    if (!isToolDefinition(tool)) return [];
    return [{
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      strict: tool.strict === true,
    }];
  });
}

function isToolDefinition(value: unknown): value is ToolDefinition {
  return isRecord(value)
    && typeof value.name === "string"
    && typeof value.description === "string"
    && isRecord(value.inputSchema);
}

function normalizeStringArray(value: readonly string[] | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

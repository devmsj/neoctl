import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AppPromptStore } from "../app/app-prompt.js";
import type { ToolUseContext } from "../tools/tool.js";
import type { Message } from "../types/messages.js";
import {
  buildDefaultSystemPromptSections,
  buildEffectiveSystemPrompt,
  type EffectiveSystemPromptOptions,
  type PromptSection,
} from "./prompts.js";

export interface ContextBuildInput extends EffectiveSystemPromptOptions {
  agentId: string;
  messages: readonly Message[];
  cwd?: string;
  enabledTools?: readonly string[];
  toolUseContext?: ToolUseContext;
  omitProjectMemory?: boolean;
}

export interface UserContext {
  currentDate: string;
  projectMemory?: string;
  memoryFiles?: string[];
}

export interface SystemContext {
  cwd: string;
  platform: NodeJS.Platform;
}

export interface RuntimeContext {
  systemPrompt: string;
  promptSections: PromptSection[];
  userContext: UserContext;
  systemContext: SystemContext;
}

export interface ContextManager {
  build(input: ContextBuildInput): Promise<RuntimeContext>;
}

export interface DefaultContextManagerOptions {
  cwd?: string;
  memoryFileNames?: readonly string[];
  currentDate?: () => string;
}

export interface AppPromptContextManagerOptions {
  sectionName?: string;
  cacheStable?: boolean;
}

export class AdditionalPromptContextManager implements ContextManager {
  private sections: PromptSection[];

  constructor(
    private readonly base: ContextManager,
    sections: readonly PromptSection[] = [],
  ) {
    this.sections = normalizeAdditionalPromptSections(sections);
  }

  setSections(sections: readonly PromptSection[]): void {
    this.sections = normalizeAdditionalPromptSections(sections);
  }

  async build(input: ContextBuildInput): Promise<RuntimeContext> {
    const runtimeContext = await this.base.build(input);
    if (this.sections.length === 0) return runtimeContext;
    const promptSections = [...runtimeContext.promptSections, ...this.sections];
    return {
      ...runtimeContext,
      promptSections,
      systemPrompt: buildEffectiveSystemPrompt(promptSections, input),
    };
  }
}

function normalizeAdditionalPromptSections(sections: readonly PromptSection[]): PromptSection[] {
  return sections
      .filter((section) => section.name.trim() && section.content.trim())
      .map((section) => ({ ...section, name: section.name.trim(), content: section.content.trim() }));
}

export class DefaultContextManager implements ContextManager {
  private readonly cwd: string;
  private userContextCache?: UserContext;
  private systemContextCache?: SystemContext;

  constructor(private readonly options: DefaultContextManagerOptions = {}) {
    this.cwd = resolve(options.cwd ?? process.cwd());
  }

  async build(input: ContextBuildInput): Promise<RuntimeContext> {
    const cwd = resolve(input.cwd ?? this.cwd);
    const promptSections = [
      ...buildDefaultSystemPromptSections(input.enabledTools ?? []),
      {
        name: "Runtime",
        cacheStable: false,
        content: `agentId=${input.agentId}`,
      },
    ];

    const systemPrompt = buildEffectiveSystemPrompt(promptSections, input);
    const userContext = input.omitProjectMemory ? stripProjectMemory(this.getUserContext(cwd)) : this.getUserContext(cwd);
    const systemContext = this.getSystemContext(cwd);

    return { systemPrompt, promptSections, userContext, systemContext };
  }

  private getUserContext(cwd: string): UserContext {
    if (this.userContextCache) return this.userContextCache;
    const memory = readProjectMemory(cwd, this.options.memoryFileNames ?? DEFAULT_MEMORY_FILE_NAMES);
    this.userContextCache = {
      currentDate: this.options.currentDate?.() ?? new Date().toISOString().slice(0, 10),
      ...(memory.content ? { projectMemory: memory.content, memoryFiles: memory.files } : {}),
    };
    return this.userContextCache;
  }

  private getSystemContext(cwd: string): SystemContext {
    if (this.systemContextCache) return this.systemContextCache;
    this.systemContextCache = {
      cwd,
      platform: process.platform,
    };
    return this.systemContextCache;
  }
}

export class NoopContextManager extends DefaultContextManager {}

export class AppPromptContextManager implements ContextManager {
  constructor(
    private readonly base: ContextManager,
    private readonly appPromptStore: AppPromptStore,
    private readonly options: AppPromptContextManagerOptions = {},
  ) {}

  async build(input: ContextBuildInput): Promise<RuntimeContext> {
    const runtimeContext = await this.base.build(input);
    const activePrompt = this.appPromptStore.getAppPrompt();
    if (!activePrompt) return runtimeContext;
    const promptSections = [
      ...runtimeContext.promptSections,
      {
        name: this.options.sectionName ?? formatAppPromptSectionName(activePrompt.title),
        cacheStable: this.options.cacheStable ?? false,
        content: activePrompt.content,
      },
    ];
    return {
      ...runtimeContext,
      promptSections,
      systemPrompt: buildEffectiveSystemPrompt(promptSections, input),
    };
  }
}

const DEFAULT_MEMORY_FILE_NAMES = [
  "AGENTS.md",
  "CLAUDE.md",
  ".agent/memory.md",
  ".codex/memory.md",
  ".github/copilot-instructions.md",
];

function readProjectMemory(cwd: string, memoryFileNames: readonly string[]): { content?: string; files?: string[] } {
  const parts: string[] = [];
  const files: string[] = [];
  for (const name of memoryFileNames) {
    const path = join(cwd, name);
    if (!existsSync(path)) continue;
    const content = readFileSync(path, "utf8").trim();
    if (!content) continue;
    files.push(path);
    parts.push(`### ${name}\n${content}`);
  }
  return parts.length ? { content: parts.join("\n\n"), files } : {};
}

function stripProjectMemory(context: UserContext): UserContext {
  const { projectMemory: _projectMemory, memoryFiles: _memoryFiles, ...rest } = context;
  return rest;
}

function formatAppPromptSectionName(title: string | undefined): string {
  return title ? `Application Prompt: ${title}` : "Application Prompt";
}

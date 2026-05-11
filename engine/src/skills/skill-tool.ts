import { createTextMessage } from "../types/messages.js";
import type { CanUseTool, JsonSchema, Tool, ToolRuntimeOptions } from "../tools/tool.js";

export type SkillExecutionMode = "inline" | "fork";
export type SkillEffort = "minimal" | "low" | "medium" | "high";
export type SkillTrustLevel = "builtin" | "workspace" | "user" | "plugin" | "generated" | "remote";

export interface SkillExample {
  input?: unknown;
  output?: unknown;
  description?: string;
}

export interface SkillPermission {
  kind: "tool" | "network" | "filesystem" | "env" | "model" | string;
  value?: string;
  reason?: string;
}

export interface SkillSourceInfo {
  kind: "memory" | "filesystem" | "plugin" | "remote" | "generated" | string;
  root?: string;
  path?: string;
  plugin?: string;
  uri?: string;
}

export interface SkillDescriptor {
  name: string;
  description: string;
  entrypoint: string;
  execution: SkillExecutionMode;
  allowedTools?: readonly string[];
  model?: string;
  effort?: SkillEffort;
  disableModelInvocation?: boolean;

  version?: string;
  title?: string;
  tags?: readonly string[];
  argumentHint?: string;
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
  permissions?: readonly SkillPermission[];
  examples?: readonly SkillExample[];
  metadata?: Record<string, unknown>;
  enabled?: boolean;
  trustLevel?: SkillTrustLevel;
  source?: SkillSourceInfo;
  createdAt?: string;
  updatedAt?: string;
}

export interface SkillCatalog {
  list(): Promise<SkillDescriptor[]>;
  get(name: string): Promise<SkillDescriptor | undefined>;
}

export interface MutableSkillCatalog extends SkillCatalog {
  create(skill: SkillDescriptor, options?: SkillWriteOptions): Promise<SkillDescriptor>;
  update(name: string, patch: SkillUpdatePatch, options?: SkillWriteOptions): Promise<SkillDescriptor>;
  delete(name: string, options?: SkillWriteOptions): Promise<boolean>;
}

export interface SkillWriteOptions {
  overwrite?: boolean;
  actor?: string;
  reason?: string;
}

export type SkillUpdatePatch = Partial<Omit<SkillDescriptor, "name" | "source" | "createdAt">> & {
  name?: never;
};

export interface SkillToolInput {
  skill?: string;
  name?: string;
  args?: string;
  input?: unknown;
}

export interface CreateSkillToolOptions {
  description?: string;
  exposeCatalogHint?: boolean;
}

export interface SkillValidationOptions {
  allowDisabled?: boolean;
  requireEntrypoint?: boolean;
}

export interface SkillValidationIssue {
  path: string;
  message: string;
}

export type SkillValidationResult =
  | { ok: true; value: SkillDescriptor; issues: [] }
  | { ok: false; issues: SkillValidationIssue[] };

export function createSkillTool(catalog: SkillCatalog, options: CreateSkillToolOptions = {}): Tool<SkillToolInput> {
  return {
    name: "skill",
    aliases: ["Skill"],
    description: options.description ?? buildSkillToolDescription(options),
    inputSchema: {
      type: "object",
      properties: {
        skill: { type: "string", description: "Skill name to invoke." },
        name: { type: "string", description: "Alias for skill." },
        args: { type: "string", description: "Human-readable arguments for the skill." },
        input: { description: "Structured arguments for the skill." },
      },
      additionalProperties: false,
    },
    metadata: { readOnly: false, concurrent: false, visible: true, shouldDefer: true, searchHint: "skill workflow" },
    validate(input: unknown) {
      return input as SkillToolInput;
    },
    async validateInput(input) {
      const name = normalizeSkillName(input.skill ?? input.name);
      if (!name) return { ok: false, message: "skill.skill or skill.name is required" };
      const skill = await catalog.get(name);
      if (!skill) return { ok: false, message: `Unknown skill: ${name}` };
      if (skill.enabled === false) return { ok: false, message: `Skill ${name} is disabled` };
      if (skill.disableModelInvocation) return { ok: false, message: `Skill ${name} cannot be invoked by the model` };
      return { ok: true, value: { ...input, skill: name } };
    },
    async call(input) {
      const name = normalizeSkillName(input.skill ?? input.name);
      const skill = name ? await catalog.get(name) : undefined;
      if (!name || !skill) return { ok: false, output: { error: `Unknown skill: ${name ?? "<empty>"}` } };
      if (skill.enabled === false) return { ok: false, output: { error: `Skill ${name} is disabled` } };

      if (skill.execution === "fork") {
        return {
          ok: false,
          output: {
            status: "fork_required",
            skill: name,
            message: "Forked skill execution requires launching AgentTool with the skill prompt in this scaffold.",
            descriptor: summarizeSkill(skill),
          },
        };
      }

      const args = renderSkillArgs(input.args ?? input.input);
      const prompt = renderSkillPrompt(skill, args);

      return {
        ok: true,
        output: {
          status: "injected",
          skill: name,
          allowed_tools: skill.allowedTools ?? [],
          model: skill.model,
          effort: skill.effort,
          descriptor: summarizeSkill(skill),
        },
        newMessages: [
          {
            ...createTextMessage("user", prompt),
            isMeta: true,
            metadata: { skill: name, skillExecution: "inline" },
          },
        ],
        contextModifier: (context) => ({
          ...context,
          options: {
            ...context.options,
            mainLoopModel: skill.model ?? context.options?.mainLoopModel,
            thinkingConfig: skill.effort ? { effort: skill.effort } : context.options?.thinkingConfig,
            activeSkill: {
              name,
              allowedTools: [...(skill.allowedTools ?? [])],
              model: skill.model,
              effort: skill.effort,
              source: skill.source,
            },
          } satisfies ToolRuntimeOptions,
        }),
      };
    },
  };
}

export class InMemorySkillCatalog implements MutableSkillCatalog {
  private readonly skills = new Map<string, SkillDescriptor>();

  constructor(skills: readonly SkillDescriptor[] = []) {
    for (const skill of skills) this.skills.set(requireSkillName(skill.name), normalizeSkillDescriptor(skill, { requireEntrypoint: true }));
  }

  async list(): Promise<SkillDescriptor[]> {
    return [...this.skills.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  async get(name: string): Promise<SkillDescriptor | undefined> {
    return this.skills.get(normalizeSkillName(name) ?? name);
  }

  async create(skill: SkillDescriptor, options: SkillWriteOptions = {}): Promise<SkillDescriptor> {
    const normalized = normalizeSkillDescriptor(skill, { requireEntrypoint: true });
    if (!options.overwrite && this.skills.has(normalized.name)) throw new Error(`Skill already exists: ${normalized.name}`);
    const now = new Date().toISOString();
    const stored = {
      ...normalized,
      source: normalized.source ?? { kind: "memory" },
      createdAt: normalized.createdAt ?? now,
      updatedAt: now,
    };
    this.skills.set(stored.name, stored);
    return stored;
  }

  async update(name: string, patch: SkillUpdatePatch): Promise<SkillDescriptor> {
    const normalizedName = requireSkillName(name);
    const current = this.skills.get(normalizedName);
    if (!current) throw new Error(`Unknown skill: ${normalizedName}`);
    const updated = normalizeSkillDescriptor({ ...current, ...patch, name: normalizedName }, { requireEntrypoint: true });
    const stored = { ...updated, createdAt: current.createdAt, source: current.source, updatedAt: new Date().toISOString() };
    this.skills.set(normalizedName, stored);
    return stored;
  }

  async delete(name: string): Promise<boolean> {
    return this.skills.delete(requireSkillName(name));
  }
}

export function validateSkillDescriptor(input: unknown, options: SkillValidationOptions = {}): SkillValidationResult {
  const issues: SkillValidationIssue[] = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, issues: [{ path: "skill", message: "Skill descriptor must be an object" }] };
  }

  const value = input as Partial<SkillDescriptor>;
  const name = normalizeSkillName(value.name);
  if (!name) issues.push({ path: "name", message: "Skill name is required" });
  else if (!isValidSkillName(name)) issues.push({ path: "name", message: "Skill name may contain letters, numbers, dot, underscore, or dash only" });

  if (!value.description?.trim()) issues.push({ path: "description", message: "Skill description is required" });
  if (options.requireEntrypoint !== false && !value.entrypoint?.trim()) issues.push({ path: "entrypoint", message: "Skill entrypoint is required" });
  if (value.execution && value.execution !== "inline" && value.execution !== "fork") issues.push({ path: "execution", message: "Skill execution must be inline or fork" });
  if (value.effort && !["minimal", "low", "medium", "high"].includes(value.effort)) issues.push({ path: "effort", message: "Skill effort is invalid" });
  if (value.enabled === false && !options.allowDisabled) issues.push({ path: "enabled", message: "Skill is disabled" });
  if (value.allowedTools && !Array.isArray(value.allowedTools)) issues.push({ path: "allowedTools", message: "allowedTools must be an array" });
  if (value.tags && !Array.isArray(value.tags)) issues.push({ path: "tags", message: "tags must be an array" });

  if (issues.length) return { ok: false, issues };
  return { ok: true, value: normalizeSkillDescriptor(value as SkillDescriptor, options), issues: [] };
}

export function normalizeSkillDescriptor(skill: SkillDescriptor, options: SkillValidationOptions = {}): SkillDescriptor {
  const validation = validateSkillDescriptorShallow(skill, options);
  if (validation.length) throw new Error(validation.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
  return {
    ...skill,
    name: requireSkillName(skill.name),
    description: skill.description.trim(),
    entrypoint: (skill.entrypoint ?? "").trim(),
    execution: skill.execution ?? "inline",
    allowedTools: normalizeStringList(skill.allowedTools),
    tags: normalizeStringList(skill.tags),
    enabled: skill.enabled ?? true,
  };
}

export function normalizeSkillName(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/^\/+/, "");
  return normalized || undefined;
}

export function isValidSkillName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) && !name.includes("..") && !/[\\/]/.test(name);
}

export function requireSkillName(value: string | undefined): string {
  const name = normalizeSkillName(value);
  if (!name || !isValidSkillName(name)) throw new Error(`Invalid skill name: ${value ?? "<empty>"}`);
  return name;
}

export function renderSkillPrompt(skill: SkillDescriptor, args = ""): string {
  return [
    `<skill name="${escapeXml(skill.name)}">`,
    skill.entrypoint,
    args ? `\n<skill-args>\n${args}\n</skill-args>` : "",
    `</skill>`,
  ].join("\n");
}

export function summarizeSkill(skill: SkillDescriptor): Record<string, unknown> {
  return {
    name: skill.name,
    title: skill.title,
    description: skill.description,
    version: skill.version,
    execution: skill.execution,
    tags: skill.tags,
    allowedTools: skill.allowedTools,
    model: skill.model,
    effort: skill.effort,
    enabled: skill.enabled !== false,
    trustLevel: skill.trustLevel,
    source: skill.source,
  };
}

export function createSkillAwareCanUseTool(
  catalog: SkillCatalog,
  delegate?: CanUseTool,
  options: { enforceAllowedTools?: boolean } = {},
): CanUseTool {
  return async (toolUse, context) => {
    const delegated = delegate ? await delegate(toolUse, context) : { allowed: true };
    const delegatedAllowed = typeof delegated === "boolean" ? delegated : delegated.allowed;
    if (!delegatedAllowed) return delegated;

    const activeSkill = context.options?.activeSkill;
    if (!activeSkill || options.enforceAllowedTools === false) return delegated;
    const descriptor = await catalog.get(activeSkill.name);
    const allowedTools = descriptor?.allowedTools ?? activeSkill.allowedTools;
    if (!allowedTools?.length || allowedTools.includes("*")) return delegated;

    const tool = context.tools.get(toolUse.name) ?? context.tools.getByAlias?.(toolUse.name);
    const canonicalName = tool?.name ?? toolUse.name;
    if (canonicalName === "skill" || allowedTools.includes(canonicalName) || allowedTools.includes(toolUse.name)) return delegated;
    return { allowed: false, reason: `Tool ${canonicalName} is not allowed while skill ${activeSkill.name} is active` };
  };
}

function buildSkillToolDescription(options: CreateSkillToolOptions): string {
  const hint = options.exposeCatalogHint === false ? "" : " Use skill_list to discover available skills and skill_read to inspect details.";
  return `Load a reusable prompt workflow. Inline skills inject prompt messages into the next model turn; fork skills request child-agent execution.${hint}`;
}

function validateSkillDescriptorShallow(skill: SkillDescriptor, options: SkillValidationOptions): SkillValidationIssue[] {
  const issues: SkillValidationIssue[] = [];
  const name = normalizeSkillName(skill.name);
  if (!name) issues.push({ path: "name", message: "Skill name is required" });
  else if (!isValidSkillName(name)) issues.push({ path: "name", message: "Skill name may contain letters, numbers, dot, underscore, or dash only" });
  if (!skill.description?.trim()) issues.push({ path: "description", message: "Skill description is required" });
  if (options.requireEntrypoint !== false && !skill.entrypoint?.trim()) issues.push({ path: "entrypoint", message: "Skill entrypoint is required" });
  if (skill.execution && skill.execution !== "inline" && skill.execution !== "fork") issues.push({ path: "execution", message: "Skill execution must be inline or fork" });
  if (skill.effort && !["minimal", "low", "medium", "high"].includes(skill.effort)) issues.push({ path: "effort", message: "Skill effort is invalid" });
  return issues;
}

function normalizeStringList(values: readonly string[] | undefined): string[] | undefined {
  if (!values) return undefined;
  const normalized = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  return normalized.length ? normalized : undefined;
}

function renderSkillArgs(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

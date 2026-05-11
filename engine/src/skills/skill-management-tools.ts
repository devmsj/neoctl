import type { Tool } from "../tools/tool.js";
import type { MutableSkillCatalog, SkillCatalog, SkillDescriptor, SkillUpdatePatch } from "./skill-tool.js";
import { normalizeSkillDescriptor, requireSkillName, summarizeSkill, validateSkillDescriptor } from "./skill-tool.js";

export interface SkillListToolInput {
  includeDisabled?: boolean;
  tag?: string;
  query?: string;
}

export interface SkillReadToolInput {
  name: string;
  includeEntrypoint?: boolean;
}

export interface SkillCreateToolInput {
  skill: SkillDescriptor;
  overwrite?: boolean;
}

export interface SkillUpdateToolInput {
  name: string;
  patch: SkillUpdatePatch;
}

export interface SkillDeleteToolInput {
  name: string;
}

export interface SkillValidateToolInput {
  skill: unknown;
}

export interface SkillManagementToolOptions {
  requireApproval?: boolean;
  allowDelete?: boolean;
}

export function createSkillListTool(catalog: SkillCatalog): Tool<SkillListToolInput> {
  return {
    name: "skill_list",
    description: "List available reusable agent skills. Use this before invoking an unfamiliar skill.",
    inputSchema: {
      type: "object",
      properties: {
        includeDisabled: { type: "boolean" },
        tag: { type: "string" },
        query: { type: "string" },
      },
      additionalProperties: false,
    },
    metadata: { readOnly: true, concurrent: true, visible: true, searchHint: "skill catalog" },
    validate(input) {
      return input as SkillListToolInput;
    },
    async call(input) {
      const query = input.query?.trim().toLowerCase();
      const tag = input.tag?.trim().toLowerCase();
      const skills = (await catalog.list())
        .filter((skill) => input.includeDisabled || skill.enabled !== false)
        .filter((skill) => !tag || skill.tags?.some((value) => value.toLowerCase() === tag))
        .filter((skill) => !query || [skill.name, skill.title, skill.description, ...(skill.tags ?? [])].some((value) => value?.toLowerCase().includes(query)))
        .map(summarizeSkill);
      return { ok: true, output: { skills } };
    },
  };
}

export function createSkillReadTool(catalog: SkillCatalog): Tool<SkillReadToolInput> {
  return {
    name: "skill_read",
    description: "Read one skill descriptor. Set includeEntrypoint when the full skill prompt is needed.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        includeEntrypoint: { type: "boolean" },
      },
      required: ["name"],
      additionalProperties: false,
    },
    metadata: { readOnly: true, concurrent: true, visible: true, searchHint: "skill catalog" },
    validate(input) {
      return input as SkillReadToolInput;
    },
    async call(input) {
      const name = requireSkillName(input.name);
      const skill = await catalog.get(name);
      if (!skill) return { ok: false, output: { error: `Unknown skill: ${name}` } };
      const output = input.includeEntrypoint ? skill : summarizeSkill(skill);
      return { ok: true, output };
    },
  };
}

export function createSkillValidateTool(): Tool<SkillValidateToolInput> {
  return {
    name: "skill_validate",
    description: "Validate a proposed skill descriptor before creating or updating it.",
    inputSchema: {
      type: "object",
      properties: { skill: {} },
      required: ["skill"],
      additionalProperties: false,
    },
    metadata: { readOnly: true, concurrent: true, visible: true, searchHint: "skill authoring" },
    validate(input) {
      return input as SkillValidateToolInput;
    },
    async call(input) {
      const result = validateSkillDescriptor(input.skill, { requireEntrypoint: true, allowDisabled: true });
      return result.ok
        ? { ok: true, output: { ok: true, skill: summarizeSkill(result.value) } }
        : { ok: false, output: { ok: false, issues: result.issues } };
    },
  };
}

export function createSkillCreateTool(catalog: MutableSkillCatalog, options: SkillManagementToolOptions = {}): Tool<SkillCreateToolInput> {
  return {
    name: "skill_create",
    description: "Create a new reusable skill plugin from a validated descriptor. Use for agent-authored skills.",
    inputSchema: {
      type: "object",
      properties: {
        skill: { type: "object" },
        overwrite: { type: "boolean" },
      },
      required: ["skill"],
      additionalProperties: false,
    },
    metadata: { readOnly: false, concurrent: false, visible: true, requiresApproval: options.requireApproval ?? true, searchHint: "skill authoring" },
    validate(input) {
      return input as SkillCreateToolInput;
    },
    async call(input, context) {
      const validation = validateSkillDescriptor(input.skill, { requireEntrypoint: true, allowDisabled: true });
      if (!validation.ok) return { ok: false, output: { error: "Invalid skill descriptor", issues: validation.issues } };
      const created = await catalog.create(
        normalizeSkillDescriptor({ ...validation.value, trustLevel: validation.value.trustLevel ?? "generated" }),
        { overwrite: input.overwrite, actor: context.agentId },
      );
      await context.options?.refreshTools?.();
      return {
        ok: true,
        output: { status: "created", skill: summarizeSkill(created) },
        newMessages: [{
          ...importMetaMessage(`Skill ${created.name} has been created and is now available through the skill tool.`),
          metadata: { skill: created.name, skillManagement: "created" },
        }],
      };
    },
  };
}

export function createSkillUpdateTool(catalog: MutableSkillCatalog, options: SkillManagementToolOptions = {}): Tool<SkillUpdateToolInput> {
  return {
    name: "skill_update",
    description: "Update an existing reusable skill descriptor. Prefer reading and validating before updating.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        patch: { type: "object" },
      },
      required: ["name", "patch"],
      additionalProperties: false,
    },
    metadata: { readOnly: false, concurrent: false, visible: true, requiresApproval: options.requireApproval ?? true, searchHint: "skill authoring" },
    validate(input) {
      return input as SkillUpdateToolInput;
    },
    async call(input, context) {
      const updated = await catalog.update(requireSkillName(input.name), input.patch, { actor: context.agentId });
      await context.options?.refreshTools?.();
      return {
        ok: true,
        output: { status: "updated", skill: summarizeSkill(updated) },
        newMessages: [{
          ...importMetaMessage(`Skill ${updated.name} has been updated.`),
          metadata: { skill: updated.name, skillManagement: "updated" },
        }],
      };
    },
  };
}

export function createSkillDeleteTool(catalog: MutableSkillCatalog, options: SkillManagementToolOptions = {}): Tool<SkillDeleteToolInput> {
  return {
    name: "skill_delete",
    description: "Delete a generated or writable skill. This is destructive and should normally require approval.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
    metadata: { readOnly: false, concurrent: false, visible: options.allowDelete ?? false, requiresApproval: true, destructive: true, searchHint: "skill authoring" },
    validate(input) {
      return input as SkillDeleteToolInput;
    },
    async call(input, context) {
      if (options.allowDelete === false) return { ok: false, output: { error: "skill_delete is disabled" } };
      const name = requireSkillName(input.name);
      const deleted = await catalog.delete(name, { actor: context.agentId });
      await context.options?.refreshTools?.();
      return { ok: deleted, output: { status: deleted ? "deleted" : "not_found", skill: name } };
    },
  };
}

export function createSkillManagementTools(catalog: MutableSkillCatalog, options: SkillManagementToolOptions = {}): Tool<any>[] {
  return [
    createSkillListTool(catalog),
    createSkillReadTool(catalog),
    createSkillValidateTool(),
    createSkillCreateTool(catalog, options),
    createSkillUpdateTool(catalog, options),
    createSkillDeleteTool(catalog, options),
  ];
}

function importMetaMessage(text: string) {
  return {
    id: `skill_meta_${Date.now().toString(36)}`,
    role: "user" as const,
    blocks: [{ type: "text" as const, text }],
    createdAt: new Date().toISOString(),
    isMeta: true,
  };
}

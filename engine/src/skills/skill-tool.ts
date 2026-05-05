import { createTextMessage } from "../types/messages";
import type { Tool } from "../tools/tool";

export interface SkillDescriptor {
  name: string;
  description: string;
  entrypoint: string;
  execution: "inline" | "fork";
  allowedTools?: readonly string[];
  model?: string;
  effort?: "minimal" | "low" | "medium" | "high";
  disableModelInvocation?: boolean;
}

export interface SkillCatalog {
  list(): Promise<SkillDescriptor[]>;
  get(name: string): Promise<SkillDescriptor | undefined>;
}

export interface SkillToolInput {
  skill?: string;
  name?: string;
  args?: string;
  input?: unknown;
}

export function createSkillTool(catalog: SkillCatalog): Tool<SkillToolInput> {
  return {
    name: "skill",
    aliases: ["Skill"],
    description: "Load a reusable prompt workflow. Inline skills inject prompt messages into the next model turn; fork skills are recognized but require AgentTool integration.",
    inputSchema: {
      type: "object",
      properties: {
        skill: { type: "string" },
        name: { type: "string" },
        args: { type: "string" },
        input: {},
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
      if (skill.disableModelInvocation) return { ok: false, message: `Skill ${name} cannot be invoked by the model` };
      return { ok: true, value: { ...input, skill: name } };
    },
    async call(input) {
      const name = normalizeSkillName(input.skill ?? input.name);
      const skill = name ? await catalog.get(name) : undefined;
      if (!name || !skill) return { ok: false, output: { error: `Unknown skill: ${name ?? "<empty>"}` } };

      if (skill.execution === "fork") {
        return {
          ok: false,
          output: {
            status: "fork_required",
            skill: name,
            message: "Forked skill execution requires launching AgentTool with the skill prompt in this scaffold.",
          },
        };
      }

      const args = renderSkillArgs(input.args ?? input.input);
      const prompt = [
        `<skill name="${escapeXml(name)}">`,
        skill.entrypoint,
        args ? `\n<skill-args>\n${args}\n</skill-args>` : "",
        `</skill>`,
      ].join("\n");

      return {
        ok: true,
        output: {
          status: "injected",
          skill: name,
          allowed_tools: skill.allowedTools ?? [],
          model: skill.model,
          effort: skill.effort,
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
          },
        }),
      };
    },
  };
}

export class InMemorySkillCatalog implements SkillCatalog {
  private readonly skills = new Map<string, SkillDescriptor>();

  constructor(skills: readonly SkillDescriptor[] = []) {
    for (const skill of skills) this.skills.set(skill.name, skill);
  }

  async list(): Promise<SkillDescriptor[]> {
    return [...this.skills.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  async get(name: string): Promise<SkillDescriptor | undefined> {
    return this.skills.get(normalizeSkillName(name) ?? name);
  }
}

function normalizeSkillName(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/^\/+/, "");
  return normalized || undefined;
}

function renderSkillArgs(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

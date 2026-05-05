import type { Tool } from "../tools/tool";

export interface SkillDescriptor {
  name: string;
  description: string;
  entrypoint: string;
  execution: "inline" | "fork";
}

export interface SkillCatalog {
  list(): Promise<SkillDescriptor[]>;
  get(name: string): Promise<SkillDescriptor | undefined>;
}

export function createSkillTool(_catalog: SkillCatalog): Tool<{ name: string; input?: unknown }> {
  return {
    name: "skill",
    description: "Load or run a reusable workflow. Placeholder until skill execution is implemented.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, input: {} },
      required: ["name"],
      additionalProperties: false,
    },
    metadata: { readOnly: false, concurrent: true, visible: true },
    validate(input: unknown) {
      if (!input || typeof input !== "object" || typeof (input as { name?: unknown }).name !== "string") {
        throw new Error("skill.name must be a string");
      }
      return input as { name: string; input?: unknown };
    },
    async execute(input) {
      return { ok: false, output: { message: "SkillTool boundary exists but execution is not implemented yet.", input } };
    },
  };
}

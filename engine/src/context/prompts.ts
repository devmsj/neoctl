export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = "<SYSTEM_PROMPT_DYNAMIC_BOUNDARY>";

export interface PromptSection {
  name: string;
  content: string;
  cacheStable: boolean;
}

export function buildEffectiveSystemPrompt(sections: readonly PromptSection[]): string {
  const stable = sections.filter((section) => section.cacheStable).map(renderSection);
  const dynamic = sections.filter((section) => !section.cacheStable).map(renderSection);
  return [...stable, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, ...dynamic].join("\n\n");
}

function renderSection(section: PromptSection): string {
  return `## ${section.name}\n${section.content}`;
}

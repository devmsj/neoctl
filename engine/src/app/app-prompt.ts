export interface AppPromptValue {
  content: string;
  id?: string;
  title?: string;
  usage?: string;
  source?: string;
  updatedAt: string;
}

export interface AppPromptInput {
  content: string;
  id?: string;
  title?: string;
  usage?: string;
  source?: string;
  updatedAt?: string;
}

export interface AppPromptSnapshot {
  activePrompt?: AppPromptValue;
  hasActivePrompt: boolean;
}

export interface AppPromptStore {
  getAppPrompt(): AppPromptValue | undefined;
  setAppPrompt(prompt: AppPromptInput | AppPromptValue | null | undefined): AppPromptValue | undefined;
  clearAppPrompt(): void;
  snapshot(): AppPromptSnapshot;
}

export class InMemoryAppPromptStore implements AppPromptStore {
  private activePrompt?: AppPromptValue;

  getAppPrompt(): AppPromptValue | undefined {
    return this.activePrompt ? cloneAppPromptValue(this.activePrompt) : undefined;
  }

  setAppPrompt(prompt: AppPromptInput | AppPromptValue | null | undefined): AppPromptValue | undefined {
    const normalized = normalizeAppPrompt(prompt);
    this.activePrompt = normalized;
    return this.getAppPrompt();
  }

  clearAppPrompt(): void {
    this.activePrompt = undefined;
  }

  snapshot(): AppPromptSnapshot {
    return {
      activePrompt: this.getAppPrompt(),
      hasActivePrompt: Boolean(this.activePrompt),
    };
  }
}

export function normalizeAppPrompt(prompt: AppPromptInput | AppPromptValue | null | undefined): AppPromptValue | undefined {
  if (!prompt) return undefined;
  const content = prompt.content?.trim();
  if (!content) return undefined;
  const title = prompt.title?.trim();
  const id = prompt.id?.trim();
  const usage = prompt.usage?.trim();
  const source = prompt.source?.trim();
  const updatedAt = prompt.updatedAt?.trim() || new Date().toISOString();
  return {
    content,
    ...(id ? { id } : {}),
    ...(title ? { title } : {}),
    ...(usage ? { usage } : {}),
    ...(source ? { source } : {}),
    updatedAt,
  };
}

function cloneAppPromptValue(prompt: AppPromptValue): AppPromptValue {
  return { ...prompt };
}

export interface Teammate {
  id: string;
  name: string;
  systemPrompt: string;
  toolAllowList?: string[];
}

export interface Team {
  id: string;
  teammates: Teammate[];
}

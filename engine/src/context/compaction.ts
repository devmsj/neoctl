import type { Message } from "../types/messages";

export interface CompactionResult {
  messages: Message[];
  summary?: string;
  changed: boolean;
}

export interface Compactor {
  compact(messages: readonly Message[]): Promise<CompactionResult>;
}

export class NoopCompactor implements Compactor {
  async compact(messages: readonly Message[]): Promise<CompactionResult> {
    return { messages: [...messages], changed: false };
  }
}

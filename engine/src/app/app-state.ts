import type { Message } from "../types/messages.js";

export interface AppStateSnapshot {
  agentId: string;
  cwd?: string;
  historySize: number;
  activeTaskIds: string[];
}

export interface AppStatePort {
  snapshot(): AppStateSnapshot;
  appendMessage(message: Message): void;
  getMessages(): readonly Message[];
}

export class InMemoryAppState implements AppStatePort {
  private readonly messages: Message[] = [];

  constructor(private readonly agentId: string, private readonly cwd?: string) {}

  snapshot(): AppStateSnapshot {
    return {
      agentId: this.agentId,
      cwd: this.cwd,
      historySize: this.messages.length,
      activeTaskIds: [],
    };
  }

  appendMessage(message: Message): void {
    this.messages.push(message);
  }

  getMessages(): readonly Message[] {
    return this.messages;
  }
}

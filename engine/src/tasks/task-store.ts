import type { LocalAgentTask } from "../agents/local-agent-task";

export class TaskStore {
  private readonly tasks = new Map<string, LocalAgentTask>();

  upsert(task: LocalAgentTask): void {
    this.tasks.set(task.id, task);
  }

  get(id: string): LocalAgentTask | undefined {
    return this.tasks.get(id);
  }

  list(): LocalAgentTask[] {
    return [...this.tasks.values()];
  }
}

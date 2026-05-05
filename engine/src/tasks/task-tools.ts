export type TaskToolName = "TaskOutput" | "TaskList" | "TaskGet" | "TaskStop" | "SendMessage";

export interface TaskControlRequest {
  tool: TaskToolName;
  taskId?: string;
  message?: string;
  wait?: boolean;
}

export interface AuditEvent {
  id: string;
  agentId: string;
  type: string;
  createdAt: string;
  payload: Record<string, unknown>;
}

export interface AuditSink {
  record(event: AuditEvent): Promise<void>;
}

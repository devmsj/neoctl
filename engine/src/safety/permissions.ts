export type PermissionDecision = "allow" | "deny" | "ask";

export interface PermissionRequest {
  agentId: string;
  action: string;
  resource?: string;
  metadata?: Record<string, unknown>;
}

export interface PermissionPolicy {
  decide(request: PermissionRequest): Promise<PermissionDecision>;
}

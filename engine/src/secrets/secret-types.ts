export type SecretStatus = "set" | "empty";

export interface SecretMetadata {
  key: string;
  status: SecretStatus;
  length: number;
  createdAt: string;
  updatedAt: string;
  requestedBy?: "agent" | "user";
  requestReason?: string;
}

export interface SecretResolver {
  list(): Promise<SecretMetadata[]>;
  info(key: string): Promise<SecretMetadata | undefined>;
  requestEmpty(key: string, options?: { reason?: string; requestedBy?: "agent" | "user" }): Promise<SecretMetadata>;
  resolve(key: string): Promise<string>;
}

export interface SecretRedactionRegistry {
  record(key: string, value: string): void;
  redact<T>(value: T): T;
}

export class SecretNotFoundError extends Error {
  constructor(public readonly key: string) {
    super(`Secret "${key}" does not exist.`);
    this.name = "SecretNotFoundError";
  }
}

export class SecretEmptyError extends Error {
  constructor(public readonly key: string) {
    super(`Secret "${key}" exists but has no value. Fill it in REPL with: /secret set ${key} <value>`);
    this.name = "SecretEmptyError";
  }
}

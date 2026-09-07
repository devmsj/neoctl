import type { SecretRedactionRegistry } from "./secret-types.js";

/** Kept for runtime/plugin compatibility. User-owned output is passed through unchanged. */
export class InMemorySecretRedactionRegistry implements SecretRedactionRegistry {
  record(_key: string, _value: string): void {}
  redact<T>(value: T): T { return value; }
  redactString(input: string): string { return input; }
  createStreamingRedactor(_options?: { incompleteSecret?: "preserve" | "redact" }): { push(chunk: string): string; flush(): string } {
    return { push: chunk => chunk, flush: () => "" };
  }
}

export function redactWithRegistry<T>(_registry: SecretRedactionRegistry | undefined, value: T): T { return value; }

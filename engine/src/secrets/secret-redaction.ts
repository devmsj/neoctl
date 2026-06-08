import type { SecretRedactionRegistry } from "./secret-types.js";

export class InMemorySecretRedactionRegistry implements SecretRedactionRegistry {
  private readonly values = new Map<string, Set<string>>();

  record(key: string, value: string): void {
    if (!value) return;
    const set = this.values.get(key) ?? new Set<string>();
    set.add(value);
    set.add(value.trim());
    set.add(`Bearer ${value}`);
    this.values.set(key, set);
  }

  redact<T>(value: T): T {
    if (typeof value === "string") return this.redactString(value) as T;
    if (Array.isArray(value)) return value.map((entry) => this.redact(entry)) as T;
    if (value && typeof value === "object") {
      const output: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) output[k] = this.redact(v);
      return output as T;
    }
    return value;
  }

  redactString(input: string): string {
    let output = input;
    for (const [key, values] of this.values.entries()) {
      for (const secret of values) {
        if (!secret) continue;
        output = output.split(secret).join(`[secret:${key}]`);
      }
    }
    return output;
  }
}

export function redactWithRegistry<T>(registry: SecretRedactionRegistry | undefined, value: T): T {
  return registry ? registry.redact(value) : value;
}

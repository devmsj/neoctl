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

  private secretAt(input: string, offset: number): { key: string; secret: string } | undefined {
    let best: { key: string; secret: string } | undefined;
    for (const [key, values] of this.values.entries()) {
      for (const secret of values) {
        if (secret && input.startsWith(secret, offset) && (!best || secret.length > best.secret.length)) best = { key, secret };
      }
    }
    return best;
  }

  createStreamingRedactor(): { push(chunk: string): string; flush(): string } {
    const secrets = [...this.values.values()].flatMap((values) => [...values]).filter(Boolean);
    const carryLength = Math.max(0, ...secrets.map((secret) => secret.length - 1));
    let carry = "";
    return {
      push: (chunk) => {
        const combined = carry + chunk;
        if (carryLength === 0) return this.redactString(combined);
        const safeLength = Math.max(0, combined.length - carryLength);
        let cursor = 0;
        let output = "";
        while (cursor < safeLength) {
          const match = this.secretAt(combined, cursor);
          if (match) {
            output += `[secret:${match.key}]`;
            cursor += match.secret.length;
          } else {
            output += combined[cursor];
            cursor += 1;
          }
        }
        carry = combined.slice(cursor);
        return output;
      },
      flush: () => {
        const output = this.redactString(carry);
        carry = "";
        return output;
      },
    };
  }
}

export function redactWithRegistry<T>(registry: SecretRedactionRegistry | undefined, value: T): T {
  return registry ? registry.redact(value) : value;
}

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

  createStreamingRedactor(options?: { incompleteSecret?: "preserve" | "redact" }): { push(chunk: string): string; flush(): string } {
    // Only an ambiguous suffix stays private. Never attach this carry to a task/DTO.
    let carry = "";
    const push = (chunk: string): string => {
      const combined = carry + chunk;
      // Registration is live: a stream may predate a tool resolving a new secret.
      // Values must be registered BEFORE their first byte is emitted; already
      // published text cannot be recalled by any streaming redactor.
      const secrets = [...this.values.entries()].flatMap(([key, values]) =>
        [...values].filter(Boolean).map((secret) => ({ key, secret })));
      let cursor = 0;
      let output = "";
      while (cursor < combined.length) {
        let match: { key: string; secret: string } | undefined;
        let ambiguous = false;
        for (const entry of secrets) {
          if (entry.secret.length > combined.length - cursor) {
            if (entry.secret.startsWith(combined.slice(cursor))) ambiguous = true;
          } else if (combined.startsWith(entry.secret, cursor)
              && (!match || entry.secret.length > match.secret.length)) {
            match = entry;
          }
        }
        // A complete shorter secret may also prefix a longer one. Hold it until
        // disambiguated, rather than expose the longer secret's remaining bytes.
        if (ambiguous) break;
        if (match) {
          output += `[secret:${match.key}]`;
          cursor += match.secret.length;
        } else {
          output += combined[cursor++];
        }
      }
      carry = combined.slice(cursor);
      return output;
    };
    return {
      push,
      flush: () => {
        const output = push("");
        // Preserve the existing terminal/full-text contract by default. A preview
        // may opt in to an explicit marker rather than publish an ambiguous tail.
        const tail = options?.incompleteSecret === "redact" && carry
          ? "[secret:incomplete]" : this.redactString(carry);
        carry = "";
        return output + tail;
      },
    };
  }
}

export function redactWithRegistry<T>(registry: SecretRedactionRegistry | undefined, value: T): T {
  return registry ? registry.redact(value) : value;
}

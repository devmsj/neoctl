import type { JsonSchema, ValidationResult } from "./tool.js";

export function validateJsonSchema(input: unknown, schema: JsonSchema, path = "input"): ValidationResult<unknown> {
  if (!schema || Object.keys(schema).length === 0) return { ok: true, value: input };

  if (schema.enum && !schema.enum.includes(input)) {
    return { ok: false, message: `${path} must be one of ${schema.enum.map(String).join(", ")}` };
  }

  if (schema.type) {
    const typeResult = validateType(input, schema, path);
    if (!typeResult.ok) return typeResult;
  }

  if (schema.type === "object" && schema.properties) {
    const record = input as Record<string, unknown>;
    for (const required of schema.required ?? []) {
      if (!(required in record)) return { ok: false, message: `${path}.${required} is required` };
    }
    for (const [key, value] of Object.entries(record)) {
      const childSchema = schema.properties[key];
      if (!childSchema) {
        if (schema.additionalProperties === false) return { ok: false, message: `${path}.${key} is not allowed` };
        continue;
      }
      const childResult = validateJsonSchema(value, childSchema, `${path}.${key}`);
      if (!childResult.ok) return childResult;
    }
  }

  if (schema.type === "array" && schema.items && Array.isArray(input)) {
    for (let index = 0; index < input.length; index += 1) {
      const childResult = validateJsonSchema(input[index], schema.items, `${path}[${index}]`);
      if (!childResult.ok) return childResult;
    }
  }

  return { ok: true, value: input };
}

function validateType(input: unknown, schema: JsonSchema, path: string): ValidationResult<unknown> {
  switch (schema.type) {
    case "object":
      return input !== null && typeof input === "object" && !Array.isArray(input)
        ? { ok: true, value: input }
        : { ok: false, message: `${path} must be an object` };
    case "array":
      return Array.isArray(input) ? { ok: true, value: input } : { ok: false, message: `${path} must be an array` };
    case "string":
      return typeof input === "string" ? { ok: true, value: input } : { ok: false, message: `${path} must be a string` };
    case "number":
      return typeof input === "number" && Number.isFinite(input) ? { ok: true, value: input } : { ok: false, message: `${path} must be a number` };
    case "integer":
      return Number.isInteger(input) ? { ok: true, value: input } : { ok: false, message: `${path} must be an integer` };
    case "boolean":
      return typeof input === "boolean" ? { ok: true, value: input } : { ok: false, message: `${path} must be a boolean` };
    case "null":
      return input === null ? { ok: true, value: input } : { ok: false, message: `${path} must be null` };
    default:
      return { ok: true, value: input };
  }
}

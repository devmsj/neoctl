/**
 * Same result as `JSON.parse(JSON.stringify(value))` for JSON data, but string values are shared
 * (strings are immutable) instead of being serialized and re-parsed. Cloning a message that carries a
 * multi-MB base64 image therefore costs no extra payload memory and no serialization time.
 */
export function jsonClone<T>(value: T): T {
  const cloned = cloneValue(value, "");
  if (cloned === undefined) throw new SyntaxError("Value is not JSON-serializable");
  return cloned as T;
}

function cloneValue(value: unknown, key: string): unknown {
  if (value !== null && typeof value === "object" && typeof (value as { toJSON?: unknown }).toJSON === "function") {
    value = (value as { toJSON(key: string): unknown }).toJSON(key);
  }
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? (value === 0 ? 0 : value) : null;
    case "bigint":
      throw new TypeError("Do not know how to serialize a BigInt");
    case "undefined":
    case "function":
    case "symbol":
      return undefined;
  }
  if (value === null) return null;
  if (value instanceof Number || value instanceof String || value instanceof Boolean) return cloneValue(value.valueOf(), key);
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      const cloned = cloneValue(item, String(index));
      return cloned === undefined ? null : cloned;
    });
  }
  const result: Record<string, unknown> = {};
  for (const name of Object.keys(value as object)) {
    const cloned = cloneValue((value as Record<string, unknown>)[name], name);
    if (cloned === undefined) continue;
    if (name === "__proto__") Object.defineProperty(result, name, { value: cloned, enumerable: true, writable: true, configurable: true });
    else result[name] = cloned;
  }
  return result;
}

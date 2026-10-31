/**
 * Checks a value against the JSON Schema subset the reading schema uses (type, enum, properties,
 * required, additionalProperties: false, items, anyOf). Provider-side constrained decoding is not
 * trusted: every response is checked here before any contract rule runs.
 */
import type { JsonSchema } from "./wire";

/** Null when the value fits; otherwise the path of the first mismatch ("observations.0.kind"). */
export function schemaMismatch(schema: JsonSchema, value: unknown, path = "$"): string | null {
  if (Array.isArray(schema.anyOf)) {
    const fits = (schema.anyOf as JsonSchema[]).some((option) => schemaMismatch(option, value, path) === null);
    return fits ? null : path;
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
    if (!types.some((type) => hasType(type, value))) return path;
  }
  if (Array.isArray(schema.enum) && !(schema.enum as unknown[]).includes(value)) return path;
  if (Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) {
      const miss = schemaMismatch(schema.items as JsonSchema, value[i], `${path}.${i}`);
      if (miss) return miss;
    }
  }
  if (isPlainObject(value) && schema.properties) {
    const properties = schema.properties as Record<string, JsonSchema>;
    for (const key of (schema.required as string[] | undefined) ?? []) {
      if (!(key in value)) return `${path}.${key}`;
    }
    for (const [key, child] of Object.entries(value)) {
      const childSchema = properties[key];
      if (!childSchema) {
        if (schema.additionalProperties === false) return `${path}.${key}`;
        continue;
      }
      const miss = schemaMismatch(childSchema, child, `${path}.${key}`);
      if (miss) return miss;
    }
  }
  return null;
}

function hasType(type: string, value: unknown): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "array":
      return Array.isArray(value);
    case "object":
      return isPlainObject(value);
    default:
      return false;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

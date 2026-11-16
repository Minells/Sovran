import Ajv from 'ajv';
import type { ValidateFunction } from 'ajv';

// A bounded subset for the reviewed prototype tools. No refs, formats, regexes or remote loading.
const KEYS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'anyOf',
  'oneOf',
  'allOf',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'title',
  'description',
  'default',
  '$schema',
]);
const ajv = new Ajv({
  strict: false,
  validateFormats: false,
  allErrors: false,
  ownProperties: true,
  addUsedSchema: false,
});

/** Unsupported schemas are excluded, never weakened to a permissive validator. */
export function compileCodeSchema(schema: Record<string, unknown>): ValidateFunction | undefined {
  try {
    if (JSON.stringify(schema).length > 16_000 || schema.type !== 'object') return;
    let nodes = 0;
    const walk = (value: unknown, depth: number): boolean => {
      if (++nodes > 256 || depth > 12) return false;
      if (typeof value === 'boolean') return true;
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      for (const [key, child] of Object.entries(value)) {
        if (!KEYS.has(key)) return false;
        if (key === 'properties') {
          if (!child || typeof child !== 'object' || Array.isArray(child)) return false;
          if (!Object.values(child).every((x) => walk(x, depth + 1))) return false;
        } else if (['anyOf', 'oneOf', 'allOf'].includes(key)) {
          if (!Array.isArray(child) || !child.every((x) => walk(x, depth + 1))) return false;
        } else if (key === 'items' || key === 'additionalProperties') {
          if (!walk(child, depth + 1)) return false;
        }
      }
      return true;
    };
    if (!walk(schema, 0)) return;
    const { $schema: _ignored, ...plain } = schema;
    return ajv.compile(plain);
  } catch {
    return undefined;
  }
}

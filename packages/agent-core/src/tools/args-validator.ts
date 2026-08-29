import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import Ajv2019 from 'ajv/dist/2019';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

const DRAFT_07_AJV = new Ajv({ strict: false, allErrors: true });
addFormats(DRAFT_07_AJV);

const DRAFT_2019_AJV = new Ajv2019({ strict: false, allErrors: true });
addFormats(DRAFT_2019_AJV);

const DRAFT_2020_AJV = new Ajv2020({ strict: false, allErrors: true });
addFormats(DRAFT_2020_AJV);

const DRAFT_2019_KEYWORDS = new Set([
  'dependentRequired',
  'dependentSchemas',
  'maxContains',
  'minContains',
  'unevaluatedItems',
  'unevaluatedProperties',
  '$recursiveAnchor',
  '$recursiveRef',
]);

const DRAFT_2020_KEYWORDS = new Set(['prefixItems', '$dynamicAnchor', '$dynamicRef']);

// Mixing JSON Schema dialects in a single Ajv instance is unsafe because
// keyword semantics differ, e.g. draft-07 tuple `items` vs 2020-12 `prefixItems`.
function ajvFor(schema: Record<string, unknown>): Ajv | Ajv2019 | Ajv2020 {
  const $schema = schema['$schema'];
  if (typeof $schema === 'string') {
    if ($schema.includes('2020-12')) return DRAFT_2020_AJV;
    if ($schema.includes('2019-09')) return DRAFT_2019_AJV;
    return DRAFT_07_AJV;
  }
  if (containsSchemaKeyword(schema, DRAFT_2020_KEYWORDS)) return DRAFT_2020_AJV;
  if (containsSchemaKeyword(schema, DRAFT_2019_KEYWORDS)) return DRAFT_2019_AJV;
  return DRAFT_07_AJV;
}

function containsSchemaKeyword(value: unknown, keywords: ReadonlySet<string>): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsSchemaKeyword(item, keywords));
  }
  if (typeof value !== 'object' || value === null) return false;
  for (const [key, child] of Object.entries(value)) {
    if (keywords.has(key)) return true;
    if (containsSchemaKeyword(child, keywords)) return true;
  }
  return false;
}

export type JsonType = null | number | string | boolean | JsonArray | JsonObject;

/** @internal */
export interface JsonArray extends Array<JsonType> {}

/** @internal */
export interface JsonObject extends Record<string, JsonType> {}

export type ToolArgsValidator = ValidateFunction<JsonType>;

/**
 * Render one Ajv error.
 *
 * `instancePath` has to survive on every branch. Ajv runs with `allErrors`, so a
 * bad array of items yields one error per item, and dropping the path made them
 * render byte-identical — `AskUserQuestion` with two malformed questions came
 * back as the same sentence twice, reading like the UI had double-printed the
 * failure while actually hiding which item was wrong. `/questions/0` in front of
 * the message is both the deduplication and the only pointer the model gets to
 * the offending element.
 */
function formatValidationError(error: ErrorObject): string {
  const path = error.instancePath ? `${error.instancePath} ` : '';

  if (error.keyword === 'required' && 'missingProperty' in error.params) {
    return `${path}must have required property '${String(error.params['missingProperty'])}'`;
  }

  if (error.keyword === 'additionalProperties' && 'additionalProperty' in error.params) {
    return `${path}must NOT have additional property '${String(error.params['additionalProperty'])}'`;
  }

  return `${path}${error.message ?? 'is invalid'}`;
}

export function compileToolArgsValidator(schema: Record<string, unknown>): ToolArgsValidator {
  return ajvFor(schema).compile(schema) as ToolArgsValidator;
}

export function validateToolArgs(validator: ToolArgsValidator, args: JsonType): string | null {
  const valid = validator(args);
  if (valid) {
    return null;
  }

  const errors = validator.errors ?? [];
  if (errors.length === 0) {
    return 'Tool parameter validation failed';
  }

  // Ajv can still report the same complaint twice for one instance path (a
  // branch reached through both `anyOf` and the top-level schema, for example).
  // Identical sentences tell the model nothing extra and read as a duplicated
  // error, so collapse them while keeping the original order.
  const seen = new Set<string>();
  const messages: string[] = [];
  for (const error of errors) {
    const message = formatValidationError(error);
    if (seen.has(message)) continue;
    seen.add(message);
    messages.push(message);
  }
  return messages.join('; ');
}

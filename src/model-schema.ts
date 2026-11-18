// The transport contract uses required nullable fields for optional domain values.
// Keep one source of truth: the domain schema still validates every returned action.
type Schema = Record<string, any>;
const acceptsNull = (s: Schema): boolean =>
  s.type === 'null' ||
  (Array.isArray(s.type) && s.type.includes('null')) ||
  !!s.anyOf?.some(acceptsNull);

export function strictToolSchema(schema: Schema): Schema {
  const s = { ...schema };
  delete s.$schema;
  delete s.default;
  // uri is not a supported Structured Outputs format. URL validation remains local.
  if (s.format === 'uri') {
    delete s.format;
    s.description = [s.description, 'An absolute URL.'].filter(Boolean).join(' ');
  }
  if (s.type === 'object') {
    if (s.additionalProperties !== false || !s.properties)
      throw new Error('unsupported_model_object_schema');
    const required = new Set<string>(s.required || []);
    s.properties = Object.fromEntries(
      Object.entries(s.properties as Record<string, Schema>).map(([key, value]) => {
        const child = strictToolSchema(value);
        return [
          key,
          required.has(key) || acceptsNull(child) ? child : { anyOf: [child, { type: 'null' }] },
        ];
      }),
    );
    s.required = Object.keys(s.properties);
  }
  if (s.items) s.items = strictToolSchema(s.items);
  if (s.anyOf) s.anyOf = s.anyOf.map(strictToolSchema);
  return s;
}

function matchesShape(value: unknown, s: Schema): boolean {
  if (s.type === 'null') return value === null;
  if (s.type === 'object')
    return (
      !!value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      (s.required || []).every((key: string) => Object.hasOwn(value, key))
    );
  if (s.type === 'array') return Array.isArray(value);
  return typeof value === (s.type === 'integer' ? 'number' : s.type);
}

// Only null placeholders on known optional, non-nullable properties become absent.
// Preserve required nulls, explicit domain nulls, unknown keys, invalid enums and
// ambiguous unions for the domain validator to reject; never coerce an enum to other.
export function fromToolArguments(value: unknown, schema: Schema): unknown {
  if (schema.anyOf) {
    const matches = schema.anyOf.filter((s: Schema) => matchesShape(value, s));
    return matches.length === 1 ? fromToolArguments(value, matches[0]) : value;
  }
  if (Array.isArray(value) && schema.type === 'array' && schema.items)
    return value.map((v) => fromToolArguments(v, schema.items));
  if (!value || typeof value !== 'object' || Array.isArray(value) || schema.type !== 'object')
    return value;
  const required = new Set<string>(schema.required || []);
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, v]) => {
      const child = schema.properties?.[key];
      if (!child) return [[key, v]];
      if (v === null && !required.has(key) && !acceptsNull(child)) return [];
      return [[key, fromToolArguments(v, child)]];
    }),
  );
}

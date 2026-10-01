import type { ElicitationField, ElicitationOption, ElicitationValue } from '../types.js';

/**
 * ACP form elicitations (elicitation/create, mode "form"): the agent's JSON Schema flattened
 * into fields the web app can draw, and the user's answer checked against it before it goes
 * back to the agent.
 */

// Where Claude's AskUserQuestion bridge puts an option's preview, and marks the "Other" box
const CLAUDE_OPTION_META = '_claude/askUserQuestionOption';
const CUSTOM_ANSWER_META = '_askUserQuestionCustomAnswer';
const FORMATS = new Set(['email', 'uri', 'date', 'date-time']);

const isRecord = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const count = (v: unknown): number | undefined => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : undefined);

function parseOptions(list: unknown): ElicitationOption[] {
  if (!Array.isArray(list)) return [];
  const options: ElicitationOption[] = [];
  for (const o of list) {
    if (typeof o === 'string') {
      options.push({ value: o, title: o });
      continue;
    }
    if (!isRecord(o) || typeof o.const !== 'string') continue;
    const preview = o._meta?.[CLAUDE_OPTION_META]?.preview;
    options.push({
      value: o.const,
      title: str(o.title) ?? o.const,
      ...(str(o.description) ? { description: o.description } : {}),
      ...(str(preview) ? { preview } : {}),
    });
  }
  // A repeated value could not be told apart in the answer
  return options.filter((o, i) => options.findIndex((x) => x.value === o.value) === i);
}

/** One property, or null when it is a kind of field this app cannot draw. */
function parseField(key: string, p: unknown, required: boolean): ElicitationField | null {
  if (!isRecord(p)) return null;
  const base = {
    key,
    required,
    ...(str(p.title) ? { title: p.title as string } : {}),
    ...(str(p.description) ? { description: p.description as string } : {}),
  };
  switch (p.type) {
    case 'string': {
      const choices = p.oneOf ?? p.enum;
      const options = choices == null ? undefined : parseOptions(choices);
      if (options && options.length === 0) return null;
      const meta = p._meta;
      const customFor = str(meta?.[CUSTOM_ANSWER_META]?.questionId) ?? (meta?.codex?.role === 'user_note' ? str(meta.codex.questionId) : undefined);
      const def = str(p.default);
      return {
        ...base,
        type: 'string',
        ...(options ? { options } : {}),
        ...(def !== undefined && (!options || options.some((o) => o.value === def)) ? { default: def } : {}),
        ...(count(p.minLength) !== undefined ? { minLength: p.minLength } : {}),
        ...(count(p.maxLength) !== undefined ? { maxLength: p.maxLength } : {}),
        ...(str(p.pattern) ? { pattern: p.pattern } : {}),
        ...(FORMATS.has(p.format) ? { format: p.format } : {}),
        ...(customFor ? { customAnswerFor: customFor } : {}),
        ...(meta?.codex?.isSecret === true ? { secret: true } : {}),
      };
    }
    case 'number':
    case 'integer': {
      const def = num(p.default);
      return {
        ...base,
        type: p.type,
        ...(def !== undefined && (p.type === 'number' || Number.isInteger(def)) ? { default: def } : {}),
        ...(num(p.minimum) !== undefined ? { minimum: p.minimum } : {}),
        ...(num(p.maximum) !== undefined ? { maximum: p.maximum } : {}),
      };
    }
    case 'boolean':
      return { ...base, type: 'boolean', ...(typeof p.default === 'boolean' ? { default: p.default } : {}) };
    case 'array': {
      const items = p.items;
      const options = isRecord(items) ? parseOptions(items.anyOf ?? items.enum) : [];
      if (options.length === 0) return null;
      const def = Array.isArray(p.default) ? p.default.filter((v: unknown) => options.some((o) => o.value === v)) : undefined;
      return {
        ...base,
        type: 'array',
        options,
        ...(def && def.length > 0 ? { default: def } : {}),
        ...(count(p.minItems) !== undefined ? { minItems: p.minItems } : {}),
        ...(count(p.maxItems) !== undefined ? { maxItems: p.maxItems } : {}),
      };
    }
    default:
      return null;
  }
}

/**
 * The fields of a requested schema, in the agent's order. Null when a required field is of a
 * kind this app cannot draw: such a form cannot be answered, so it is declined. An optional
 * field of that kind is left out, and no answer is ever sent for it.
 */
export function parseElicitationFields(schema: unknown): ElicitationField[] | null {
  if (!isRecord(schema)) return null;
  const props = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((k: unknown) => typeof k === 'string') : []);
  const fields: ElicitationField[] = [];
  for (const [key, prop] of Object.entries(props)) {
    const field = parseField(key, prop, required.has(key));
    if (field) fields.push(field);
    else if (required.has(key)) return null;
  }
  // An "Other" box whose question is missing is just a text field
  for (const f of fields) {
    if (f.customAnswerFor && !fields.some((q) => q.key === f.customAnswerFor && q.key !== f.key)) delete f.customAnswerFor;
  }
  return fields;
}

export function fieldLabel(field: ElicitationField, fields: ElicitationField[] = []): string {
  if (field.customAnswerFor) {
    const question = fields.find((f) => f.key === field.customAnswerFor);
    if (question) return `${fieldLabel(question)} (other)`;
  }
  return field.title || field.description || field.key;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function formatError(format: ElicitationField['format'], v: string): string | undefined {
  switch (format) {
    case 'email':
      return EMAIL.test(v) ? undefined : 'an email address';
    case 'uri':
      try {
        new URL(v);
        return undefined;
      } catch {
        return 'a URL';
      }
    case 'date':
      return DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? undefined : 'a date (YYYY-MM-DD)';
    case 'date-time':
      return DATE_TIME.test(v) && !Number.isNaN(Date.parse(v)) ? undefined : 'a date and time';
    default:
      return undefined;
  }
}

/** Why the value does not fit the field, or undefined when it does. */
function valueError(f: ElicitationField, v: unknown, label: string): string | undefined {
  const values = new Set((f.options || []).map((o) => o.value));
  switch (f.type) {
    case 'string': {
      if (typeof v !== 'string') return `"${label}" must be text`;
      if (f.options) return values.has(v) ? undefined : `"${label}" must be one of the offered choices`;
      // Lengths count characters, not UTF-16 units, as JSON Schema does
      const len = [...v].length;
      if (f.minLength !== undefined && len < f.minLength) return `"${label}" must be at least ${f.minLength} characters`;
      if (f.maxLength !== undefined && len > f.maxLength) return `"${label}" must be at most ${f.maxLength} characters`;
      if (f.pattern) {
        let re: RegExp | undefined;
        try {
          re = new RegExp(f.pattern, 'u');
        } catch {
          // A pattern JavaScript cannot read is the agent's to check
        }
        if (re && !re.test(v)) return `"${label}" is not in the expected form`;
      }
      const wanted = formatError(f.format, v);
      return wanted ? `"${label}" must be ${wanted}` : undefined;
    }
    case 'number':
    case 'integer':
      if (typeof v !== 'number' || !Number.isFinite(v)) return `"${label}" must be a number`;
      if (f.type === 'integer' && !Number.isInteger(v)) return `"${label}" must be a whole number`;
      if (f.minimum !== undefined && v < f.minimum) return `"${label}" must be at least ${f.minimum}`;
      if (f.maximum !== undefined && v > f.maximum) return `"${label}" must be at most ${f.maximum}`;
      return undefined;
    case 'boolean':
      return typeof v === 'boolean' ? undefined : `"${label}" must be true or false`;
    case 'array':
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) return `"${label}" must be a list of choices`;
      if (v.some((x) => !values.has(x))) return `"${label}" must only hold the offered choices`;
      if (new Set(v).size !== v.length) return `"${label}" lists a choice twice`;
      if (f.minItems !== undefined && v.length < f.minItems) return `Pick at least ${f.minItems} for "${label}"`;
      if (f.maxItems !== undefined && v.length > f.maxItems) return `Pick at most ${f.maxItems} for "${label}"`;
      return undefined;
  }
}

/**
 * Check a submitted answer against the form. Only the form's own fields go back to the agent;
 * an empty text box or a null counts as no answer.
 */
export function validateElicitationContent(
  fields: ElicitationField[],
  content: unknown
): { ok: true; content: Record<string, ElicitationValue> } | { ok: false; error: string } {
  if (content != null && !isRecord(content)) return { ok: false, error: 'content must be an object of field answers' };
  const given = content ?? {};
  for (const key of Object.keys(given)) {
    if (!fields.some((f) => f.key === key)) return { ok: false, error: `The form has no field "${key}"` };
  }
  // Own keys only: a field named "constructor" or "__proto__" must not read or write the prototype.
  const out: Record<string, ElicitationValue> = Object.create(null);
  for (const f of fields) {
    const v = Object.hasOwn(given, f.key) ? given[f.key] : undefined;
    const label = fieldLabel(f, fields);
    if (v === undefined || v === null || v === '') {
      if (f.required) return { ok: false, error: `"${label}" is required` };
      continue;
    }
    const error = valueError(f, v, label);
    if (error) return { ok: false, error };
    out[f.key] = v as ElicitationValue;
  }
  return { ok: true, content: out };
}

/** The answer in words, one field a line, with choices by their titles: shown on the question's card. */
export function describeElicitationAnswer(fields: ElicitationField[], content: Record<string, ElicitationValue>): string {
  const title = (f: ElicitationField, v: string) => f.options?.find((o) => o.value === v)?.title ?? v;
  const lines = fields
    .filter((f) => content[f.key] !== undefined)
    .map((f) => {
      const v = content[f.key];
      const text = Array.isArray(v) ? (v.length ? v.map((x) => title(f, x)).join(', ') : 'none') : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : title(f, String(v));
      return `${fieldLabel(f, fields)}: ${f.secret ? '••••' : text}`;
    });
  return lines.length > 0 ? lines.join('\n') : 'Submitted with no answers';
}

import type { ElicitationField, ElicitationRecord, ElicitationValue } from './types';

/**
 * Forms the agent asks the user to fill in (ACP elicitations). The checks mirror
 * server/acp/elicitation.ts, so the user sees a mistake before the server
 * rejects the answer; the server stays the judge.
 */

export function fieldLabel(field: ElicitationField, fields: ElicitationField[] = []): string {
  if (field.customAnswerFor) {
    const question = fields.find((f) => f.key === field.customAnswerFor);
    if (question) return `${fieldLabel(question)} (other)`;
  }
  return field.title || field.description || field.key;
}

/** The free-text "Other" box that belongs to a question, if it has one. */
/** A record's own value for a field: a field named "constructor" must not read the prototype. */
export const ownValue = <T,>(record: Record<string, T>, key: string): T | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined;

export const companionOf = (field: ElicitationField, fields: ElicitationField[]) =>
  fields.find((f) => f.customAnswerFor === field.key);

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

/** Why the answer does not fit the field, or undefined when it does (or when there is no answer). */
export function answerError(f: ElicitationField, v: ElicitationValue | undefined, fields: ElicitationField[]): string | undefined {
  const label = fieldLabel(f, fields);
  if (v === undefined || v === '') return f.required ? `"${label}" is required` : undefined;
  const values = new Set((f.options || []).map((o) => o.value));
  switch (f.type) {
    case 'string': {
      if (typeof v !== 'string') return `"${label}" must be text`;
      if (f.options) return values.has(v) ? undefined : `"${label}" must be one of the offered choices`;
      // Lengths count characters, not UTF-16 units, as the server does
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
      if (!Array.isArray(v)) return `"${label}" must be a list of choices`;
      if (f.minItems !== undefined && v.length < f.minItems) return `Pick at least ${f.minItems} for "${label}"`;
      if (f.maxItems !== undefined && v.length > f.maxItems) return `Pick at most ${f.maxItems} for "${label}"`;
      return undefined;
  }
}

/** A short note on what the field accepts, e.g. "2–40 characters". */
export function constraintHint(f: ElicitationField): string | undefined {
  const range = (lo: number | undefined, hi: number | undefined, unit: string) =>
    lo !== undefined && hi !== undefined
      ? `${lo}–${hi} ${unit}`
      : lo !== undefined
        ? `At least ${lo} ${unit}`
        : hi !== undefined
          ? `At most ${hi} ${unit}`
          : undefined;
  if (f.type === 'string' && !f.options) return range(f.minLength, f.maxLength, 'characters');
  if (f.type === 'array') return range(f.minItems, f.maxItems, 'choices');
  if (f.type === 'number' || f.type === 'integer') {
    const kind = f.type === 'integer' ? 'A whole number' : 'A number';
    if (f.minimum !== undefined && f.maximum !== undefined) return `${kind} from ${f.minimum} to ${f.maximum}`;
    if (f.minimum !== undefined) return `${kind}, at least ${f.minimum}`;
    if (f.maximum !== undefined) return `${kind}, at most ${f.maximum}`;
  }
  return undefined;
}

/** "2026-10-01T09:30" for a datetime-local input, from the agent's ISO value. */
export function toLocalDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The answers of a settled form, one line a question, with an "Other" box folded into its question. */
export function answerLines(record: ElicitationRecord): Array<{ label: string; value: string }> {
  const content = record.content || {};
  const { fields } = record;
  const title = (f: ElicitationField, v: string) => f.options?.find((o) => o.value === v)?.title ?? v;
  const lines: Array<{ label: string; value: string }> = [];
  for (const f of fields) {
    const custom = companionOf(f, fields);
    if (f.customAnswerFor && fields.some((q) => q.key === f.customAnswerFor)) continue;
    const v = ownValue(content, f.key);
    const note = custom ? ownValue(content, custom.key) : undefined;
    const extra = typeof note === 'string' ? note : undefined;
    let text: string;
    // Secret answers reach the agent but are not kept in the session
    if (f.secret) text = 'Hidden';
    else if (v === undefined) text = extra ?? 'No answer';
    else if (Array.isArray(v)) text = [...v.map((x) => title(f, x)), ...(extra ? [extra] : [])].join(', ') || 'None';
    else if (typeof v === 'boolean') text = v ? 'Yes' : 'No';
    else text = extra ? `${title(f, String(v))} (note: ${extra})` : title(f, String(v));
    lines.push({ label: fieldLabel(f, fields), value: text });
  }
  return lines;
}

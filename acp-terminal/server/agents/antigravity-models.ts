/** The models agy offers, as CodePit's model and effort pickers show them. */

const EFFORT_ORDER = ['low', 'medium', 'high', 'max'];

/** One model as the picker shows it; agy names each effort level as its own model (`<model>-high`). */
export interface ModelChoice {
  value: string;
  name: string;
  efforts: string[];
}

// Used until `agy models` answers, and if it cannot
export const FALLBACK_MODELS: ModelChoice[] = [
  { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', efforts: ['low', 'medium', 'high'] },
  { value: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', efforts: ['low', 'high'] },
];

/** Group `agy models` lines ("<slug>\t<label>") into models with their effort levels. */
export function groupModels(listing: string): ModelChoice[] {
  const byBase = new Map<string, ModelChoice>();
  for (const line of listing.split('\n')) {
    const [slug, label] = line.split('\t').map((s) => s?.trim());
    if (!slug || !label || /\s/.test(slug)) continue;
    const level = slug.match(/^(.+)-(low|medium|high|max)$/);
    const base = level ? level[1] : slug;
    const name = level ? label.replace(/\s*\((low|medium|high|max)\)\s*$/i, '') : label;
    const choice = byBase.get(base) ?? { value: base, name, efforts: [] };
    if (level) choice.efforts.push(level[2]);
    byBase.set(base, choice);
  }
  for (const m of byBase.values()) m.efforts.sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
  return [...byBase.values()];
}

import React, { useId, useState } from 'react';
import type { ElicitationField, ElicitationOption, ElicitationValue, PendingElicitation } from '../types';
import { api } from '../api';
import { Badge, Button, ChoiceCard, Field, Icon, Input, Kbd, Switch, Textarea } from '../ui';
import { MarkdownContent } from './MarkdownContent';
import { MOD_KEY } from './Sidebar';
import { answerError, companionOf, constraintHint, fieldLabel, ownValue, toLocalDateTime } from '../elicitation';

/** What a field holds while it is being filled in: numbers stay text until submitted. */
type Draft = string | boolean | string[] | undefined;
/** How a question's "Other" box is in use: as the answer itself, or as a note beside the pick. */
type CustomMode = 'other' | 'note';

// Codex adds its own catch-all option and keeps the typed answer in the note box
const CATCH_ALL = /^(other|none of the above)$/i;

function initialDraft(f: ElicitationField): Draft {
  const d = f.default;
  if (d === undefined) return f.type === 'boolean' ? false : f.type === 'array' ? [] : undefined;
  if (typeof d === 'number') return String(d);
  if (f.format === 'date-time' && typeof d === 'string') return toLocalDateTime(d);
  return d;
}

/** The answer to send for a field, or undefined for no answer. */
function draftValue(f: ElicitationField, d: Draft): ElicitationValue | undefined {
  switch (f.type) {
    case 'number':
    case 'integer':
      // NaN is left for the check to report
      return typeof d === 'string' && d.trim() !== '' ? Number(d) : undefined;
    case 'boolean':
      return typeof d === 'boolean' ? d : undefined;
    case 'array':
      // Untouched optional picks are no answer rather than an empty one
      return Array.isArray(d) && (d.length > 0 || f.required) ? d : undefined;
    default: {
      if (typeof d !== 'string' || d === '') return undefined;
      if (f.format === 'date-time') {
        const t = new Date(d);
        return Number.isNaN(t.getTime()) ? d : t.toISOString();
      }
      return d;
    }
  }
}

/**
 * The form an agent asks the user to fill in (an ACP elicitation, e.g. Claude's
 * AskUserQuestion), shown above the composer like an approval. Each question's
 * "Other" box is drawn with its question: picking "Other" opens it as the
 * answer, and on a single choice it can also carry a note on the pick.
 */
export const ElicitationCard: React.FC<{
  sessionId: string;
  elicitation: PendingElicitation;
  onAnswered: () => void;
}> = ({ sessionId, elicitation, onAnswered }) => {
  const { fields } = elicitation;
  const uid = useId();
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() =>
    Object.fromEntries(fields.map((f) => [f.key, initialDraft(f)]))
  );
  const [modes, setModes] = useState<Record<string, CustomMode | undefined>>({});
  // The option whose preview shows, per question: the one picked last
  const [previewOf, setPreviewOf] = useState<Record<string, string | undefined>>({});
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState<'accept' | 'decline' | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  const setDraft = (key: string, d: Draft) => setDrafts((prev) => ({ ...prev, [key]: d }));
  const setMode = (key: string, m: CustomMode | undefined) => setModes((prev) => ({ ...prev, [key]: m }));
  // The choice question an "Other" box is drawn under; a box for a plain text question stands alone
  const ownerOf = (f: ElicitationField) =>
    f.customAnswerFor ? fields.find((q) => q.key === f.customAnswerFor && q.options) : undefined;

  // The answers as they would be sent, and what is wrong with them. No prototype: the keys are the agent's
  const content: Record<string, ElicitationValue> = Object.create(null);
  const errors: Record<string, string> = Object.create(null);
  for (const f of fields) {
    const owner = ownerOf(f);
    // An "Other" box counts only while it is open for its question
    const text = drafts[f.key];
    const value = owner && !ownValue(modes, owner.key) ? undefined : typeof text === 'string' && text.trim() === '' ? undefined : draftValue(f, text);
    const error = answerError(f, value, fields);
    if (error) errors[f.key] = error;
    if (value !== undefined) content[f.key] = value;
  }
  const errorCount = Object.keys(errors).length;
  const disabled = busy !== null;

  const send = async (action: 'accept' | 'decline') => {
    if (busy) return;
    if (action === 'accept' && errorCount > 0) {
      setShowErrors(true);
      return;
    }
    setBusy(action);
    setServerError(null);
    try {
      await api.answerElicitation(sessionId, elicitation.requestId, action, action === 'accept' ? content : undefined);
      // Stay busy: the card goes away once the server reports the form settled
      onAnswered();
    } catch (err: any) {
      setServerError(err.message);
      setBusy(null);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      e.stopPropagation();
      send('accept');
    } else if ((e.target as HTMLElement).tagName === 'INPUT') {
      // The card sits inside the composer's form: a plain Enter in a text box would send the prompt
      e.preventDefault();
    }
  };

  const errorFor = (f: ElicitationField) => (showErrors ? errors[f.key] : undefined);

  const labelOf = (f: ElicitationField) => (
    <>
      {f.title || f.description || f.key}
      {f.required && (
        <>
          <span className="ws-ask-required" aria-hidden>
            *
          </span>
          <span className="sr-only"> (required)</span>
        </>
      )}
    </>
  );
  // The description shows under the label unless it already is the label
  const descOf = (f: ElicitationField) => (f.title && f.description ? <div className="ws-ask-desc">{f.description}</div> : null);

  const textControl = (f: ElicitationField, id: string, extra: { placeholder?: string; ariaLabel?: string } = {}) => {
    const value = typeof drafts[f.key] === 'string' ? (drafts[f.key] as string) : '';
    const common = {
      id,
      value,
      disabled,
      placeholder: extra.placeholder,
      'aria-label': extra.ariaLabel,
      'aria-invalid': Boolean(errorFor(f)) || undefined,
      onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(f.key, e.target.value),
    };
    if (f.type === 'number' || f.type === 'integer') {
      return (
        <Input
          {...common}
          type="number"
          // The digit pads have no minus key on iOS: offered only when the answer cannot be negative
          inputMode={f.minimum !== undefined && f.minimum >= 0 ? (f.type === 'integer' ? 'numeric' : 'decimal') : undefined}
          step={f.type === 'integer' ? 1 : 'any'}
          min={f.minimum}
          max={f.maximum}
        />
      );
    }
    const type = f.secret
      ? 'password'
      : f.format === 'email'
        ? 'email'
        : f.format === 'uri'
          ? 'url'
          : f.format === 'date'
            ? 'date'
            : f.format === 'date-time'
              ? 'datetime-local'
              : undefined;
    // Short or formatted answers get one line, open-ended ones a few
    if (type || f.customAnswerFor || (f.maxLength !== undefined && f.maxLength <= 120)) {
      return <Input {...common} type={type || 'text'} autoComplete="off" />;
    }
    return <Textarea {...common} rows={2} />;
  };

  const preview = (f: ElicitationField) => {
    const opt = f.options?.find((o) => o.value === ownValue(previewOf, f.key));
    return opt?.preview ? (
      <div className="ws-ask-preview" aria-label={`Preview of ${opt.title}`}>
        <MarkdownContent content={opt.preview} />
      </div>
    ) : null;
  };

  const optionCard = (f: ElicitationField, o: ElicitationOption, selected: boolean, onSelect: () => void) => (
    <ChoiceCard
      key={o.value}
      multiple={f.type === 'array'}
      selected={selected}
      onSelect={onSelect}
      title={o.title}
      description={o.description}
      badge={o.preview ? <Badge tone="neutral">Preview</Badge> : undefined}
      disabled={disabled}
    />
  );

  /** The "Other" box under its question. */
  const customBox = (custom: ElicitationField, mode: CustomMode | undefined, catchAll: boolean) => {
    if (!mode) return null;
    const placeholder = catchAll ? 'Your answer' : mode === 'other' ? 'Type your own answer' : 'Add a note to your choice';
    const error = errorFor(custom);
    return (
      <div className="ws-ask-custom">
        {textControl(custom, `${uid}-${custom.key}`, { placeholder, ariaLabel: fieldLabel(custom, fields) })}
        {error && <div className="ui-field-error">{error}</div>}
      </div>
    );
  };

  const singleChoice = (f: ElicitationField) => {
    const custom = companionOf(f, fields);
    const mode = custom ? ownValue(modes, f.key) : undefined;
    const picked = mode === 'other' ? undefined : (drafts[f.key] as string | undefined);
    const pickedOpt = f.options?.find((o) => o.value === picked);
    const catchAll = Boolean(pickedOpt && CATCH_ALL.test(pickedOpt.title));
    // An optional question can be answered in the box alone; a required one needs a pick
    const offerOther = Boolean(custom) && !f.required;
    const pick = (o: ElicitationOption) => {
      // Picking the chosen option again clears an optional question
      if (o.value === picked && !f.required) {
        setDraft(f.key, undefined);
        setPreviewOf((p) => ({ ...p, [f.key]: undefined }));
        if (mode === 'note') setMode(f.key, undefined);
        return;
      }
      setDraft(f.key, o.value);
      setPreviewOf((p) => ({ ...p, [f.key]: o.value }));
      if (!custom) return;
      // Text typed as "Other" stays, as a note on the pick
      const typed = typeof drafts[custom.key] === 'string' && (drafts[custom.key] as string).trim() !== '';
      if (CATCH_ALL.test(o.title) || (mode === 'other' && typed) || mode === 'note') setMode(f.key, 'note');
      else setMode(f.key, undefined);
    };
    const chooseOther = () => {
      setDraft(f.key, undefined);
      setPreviewOf((p) => ({ ...p, [f.key]: undefined }));
      setMode(f.key, mode === 'other' ? undefined : 'other');
    };
    return (
      <>
        <div className="ws-ask-choices" role="radiogroup" aria-label={fieldLabel(f, fields)}>
          {f.options!.map((o) => optionCard(f, o, o.value === picked, () => pick(o)))}
          {offerOther && (
            <ChoiceCard
              selected={mode === 'other'}
              onSelect={chooseOther}
              title="Other"
              description="Type your own answer"
              disabled={disabled}
            />
          )}
        </div>
        {preview(f)}
        {custom && customBox(custom, mode, catchAll)}
        {custom && !mode && picked !== undefined && (
          <Button variant="ghost" size="sm" icon="plus" className="ws-ask-note" disabled={disabled} onClick={() => setMode(f.key, 'note')}>
            Add a note
          </Button>
        )}
      </>
    );
  };

  const multiChoice = (f: ElicitationField) => {
    const custom = companionOf(f, fields);
    const mode = custom ? ownValue(modes, f.key) : undefined;
    const picked = Array.isArray(drafts[f.key]) ? (drafts[f.key] as string[]) : [];
    const toggle = (o: ElicitationOption) => {
      const on = !picked.includes(o.value);
      // Keep the agent's option order, whatever order they were clicked in
      setDraft(
        f.key,
        f.options!.filter((x) => (x.value === o.value ? on : picked.includes(x.value))).map((x) => x.value)
      );
      setPreviewOf((p) => {
        const shown = ownValue(p, f.key);
        return { ...p, [f.key]: on ? o.value : shown === o.value ? undefined : shown };
      });
    };
    return (
      <>
        <div className="ws-ask-choices" role="group" aria-label={fieldLabel(f, fields)}>
          {f.options!.map((o) => optionCard(f, o, picked.includes(o.value), () => toggle(o)))}
          {custom && (
            <ChoiceCard
              multiple
              selected={mode === 'other'}
              onSelect={() => setMode(f.key, mode === 'other' ? undefined : 'other')}
              title="Other"
              description="Add your own answer"
              disabled={disabled}
            />
          )}
        </div>
        {preview(f)}
        {custom && customBox(custom, mode, false)}
      </>
    );
  };

  const renderField = (f: ElicitationField) => {
    const id = `${uid}-${f.key}`;
    if (f.type === 'boolean') {
      return (
        <div key={f.key} className="ws-ask-field">
          <Switch
            checked={drafts[f.key] === true}
            onChange={(on) => setDraft(f.key, on)}
            label={labelOf(f)}
            description={f.description && f.title ? f.description : undefined}
            disabled={disabled}
          />
        </div>
      );
    }
    const error = errorFor(f);
    const length = typeof drafts[f.key] === 'string' ? [...(drafts[f.key] as string)].length : 0;
    const counter = f.type === 'string' && !f.options && f.maxLength !== undefined ? `${length}/${f.maxLength}` : undefined;
    return (
      <Field
        key={f.key}
        className="ws-ask-field"
        label={labelOf(f)}
        htmlFor={f.options ? undefined : id}
        aside={counter}
        hint={constraintHint(f)}
        error={error}
      >
        {descOf(f)}
        {f.type === 'array' ? multiChoice(f) : f.options ? singleChoice(f) : textControl(f, id)}
      </Field>
    );
  };

  // An "Other" box is drawn inside its question, not on its own
  const topLevel = fields.filter((f) => !ownerOf(f));

  return (
    <section className="ws-approval ws-ask" aria-label="The agent has a question" onKeyDown={onKeyDown}>
      <span className="ws-approval-icon" aria-hidden>
        <Icon name="help" size={16} />
      </span>
      <div className="ws-approval-body">
        <div className="ws-approval-kicker">
          {elicitation.subagent ? `Question · ${elicitation.subagent} subagent` : 'Question from the agent'}
        </div>
        <div className="ws-ask-message">{elicitation.message}</div>
      </div>
      {topLevel.length > 0 && <div className="ws-ask-fields">{topLevel.map(renderField)}</div>}
      <div className="ws-ask-foot">
        {serverError ? (
          <div className="ws-ask-error" role="alert">
            {serverError}
          </div>
        ) : showErrors && errorCount > 0 ? (
          <div className="ws-ask-error" role="alert">
            {errorCount === 1 ? Object.values(errors)[0] : `${errorCount} answers need a look`}
          </div>
        ) : (
          <span className="ws-ask-hint">
            <Kbd>{MOD_KEY}</Kbd>
            <Kbd>Enter</Kbd> to submit
          </span>
        )}
        <span className="ws-approval-main">
          <Button
            variant="secondary"
            size="sm"
            icon="x"
            loading={busy === 'decline'}
            disabled={disabled && busy !== 'decline'}
            onClick={() => send('decline')}
            title="Tell the agent you'd rather not answer"
          >
            Skip
          </Button>
          <Button
            variant="primary"
            size="sm"
            icon="check"
            loading={busy === 'accept'}
            disabled={disabled && busy !== 'accept'}
            onClick={() => send('accept')}
          >
            Submit
          </Button>
        </span>
      </div>
    </section>
  );
};

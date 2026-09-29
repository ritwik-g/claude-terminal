import React from 'react';
import { Icon, Spinner, type IconName } from '../components/Icons';
import './ui.css';

// Shared building blocks. Surfaces compose these instead of styling raw
// elements, so buttons, badges and fields look and behave the same everywhere.

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-ghost';
type Size = 'sm' | 'md' | 'lg';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: Size;
  icon?: IconName;
  iconRight?: IconName;
  loading?: boolean;
  /** Stretch to the container width. */
  block?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'secondary', size = 'md', icon, iconRight, loading, block, className, children, type = 'button', disabled, ...rest }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cx('ui-btn', `ui-btn-${variant}`, `ui-btn-${size}`, block && 'ui-btn-block', className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner size={size === 'sm' ? 11 : 13} /> : icon && <Icon name={icon} size={size === 'sm' ? 13 : 15} />}
      {children != null && <span className="ui-btn-label">{children}</span>}
      {iconRight && <Icon name={iconRight} size={size === 'sm' ? 13 : 14} />}
    </button>
  )
);
Button.displayName = 'Button';

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconName;
  /** Accessible name; also used as the tooltip unless `title` is given. */
  label: string;
  variant?: 'ghost' | 'secondary';
  size?: Size;
  /** Pressed/selected state for toggles. */
  active?: boolean;
  tone?: 'default' | 'warn' | 'ok' | 'accent' | 'danger';
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ icon, label, variant = 'ghost', size = 'md', active, tone = 'default', className, title, type = 'button', ...rest }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cx('ui-iconbtn', `ui-iconbtn-${variant}`, `ui-iconbtn-${size}`, active && 'is-active', `tone-${tone}`, className)}
      aria-label={label}
      title={title ?? label}
      {...rest}
    >
      <Icon name={icon} size={size === 'sm' ? 14 : size === 'lg' ? 18 : 16} />
    </button>
  )
);
IconButton.displayName = 'IconButton';

export type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger' | 'info';

export const Badge: React.FC<{
  tone?: Tone;
  dot?: boolean;
  icon?: IconName;
  mono?: boolean;
  className?: string;
  title?: string;
  children: React.ReactNode;
}> = ({ tone = 'neutral', dot, icon, mono, className, title, children }) => (
  <span className={cx('ui-badge', `tone-${tone}`, mono && 'mono', className)} title={title}>
    {dot && <span className="ui-badge-dot" />}
    {icon && <Icon name={icon} size={11} />}
    {children}
  </span>
);

/** A small coloured status dot, e.g. for session state. */
export const StatusDot: React.FC<{ tone: Tone; pulse?: boolean; label?: string }> = ({ tone, pulse, label }) => (
  <span className={cx('ui-dot', `tone-${tone}`, pulse && 'is-pulsing')} role={label ? 'img' : undefined} aria-label={label} />
);

export const Card: React.FC<
  React.HTMLAttributes<HTMLDivElement> & { padding?: 'none' | 'sm' | 'md' | 'lg'; interactive?: boolean; selected?: boolean }
> = ({ padding = 'md', interactive, selected, className, children, ...rest }) => (
  <div className={cx('ui-card', `pad-${padding}`, interactive && 'is-interactive', selected && 'is-selected', className)} {...rest}>
    {children}
  </div>
);

export const Field: React.FC<{
  label: React.ReactNode;
  htmlFor?: string;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  /** Optional element on the label row's right, e.g. a link. */
  aside?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}> = ({ label, htmlFor, hint, error, aside, children, className }) => (
  <div className={cx('ui-field', className)}>
    <div className="ui-field-head">
      <label className="ui-field-label" htmlFor={htmlFor}>
        {label}
      </label>
      {aside && <span className="ui-field-aside">{aside}</span>}
    </div>
    {children}
    {error ? <div className="ui-field-error">{error}</div> : hint ? <div className="ui-field-hint">{hint}</div> : null}
  </div>
);

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }>(
  ({ className, mono, ...rest }, ref) => <input ref={ref} className={cx('ui-input', mono && 'mono', className)} {...rest} />
);
Input.displayName = 'Input';

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...rest }, ref) => <textarea ref={ref} className={cx('ui-input', 'ui-textarea', className)} {...rest} />
);
Textarea.displayName = 'Textarea';

export interface SegmentOption<T extends string> {
  value: T;
  label: React.ReactNode;
  icon?: IconName;
  title?: string;
}

/** A row of mutually exclusive buttons (radio group semantics). */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  size = 'md',
  label,
  block,
}: {
  options: Array<SegmentOption<T>>;
  value: T;
  onChange: (value: T) => void;
  size?: 'sm' | 'md';
  label: string;
  block?: boolean;
}) {
  return (
    <div className={cx('ui-segmented', `ui-segmented-${size}`, block && 'ui-segmented-block')} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={cx('ui-segment', o.value === value && 'is-selected')}
          onClick={() => onChange(o.value)}
          title={o.title}
        >
          {o.icon && <Icon name={o.icon} size={13} />}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A large selectable option with a title and description (radio semantics). */
export const ChoiceCard: React.FC<{
  selected: boolean;
  onSelect: () => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  badge?: React.ReactNode;
  disabled?: boolean;
}> = ({ selected, onSelect, title, description, icon, badge, disabled }) => (
  <button
    type="button"
    role="radio"
    aria-checked={selected}
    disabled={disabled}
    className={cx('ui-choice', selected && 'is-selected')}
    onClick={onSelect}
  >
    {icon && <span className="ui-choice-icon">{icon}</span>}
    <span className="ui-choice-text">
      <span className="ui-choice-title">
        {title}
        {badge}
      </span>
      {description && <span className="ui-choice-desc">{description}</span>}
    </span>
    <span className="ui-choice-check" aria-hidden>
      {selected && <Icon name="check" size={13} />}
    </span>
  </button>
);

export const Switch: React.FC<{
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: React.ReactNode;
  description?: React.ReactNode;
  disabled?: boolean;
}> = ({ checked, onChange, label, description, disabled }) => (
  <label className={cx('ui-switch-row', disabled && 'is-disabled')}>
    <span className="ui-switch-text">
      <span className="ui-switch-label">{label}</span>
      {description && <span className="ui-switch-desc">{description}</span>}
    </span>
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={cx('ui-switch', checked && 'is-on')}
      onClick={() => onChange(!checked)}
    >
      <span className="ui-switch-thumb" />
    </button>
  </label>
);

export interface TabItem<T extends string> {
  id: T;
  label: React.ReactNode;
  icon?: IconName;
  count?: number;
}

export function Tabs<T extends string>({
  items,
  value,
  onChange,
  label,
  className,
}: {
  items: Array<TabItem<T>>;
  value: T;
  onChange: (id: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <div className={cx('ui-tabs', className)} role="tablist" aria-label={label}>
      {items.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={t.id === value}
          className={cx('ui-tab', t.id === value && 'is-selected')}
          onClick={() => onChange(t.id)}
        >
          {t.icon && <Icon name={t.icon} size={14} />}
          {t.label}
          {t.count != null && t.count > 0 && <span className="ui-tab-count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export const Kbd: React.FC<{ children: React.ReactNode }> = ({ children }) => <kbd className="ui-kbd">{children}</kbd>;

export const EmptyState: React.FC<{
  icon?: IconName;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  compact?: boolean;
}> = ({ icon, title, description, action, compact }) => (
  <div className={cx('ui-empty', compact && 'is-compact')}>
    {icon && (
      <span className="ui-empty-icon">
        <Icon name={icon} size={compact ? 18 : 22} />
      </span>
    )}
    <div className="ui-empty-title">{title}</div>
    {description && <div className="ui-empty-desc">{description}</div>}
    {action && <div className="ui-empty-action">{action}</div>}
  </div>
);

export const Progress: React.FC<{ value: number; tone?: Tone; label?: string; size?: 'sm' | 'md' }> = ({
  value,
  tone = 'accent',
  label,
  size = 'md',
}) => {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div
      className={cx('ui-progress', `ui-progress-${size}`)}
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <span className={cx('ui-progress-fill', `tone-${tone}`)} style={{ width: `${pct}%` }} />
    </div>
  );
};

export const Stat: React.FC<{ label: React.ReactNode; value: React.ReactNode; hint?: React.ReactNode; tone?: Tone }> = ({
  label,
  value,
  hint,
  tone,
}) => (
  <div className="ui-stat">
    <div className="ui-stat-label">{label}</div>
    <div className={cx('ui-stat-value', tone && `tone-${tone}`)}>{value}</div>
    {hint && <div className="ui-stat-hint">{hint}</div>}
  </div>
);

export const SectionHeader: React.FC<{ title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode }> = ({
  title,
  description,
  actions,
}) => (
  <div className="ui-section-head">
    <div>
      <div className="ui-section-title">{title}</div>
      {description && <div className="ui-section-desc">{description}</div>}
    </div>
    {actions && <div className="ui-section-actions">{actions}</div>}
  </div>
);

export { Icon, Spinner };
export type { IconName };

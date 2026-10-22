// Presentational building blocks for centers, dashboards, lists and reports:
// Badge / StatusPill, MoneyBar, StatCard, Card, FilterChips, SearchBox, SegmentedControl, SidePanel.
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Search, X, type LucideIcon } from 'lucide-react';
import { fmtMoney } from '@/util/format';
import { renderIcon } from './buttons';
import './layers';

function cx(...c: (string | false | null | undefined)[]): string {
  return c.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// Badge / StatusPill

/** Color of a badge. */
export type Tone = 'neutral' | 'accent' | 'success' | 'danger' | 'warning' | 'info' | 'muted';

/** Props of {@link Badge}. */
export interface BadgeProps {
  children: ReactNode;
  /** Color (default neutral gray). */
  tone?: Tone;
  /** Small colored dot before the text. */
  dot?: boolean;
  /** Filled (solid) look instead of the soft tint. */
  solid?: boolean;
  title?: string;
  className?: string;
  style?: CSSProperties;
}

/** Small rounded label ("3", "New", "Inactive"). */
export function Badge({ children, tone = 'neutral', dot, solid, title, className, style }: BadgeProps) {
  return (
    <span className={cx('sx-badge', `sx-tone-${tone}`, solid && 'sx-solid', className)} title={title} style={style}>
      {dot && <span className="sx-badge-dot" aria-hidden="true" />}
      {children}
    </span>
  );
}

const STATUS_TONES: Record<string, Tone> = {
  paid: 'success',
  closed: 'muted',
  received: 'success',
  'received in full': 'success',
  deposited: 'success',
  reconciled: 'success',
  cleared: 'success',
  accepted: 'success',
  applied: 'success',
  final: 'success',
  added: 'success',
  matched: 'success',
  open: 'accent',
  unpaid: 'accent',
  sent: 'accent',
  'not deposited': 'info',
  unapplied: 'info',
  'to print': 'info',
  new: 'info',
  overdue: 'danger',
  'past due': 'danger',
  rejected: 'danger',
  declined: 'danger',
  error: 'danger',
  pending: 'warning',
  partial: 'warning',
  'partially paid': 'warning',
  'partially received': 'warning',
  'due soon': 'warning',
  draft: 'neutral',
  void: 'muted',
  voided: 'muted',
  inactive: 'muted',
  excluded: 'muted',
  expired: 'muted',
};

/** The badge tone used for a status word ("Paid" → success, "Overdue" → danger...). */
export function statusTone(status: string): Tone {
  return STATUS_TONES[status.trim().toLowerCase()] ?? 'neutral';
}

/** Props of {@link StatusPill}. */
export interface StatusPillProps {
  /** Status text: Paid, Open, Overdue, Pending, Void, Draft, Closed, Partially paid, Deposited... */
  status: string;
  /** Override the color picked from the status word. */
  tone?: Tone;
  /** Extra text after the status ("Overdue · 12 days"). */
  detail?: ReactNode;
  className?: string;
}

/** Colored status label for transactions in lists (Paid, Open, Overdue, Pending, Void...). */
export function StatusPill({ status, tone, detail, className }: StatusPillProps) {
  if (!status) return null;
  const t = tone ?? statusTone(status);
  return (
    <span className={cx('sx-pill', `sx-tone-${t}`, /^void(ed)?$/i.test(status) && 'sx-pill-void', className)}>
      <span className="sx-badge-dot" aria-hidden="true" />
      {status}
      {detail ? <span className="sx-pill-detail">{detail}</span> : null}
    </span>
  );
}

// ---------------------------------------------------------------------------
// MoneyBar

/** One segment of a {@link MoneyBar}. */
export interface MoneyBarSegment {
  key: string;
  /** Text under the amount ("Overdue", "Open invoices"). */
  label: string;
  amount: number;
  /** Number of documents ("3 overdue"); shown after the label. */
  count?: number;
  /** Bar color: a tone name or any CSS color. */
  color?: Tone | string;
  /** Segments with the same group share a caption above them ("Unpaid", "Last 365 days"). */
  group?: string;
  /** Small text right of the group caption. */
  groupNote?: string;
  /** Not clickable. */
  disabled?: boolean;
}

/** Props of {@link MoneyBar}. */
export interface MoneyBarProps {
  segments: MoneyBarSegment[];
  /** Key of the selected (filtering) segment. */
  selected?: string | null;
  /** Called with the clicked segment key (null when the selected one is clicked again). */
  onSelect?: (key: string | null) => void;
  /** Format of the amounts (default "$1,234.56"). */
  format?: (n: number) => string;
  className?: string;
  'aria-label'?: string;
}

const TONE_COLORS: Record<string, string> = {
  neutral: 'var(--sx-mb-neutral, #94a3b8)',
  accent: 'var(--sx-accent, #2563eb)',
  success: 'var(--sx-success, #16a34a)',
  danger: 'var(--sx-danger, #dc2626)',
  warning: 'var(--sx-warning, #d97706)',
  info: 'var(--sx-mb-info, #0891b2)',
  muted: 'var(--sx-mb-muted, #cbd5e1)',
};

const money$ = (n: number) => '$' + fmtMoney(n);

/**
 * Money bar: amounts with labels over colored bars whose widths follow the amounts;
 * each segment is a clickable filter (Customer Center: Estimates, Unbilled, Overdue, Open
 * invoices, Paid last 30 days).
 */
export function MoneyBar({ segments, selected, onSelect, format = money$, className, ...rest }: MoneyBarProps) {
  const total = segments.reduce((s, x) => s + Math.max(0, Math.abs(x.amount)), 0);
  // group consecutive segments with the same group caption
  const groups: { key: string; caption?: string; note?: string; segs: MoneyBarSegment[] }[] = [];
  for (const s of segments) {
    const last = groups[groups.length - 1];
    if (last && s.group !== undefined && last.caption === s.group) last.segs.push(s);
    else groups.push({ key: s.key, caption: s.group, note: s.groupNote, segs: [s] });
  }
  const grow = (s: MoneyBarSegment) => (total > 0 ? Math.max(0.12, Math.abs(s.amount) / total) : 1);
  return (
    <div className={cx('sx-moneybar', className)} role="group" aria-label={rest['aria-label']}>
      {groups.map((g) => (
        <div key={g.key} className="sx-mb-group" style={{ flexGrow: g.segs.reduce((a, s) => a + grow(s), 0) }}>
          {g.caption !== undefined && (
            <div className="sx-mb-caption">
              <span>{g.caption}</span>
              {g.note && <span className="sx-mb-note">{g.note}</span>}
            </div>
          )}
          <div className="sx-mb-segs">
            {g.segs.map((s) => {
              const color = s.color ? TONE_COLORS[s.color] ?? s.color : TONE_COLORS.accent;
              const sel = selected === s.key;
              return (
                <button
                  key={s.key}
                  type="button"
                  className={cx('sx-mb-seg', sel && 'sx-selected', !!selected && !sel && 'sx-dimmed')}
                  style={{ flexGrow: grow(s), ['--sx-mb-color' as string]: color }}
                  disabled={s.disabled || !onSelect}
                  aria-pressed={onSelect ? sel : undefined}
                  onClick={() => onSelect?.(sel ? null : s.key)}
                >
                  <span className="sx-mb-amount">{format(s.amount)}</span>
                  <span className="sx-mb-label">
                    {s.count !== undefined ? `${s.count} ` : ''}
                    {s.label}
                  </span>
                  <span className="sx-mb-bar" aria-hidden="true" />
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// StatCard / Card

/** Props of {@link StatCard}. */
export interface StatCardProps {
  /** Small caption ("Open invoices"). */
  label: ReactNode;
  /** Big value; numbers are formatted as money ("$1,234.56"). */
  value: ReactNode | number;
  /** Line under the value ("3 invoices", "+12% vs last month"). */
  sub?: ReactNode;
  /** Colors the value and the left accent. */
  tone?: Tone;
  icon?: LucideIcon | ReactNode;
  /** Makes the card a button (e.g. opens a filtered list). */
  onClick?: () => void;
  selected?: boolean;
  /** Content under the value (a mini chart, a list). */
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

/** Dashboard number card (Home page, centers). */
export function StatCard({ label, value, sub, tone, icon, onClick, selected, children, className, style }: StatCardProps) {
  const body = (
    <>
      <div className="sx-stat-head">
        {icon && <span className="sx-stat-icon">{renderIcon(icon, 16)}</span>}
        <span className="sx-stat-label">{label}</span>
      </div>
      <div className={cx('sx-stat-value', tone && `sx-tone-text-${tone}`)}>{typeof value === 'number' ? money$(value) : value}</div>
      {sub !== undefined && <div className="sx-stat-sub">{sub}</div>}
      {children}
    </>
  );
  const cls = cx('sx-stat', tone && `sx-stat-${tone}`, onClick && 'sx-clickable', selected && 'sx-selected', className);
  return onClick ? (
    <button type="button" className={cls} style={style} onClick={onClick} aria-pressed={selected}>
      {body}
    </button>
  ) : (
    <div className={cls} style={style}>
      {body}
    </div>
  );
}

/** Props of {@link Card}. */
export interface CardProps {
  title?: ReactNode;
  /** Small text right of the title. */
  subtitle?: ReactNode;
  /** Buttons/links at the right of the header. */
  actions?: ReactNode;
  children?: ReactNode;
  /** No inner padding (lists, grids that touch the edges). */
  flush?: boolean;
  className?: string;
  style?: CSSProperties;
}

/** White rounded panel with an optional header (dashboard cards, side panels, info boxes). */
export function Card({ title, subtitle, actions, children, flush, className, style }: CardProps) {
  return (
    <section className={cx('sx-card', className)} style={style}>
      {(title !== undefined || actions) && (
        <header className="sx-card-head">
          <div className="sx-card-titles">
            {title !== undefined && <h3 className="sx-card-title">{title}</h3>}
            {subtitle !== undefined && <span className="sx-card-sub">{subtitle}</span>}
          </div>
          {actions && <div className="sx-card-actions">{actions}</div>}
        </header>
      )}
      <div className={cx('sx-card-body', flush && 'sx-flush')}>{children}</div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// FilterChips

/** One chip of {@link FilterChips}. */
export interface ChipOption {
  key: string;
  label: ReactNode;
  /** Small number after the label. */
  count?: number;
  disabled?: boolean;
}

/** Props of {@link FilterChips}. */
export interface FilterChipsProps {
  options: ChipOption[];
  /** Selected key (single) or keys (multiple). */
  value: string | null | string[];
  /** Called with the new key (single; null when "All"/none) or keys (multiple). */
  onChange: (value: any) => void;
  /** Several chips can be on at once (value is an array). */
  multiple?: boolean;
  /** Adds an "All" chip first that clears the filter (single: null, multiple: []). */
  allLabel?: string;
  className?: string;
  'aria-label'?: string;
}

/** Row of toggle chips used as quick filters (account type groups, item types, status). */
export function FilterChips({ options, value, onChange, multiple, allLabel, className, ...rest }: FilterChipsProps) {
  const sel = new Set(Array.isArray(value) ? value : value ? [value] : []);
  const toggle = (k: string) => {
    if (multiple) {
      const n = new Set(sel);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      onChange(options.map((o) => o.key).filter((x) => n.has(x)));
    } else onChange(sel.has(k) ? null : k);
  };
  return (
    <div className={cx('sx-chips', className)} role="group" aria-label={rest['aria-label']}>
      {allLabel !== undefined && (
        <button type="button" className={cx('sx-chip', sel.size === 0 && 'sx-on')} aria-pressed={sel.size === 0} onClick={() => onChange(multiple ? [] : null)}>
          {allLabel}
        </button>
      )}
      {options.map((o) => (
        <button key={o.key} type="button" className={cx('sx-chip', sel.has(o.key) && 'sx-on')} aria-pressed={sel.has(o.key)} disabled={o.disabled} onClick={() => toggle(o.key)}>
          {o.label}
          {o.count !== undefined && <span className="sx-chip-count">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SearchBox

/** Props of {@link SearchBox}. */
export interface SearchBoxProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Wait this many ms after typing before calling onChange (default 0 = immediately). */
  debounce?: number;
  /** Called on Enter. */
  onEnter?: (value: string) => void;
  autoFocus?: boolean;
  width?: number | string;
  name?: string;
  className?: string;
  'aria-label'?: string;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}

/** Search input with a magnifier and a clear (×) button; Escape clears it. */
export function SearchBox({ value, onChange, placeholder = 'Search', debounce = 0, onEnter, autoFocus, width, name, className, onKeyDown, ...rest }: SearchBoxProps) {
  const [text, setText] = useState(value);
  const timer = useRef<number | undefined>(undefined);
  const last = useRef(value);
  useEffect(() => {
    if (value !== last.current) {
      last.current = value;
      setText(value);
    }
  }, [value]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const emit = (v: string, now = false) => {
    window.clearTimeout(timer.current);
    if (!debounce || now) {
      last.current = v;
      onChange(v);
    } else
      timer.current = window.setTimeout(() => {
        last.current = v;
        onChange(v);
      }, debounce);
  };
  return (
    <div className={cx('sx-search', className)} style={{ width }}>
      <Search size={14} className="sx-search-icon" aria-hidden="true" />
      <input
        type="text"
        className="sx-input sx-search-input"
        value={text}
        name={name}
        placeholder={placeholder}
        autoFocus={autoFocus}
        autoComplete="off"
        spellCheck={false}
        aria-label={rest['aria-label'] ?? placeholder}
        onChange={(e) => {
          setText(e.target.value);
          emit(e.target.value);
        }}
        onKeyDown={(e) => {
          onKeyDown?.(e);
          if (e.defaultPrevented) return;
          if (e.key === 'Escape' && text) {
            e.preventDefault();
            e.stopPropagation();
            setText('');
            emit('', true);
          } else if (e.key === 'Enter') {
            emit(text, true);
            onEnter?.(text);
          }
        }}
      />
      {text && (
        <button
          type="button"
          className="sx-search-clear"
          tabIndex={-1}
          aria-label="Clear search"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setText('');
            emit('', true);
          }}
        >
          <X size={13} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SegmentedControl

/** One option of {@link SegmentedControl}. */
export interface SegmentOption<V extends string> {
  value: V;
  label: ReactNode;
  icon?: LucideIcon | ReactNode;
  disabled?: boolean;
  title?: string;
}

/** Props of {@link SegmentedControl}. */
export interface SegmentedControlProps<V extends string> {
  options: SegmentOption<V>[];
  value: V;
  onChange: (value: V) => void;
  size?: 'sm' | 'md';
  /** Stretch to the container width (options share it equally). */
  block?: boolean;
  name?: string;
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
}

/** Pill-shaped choice of a few options (Accrual | Cash, Payments | Deposits | All, Bill | Credit). */
export function SegmentedControl<V extends string>({ options, value, onChange, size = 'md', block, name, disabled, className, ...rest }: SegmentedControlProps<V>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = options.filter((o) => !o.disabled);
  return (
    <div className={cx('sx-seg', size === 'sm' && 'sx-seg-sm', block && 'sx-seg-block', disabled && 'sx-disabled', className)} role="radiogroup" aria-label={rest['aria-label']} data-field={name}>
      {options.map((o, i) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => (refs.current[i] = el)}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            title={o.title}
            disabled={disabled || o.disabled}
            className={cx('sx-seg-opt', on && 'sx-on')}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
              e.preventDefault();
              const j = enabled.findIndex((x) => x.value === o.value);
              const n = enabled[(j + (e.key === 'ArrowRight' ? 1 : -1) + enabled.length) % enabled.length];
              if (n) {
                onChange(n.value);
                refs.current[options.indexOf(n)]?.focus();
              }
            }}
          >
            {o.icon && <span className="sx-seg-icon">{renderIcon(o.icon, 14)}</span>}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SidePanel

/** Props of {@link SidePanel}. */
export interface SidePanelProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  /** Width in px (default 340). */
  width?: number;
  /** Buttons at the bottom (e.g. Apply / Reset). */
  footer?: ReactNode;
  children?: ReactNode;
  /**
   * "absolute" (default): slides over its positioned container (a window body);
   * "fixed": over the whole viewport.
   */
  position?: 'absolute' | 'fixed';
  /** Dim the content behind; clicking it closes the panel (default true). */
  backdrop?: boolean;
  /** Side it slides from (default right). */
  side?: 'right' | 'left';
  className?: string;
}

/**
 * Slide-in panel (report Customize panel, filters, details). Escape closes it. Put it inside a
 * `position: relative` container (window bodies are) or use position="fixed".
 */
export function SidePanel({ open, onClose, title, width = 340, footer, children, position = 'absolute', backdrop = true, side = 'right', className }: SidePanelProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (open) {
      setMounted(true);
      const r = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(r);
    }
    setShown(false);
    const t = window.setTimeout(() => setMounted(false), 180);
    return () => window.clearTimeout(t);
  }, [open]);
  useEffect(() => {
    if (open && shown && ref.current && !ref.current.contains(document.activeElement)) ref.current.focus({ preventScroll: true });
  }, [open, shown]);
  if (!mounted) return null;
  return (
    <div className={cx('sx-sidepanel-layer', position === 'fixed' && 'sx-fixed', shown && 'sx-shown', !backdrop && 'sx-nobackdrop')}>
      {backdrop && <div className="sx-sidepanel-backdrop" onMouseDown={onClose} />}
      <div
        ref={ref}
        className={cx('sx-sidepanel', `sx-from-${side}`, className)}
        style={{ width }}
        role="dialog"
        aria-label={typeof title === 'string' ? title : undefined}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !e.defaultPrevented) {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="sx-sidepanel-head">
          <span className="sx-sidepanel-title">{title}</span>
          <button type="button" className="sx-iconbtn" aria-label="Close panel" title="Close (Esc)" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="sx-sidepanel-body">{children}</div>
        {footer && <div className="sx-sidepanel-foot">{footer}</div>}
      </div>
    </div>
  );
}

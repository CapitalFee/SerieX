// Basic input controls (28px fields, 4px radius, accent focus ring).
//
// Inline errors: inside a FormErrorsProvider (TxnFormFrame, EditDialog, useFormErrors), a control
// whose `name` has an error gets a red border and a short message right under it (the message is
// rendered as the next sibling, so place controls in a block or column container such as
// TxnHeaderField or Field). Grid cells (`inGrid`) only get the red border. Editing the field
// clears its error. `hideErrorMessage` keeps the border but drops the message.
import {
  forwardRef,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type InputHTMLAttributes,
  type LabelHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import type { Address } from '@/api/types';
import { fmtMoney, fmtQty, parseMoney, parseNumber } from '@/util/format';
import { explain } from '@/util/glossary';
import { FieldMessage, useFieldErrorState } from './formErrors';
import { HelpTip } from './HelpTip';
import './layers';

function cx(...c: (string | false | null | undefined)[]): string {
  return c.filter(Boolean).join(' ');
}

function widthStyle(width: number | string | undefined, style?: CSSProperties): CSSProperties | undefined {
  if (width === undefined) return style;
  return { width, ...style };
}

// ---------------------------------------------------------------------------
// Label

/** Props of {@link Label}. */
export interface LabelProps extends LabelHTMLAttributes<HTMLLabelElement> {
  children: ReactNode;
  /** Draw the label in the normal (sentence case) style used in dialogs. */
  plain?: boolean;
  /**
   * Adds a "?" help tip after the text: a glossary term ("Undeposited Funds", "Class", "A/R
   * account"...) shows its plain-English explanation; any other text is shown as is.
   */
  help?: string;
  /** Shows a small required marker (•) after the text. */
  required?: boolean;
}

/** Props for a HelpTip from a `help` string: a known glossary term, or free text. */
export function helpTipProps(help: string): { term?: string; text?: string } {
  return explain(help) ? { term: help } : { text: help };
}

/** Small uppercase label shown above a form field ("CUSTOMER OR JOB", "DATE"), or `plain` for dialogs. */
export function Label({ children, plain, help, required, className, ...rest }: LabelProps) {
  return (
    <label className={cx(plain ? 'sx-label-plain' : 'sx-label', (help || required) && 'sx-label-flex', className)} {...rest}>
      <span className="sx-label-text">{children}</span>
      {required && (
        <span className="sx-required" aria-label="required">
          *
        </span>
      )}
      {help && <HelpTip {...helpTipProps(help)} />}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Field (label + control + help text) for dialogs

/** Props of {@link Field}. */
export interface FieldProps {
  /** Label text (sentence case in dialogs: "Customer name"). */
  label?: ReactNode;
  /** id of the control so clicking the label focuses it. */
  htmlFor?: string;
  /** "?" help tip after the label (glossary term or text). */
  help?: string;
  /** Gray helper text under the control. */
  hint?: ReactNode;
  required?: boolean;
  /** "stacked" (default): label above; "inline": label on the left (`labelWidth`). */
  layout?: 'stacked' | 'inline';
  /** Width of the label column in inline layout (default 130). */
  labelWidth?: number;
  /** Width of the whole field. */
  width?: number | string;
  /** Uppercase small label (transaction form style) instead of the dialog style. */
  caps?: boolean;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}

/** A labeled field for dialogs: label (+ help tip), control, inline error (from the control) and hint. */
export function Field({ label, htmlFor, help, hint, required, layout = 'stacked', labelWidth = 130, width, caps, children, className, style }: FieldProps) {
  const inline = layout === 'inline';
  return (
    <div
      className={cx('sx-field', inline && 'sx-field-inline', className)}
      style={{ width, ...(inline ? { gridTemplateColumns: `${labelWidth}px minmax(0, 1fr)` } : null), ...style }}
    >
      {label !== undefined ? (
        <Label plain={!caps} htmlFor={htmlFor} help={help} required={required} className="sx-field-label">
          {label}
        </Label>
      ) : inline ? (
        <span />
      ) : null}
      <div className="sx-field-ctl">
        {children}
        {hint && <FieldMessage tone="help">{hint}</FieldMessage>}
      </div>
    </div>
  );
}

/** Props of {@link FieldRow}. */
export interface FieldRowProps {
  children: ReactNode;
  /** Gap between fields in px (default 12). */
  gap?: number;
  /** Align the fields' bottoms (default) or tops. */
  align?: 'end' | 'start';
  className?: string;
  style?: CSSProperties;
}

/** Fields side by side (wraps on narrow dialogs). */
export function FieldRow({ children, gap = 12, align = 'start', className, style }: FieldRowProps) {
  return (
    <div className={cx('sx-fieldrow', className)} style={{ gap, alignItems: align === 'end' ? 'flex-end' : 'flex-start', ...style }}>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TextField

/** Props of {@link TextField}. All native input props are passed through. */
export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'size'> {
  value: string | null | undefined;
  /** Called on every keystroke with the new text. */
  onChange?: (value: string, e: React.ChangeEvent<HTMLInputElement>) => void;
  /** Width in px or any CSS width (default: fills its container). */
  width?: number | string;
  /** Select the whole text when the field receives focus (default true, so typing replaces the value). */
  selectOnFocus?: boolean;
  /** Text alignment. */
  align?: 'left' | 'right' | 'center';
  /** Borderless style for grid cells. */
  inGrid?: boolean;
  /** Red border (validation problem). Errors from a FormErrorsProvider (by `name`) set it automatically. */
  invalid?: boolean;
  /** Keep the red border of an inline error but do not show its message under the field. */
  hideErrorMessage?: boolean;
}

/** Inline error wiring shared by the controls (see the file header). */
export function useControlError(name: string | undefined, inGrid?: boolean, hideMessage?: boolean) {
  const fe = useFieldErrorState(name);
  const msgId = useId();
  const show = !!fe.error && !inGrid && !hideMessage;
  return {
    error: fe.error,
    clear: fe.clear,
    describedBy: show ? msgId : undefined,
    message: show ? <FieldMessage id={msgId}>{fe.error}</FieldMessage> : null,
  };
}

/** Single-line text input. */
export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { value, onChange, width, selectOnFocus = true, align, inGrid, invalid, hideErrorMessage, className, style, onFocus, ...rest },
  ref,
) {
  const err = useControlError(rest.name, inGrid, hideErrorMessage);
  return (
    <>
      <input
        ref={ref}
        type="text"
        autoComplete="off"
        spellCheck={false}
        {...rest}
        aria-invalid={invalid || !!err.error || undefined}
        aria-describedby={err.describedBy ?? rest['aria-describedby']}
        className={cx('sx-input', inGrid && 'sx-in-grid', (invalid || err.error) && 'sx-invalid', align && `sx-align-${align}`, className)}
        style={widthStyle(width, style)}
        value={value ?? ''}
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          err.clear();
          onChange?.(e.target.value, e);
        }}
        onFocus={(e) => {
          if (selectOnFocus && !rest.readOnly) e.target.select();
          onFocus?.(e);
        }}
      />
      {err.message}
    </>
  );
});

// ---------------------------------------------------------------------------
// TextArea

/** Props of {@link TextArea}. */
export interface TextAreaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> {
  value: string | null | undefined;
  onChange?: (value: string) => void;
  width?: number | string;
  height?: number | string;
  invalid?: boolean;
  hideErrorMessage?: boolean;
}

/** Multi-line text input (memos, notes). */
export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea({ value, onChange, width, height, invalid, hideErrorMessage, className, style, ...rest }, ref) {
  const err = useControlError(rest.name, false, hideErrorMessage);
  return (
    <>
      <textarea
        ref={ref}
        spellCheck={false}
        {...rest}
        aria-invalid={invalid || !!err.error || undefined}
        aria-describedby={err.describedBy ?? rest['aria-describedby']}
        className={cx('sx-textarea', (invalid || err.error) && 'sx-invalid', className)}
        style={{ width, height, ...style }}
        value={value ?? ''}
        onChange={(e) => {
          err.clear();
          onChange?.(e.target.value);
        }}
      />
      {err.message}
    </>
  );
});

// ---------------------------------------------------------------------------
// Checkbox / Radio

/** Props of {@link Checkbox}. */
export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'checked' | 'onChange'> {
  checked: boolean;
  onChange?: (checked: boolean) => void;
  /** Text to the right of the box (clicking it toggles too). */
  label?: ReactNode;
}

/** Check box with an optional label. */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox({ checked, onChange, label, className, style, title, ...rest }, ref) {
  return (
    <label className={cx('sx-check', rest.disabled && 'sx-disabled', className)} style={style} title={title}>
      <input ref={ref} type="checkbox" {...rest} checked={!!checked} onChange={(e) => onChange?.(e.target.checked)} />
      {label !== undefined && <span>{label}</span>}
    </label>
  );
});

/** Props of {@link Radio}. */
export interface RadioProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'checked' | 'onChange'> {
  checked: boolean;
  /** Called when this radio becomes selected. */
  onChange?: () => void;
  label?: ReactNode;
}

/** Radio button with a label. Give radios of one group the same `name`. */
export const Radio = forwardRef<HTMLInputElement, RadioProps>(function Radio({ checked, onChange, label, className, style, title, ...rest }, ref) {
  return (
    <label className={cx('sx-radio', rest.disabled && 'sx-disabled', className)} style={style} title={title}>
      <input ref={ref} type="radio" {...rest} checked={!!checked} onChange={(e) => e.target.checked && onChange?.()} />
      {label !== undefined && <span>{label}</span>}
    </label>
  );
});

/** Props of {@link RadioGroup}. */
export interface RadioGroupProps<V extends string | number> {
  value: V;
  options: { value: V; label: ReactNode; disabled?: boolean }[];
  onChange(value: V): void;
  /** Lay the radios out in a row (default column). */
  row?: boolean;
  name?: string;
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
}

/** A group of radio buttons ("Accrual / Cash"). */
export function RadioGroup<V extends string | number>({ value, options, onChange, row, name, disabled, className, ...rest }: RadioGroupProps<V>) {
  const auto = useId();
  return (
    <div role="radiogroup" aria-label={rest['aria-label']} className={cx('sx-radiogroup', row && 'sx-row', className)}>
      {options.map((o) => (
        <Radio key={String(o.value)} name={name ?? auto} checked={o.value === value} disabled={disabled || o.disabled} label={o.label} onChange={() => onChange(o.value)} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Select

/** One option of {@link Select}. */
export interface SelectOption {
  value: string | number;
  label: string;
  disabled?: boolean;
}

/** Props of {@link Select}. */
export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'onChange'> {
  value: string | number | null | undefined;
  /** Options (or pass <option> children). */
  options?: SelectOption[];
  /** Called with the option value as a string. */
  onChange?: (value: string) => void;
  width?: number | string;
  inGrid?: boolean;
  invalid?: boolean;
  hideErrorMessage?: boolean;
}

/** Native drop-down select (fixed choices such as "Show Columns", "Sort By"). */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select({ value, options, onChange, width, inGrid, invalid, hideErrorMessage, className, style, children, ...rest }, ref) {
  const err = useControlError(rest.name, inGrid, hideErrorMessage);
  return (
    <>
      <select
        ref={ref}
        {...rest}
        aria-invalid={invalid || !!err.error || undefined}
        aria-describedby={err.describedBy ?? rest['aria-describedby']}
        className={cx('sx-select', inGrid && 'sx-in-grid', (invalid || err.error) && 'sx-invalid', className)}
        style={widthStyle(width, style)}
        value={value ?? ''}
        onChange={(e) => {
          err.clear();
          onChange?.(e.target.value);
        }}
      >
        {options?.map((o) => (
          <option key={String(o.value)} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
        {children}
      </select>
      {err.message}
    </>
  );
});

// ---------------------------------------------------------------------------
// Money / number fields (arithmetic, format on blur)

interface NumericBaseProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'size' | 'type'> {
  value: number | null | undefined;
  /** Called when the field is committed (blur, Enter) and the value changed. */
  onChange?: (value: number | null) => void;
  /** Show an empty field for 0. */
  blankZero?: boolean;
  /** An empty field means null (default true for NumberField, false for MoneyField: empty = 0). */
  nullable?: boolean;
  width?: number | string;
  /** Borderless style for grid cells. */
  inGrid?: boolean;
  /** Text alignment (default right). */
  align?: 'left' | 'right' | 'center';
  invalid?: boolean;
  /** Keep the red border of an inline error but do not show its message under the field. */
  hideErrorMessage?: boolean;
}

function sameNumber(a: number | null | undefined, b: number | null | undefined): boolean {
  return (a ?? null) === (b ?? null);
}

/** Merges the forwarded ref with the component's own input ref. */
function useMergedInputRef(ref: React.ForwardedRef<HTMLInputElement>) {
  const inner = useRef<HTMLInputElement | null>(null);
  const set = (el: HTMLInputElement | null) => {
    inner.current = el;
    if (typeof ref === 'function') ref(el);
    else if (ref) ref.current = el;
  };
  return { inner, set };
}

function useNumericField(
  props: NumericBaseProps,
  format: (v: number | null | undefined) => string,
  parse: (t: string) => number | null,
  defaultNullable: boolean,
  /** Text shown while editing (no dollar sign / suffix). */
  editFormat: (v: number | null | undefined) => string,
) {
  const { value, onChange, nullable = defaultNullable } = props;
  const [text, setText] = useState<string | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  /** The value the edit text was built from, and whether the user typed since. */
  const base = useRef<{ value: number | null | undefined; modified: boolean } | null>(null);
  /** The new edit text after it was replaced by a new value (the field re-selects it). */
  const resynced = useRef<string | null>(null);

  // A new `value` arrives while the field has focus but before the user typed (e.g. a total
  // recomputed after an async recall): show it instead of the stale edit text.
  useLayoutEffect(() => {
    const b = base.current;
    if (text === null || !b || b.modified || sameNumber(b.value, value)) return;
    b.value = value;
    const t = editFormat(value);
    resynced.current = t;
    setText(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const startEdit = () => {
    base.current = { value, modified: false };
    const t = editFormat(value);
    // the edit text differs from the display ("75%" -> "75", "$1.00" -> "1.00"): React rewrites
    // the input after onFocus selected it, so select it again once the new text is rendered
    if (t !== format(value)) resynced.current = t;
    setText(t);
  };
  const edit = (t: string) => {
    if (base.current) base.current.modified = true;
    else base.current = { value: valueRef.current, modified: true };
    setText(t);
  };
  const revert = () => {
    base.current = { value: valueRef.current, modified: false };
    setText(format(valueRef.current));
  };

  const commit = (keepEditing: boolean) => {
    if (text === null) return;
    const t = text.trim();
    let next: number | null;
    if (t === '') next = nullable ? null : 0;
    else {
      next = parse(t);
      if (next === null) {
        // invalid input: revert (the old value comes back)
        base.current = keepEditing ? { value: valueRef.current, modified: false } : null;
        setText(keepEditing ? format(valueRef.current) : null);
        return;
      }
    }
    if (next !== (valueRef.current ?? (nullable ? null : 0))) onChange?.(next);
    valueRef.current = next;
    base.current = keepEditing ? { value: next, modified: false } : null;
    setText(keepEditing ? format(next) : null);
  };
  return { text, setText, startEdit, edit, revert, commit, resynced, display: text ?? format(value) };
}

/** Re-selects the edit text after it was replaced by a new value (see useNumericField). */
function useReselect(resynced: React.MutableRefObject<string | null>, inner: React.MutableRefObject<HTMLInputElement | null>, text: string | null) {
  useLayoutEffect(() => {
    const target = resynced.current;
    if (target === null) return;
    const el = inner.current;
    if (text === null || !el || document.activeElement !== el) {
      resynced.current = null;
      return;
    }
    // wait for the commit that writes the new text into the input
    if (el.value !== target) return;
    resynced.current = null;
    el.select();
  });
}

/** Props of {@link MoneyField}. */
export interface MoneyFieldProps extends NumericBaseProps {
  /** Show a leading dollar sign when not editing. */
  dollarSign?: boolean;
}

/**
 * Money input: right aligned, accepts arithmetic (`100*3+5` → 305.00), formats `1,234.56`
 * when committed (blur or Enter). Empty means 0 unless `nullable`.
 */
export const MoneyField = forwardRef<HTMLInputElement, MoneyFieldProps>(function MoneyField(props, ref) {
  const { value, onChange, blankZero, nullable, width, inGrid, align = 'right', invalid, hideErrorMessage, dollarSign, className, style, onFocus, onBlur, onKeyDown, ...rest } = props;
  const fmt = (v: number | null | undefined) => (v === null || v === undefined ? '' : fmtMoney(v, { blankZero, dollarSign }));
  const editFmt = (v: number | null | undefined) => (v === null || v === undefined ? '' : fmtMoney(v, { blankZero }));
  const f = useNumericField(props, fmt, parseMoney, false, editFmt);
  const err = useControlError(rest.name, inGrid, hideErrorMessage);
  const refs = useMergedInputRef(ref);
  useReselect(f.resynced, refs.inner, f.text);
  return (
    <>
      <input
        ref={refs.set}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        {...rest}
        aria-invalid={invalid || !!err.error || undefined}
        aria-describedby={err.describedBy ?? rest['aria-describedby']}
        className={cx('sx-input', 'sx-money', inGrid && 'sx-in-grid', (invalid || err.error) && 'sx-invalid', `sx-align-${align}`, className)}
        style={widthStyle(width, style)}
        value={f.display}
        onFocus={(e) => {
          f.startEdit();
          e.target.select();
          onFocus?.(e);
        }}
        onChange={(e) => {
          err.clear();
          f.edit(e.target.value);
        }}
        onBlur={(e) => {
          f.commit(false);
          onBlur?.(e);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') f.commit(true);
          else if (e.key === 'Escape' && f.text !== null && f.text !== fmt(value)) {
            f.revert();
            e.stopPropagation();
            e.preventDefault();
          }
          onKeyDown?.(e);
        }}
      />
      {err.message}
    </>
  );
});

/** Props of {@link NumberField}. */
export interface NumberFieldProps extends NumericBaseProps {
  /** Decimals kept (default 5, enough for quantities and rates). */
  decimals?: number;
  /** Text appended when not editing (e.g. "%"). */
  suffix?: string;
}

/** Number input (quantities, rates, percentages): arithmetic allowed, empty = null by default. */
export const NumberField = forwardRef<HTMLInputElement, NumberFieldProps>(function NumberField(props, ref) {
  const { value, onChange, blankZero, nullable, width, inGrid, align = 'right', invalid, hideErrorMessage, decimals = 5, suffix, className, style, onFocus, onBlur, onKeyDown, ...rest } = props;
  const fmt = (v: number | null | undefined) => (v === null || v === undefined ? '' : fmtQty(v, { blankZero }) + (suffix && !(blankZero && v === 0) ? suffix : ''));
  const editFmt = (v: number | null | undefined) => (v === null || v === undefined ? '' : fmtQty(v, { blankZero }));
  const f = useNumericField(props, fmt, (t) => parseNumber(suffix ? t.replace(suffix, '') : t, decimals), true, editFmt);
  const err = useControlError(rest.name, inGrid, hideErrorMessage);
  const refs = useMergedInputRef(ref);
  useReselect(f.resynced, refs.inner, f.text);
  return (
    <>
      <input
        ref={refs.set}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        {...rest}
        aria-invalid={invalid || !!err.error || undefined}
        aria-describedby={err.describedBy ?? rest['aria-describedby']}
        className={cx('sx-input', 'sx-number', inGrid && 'sx-in-grid', (invalid || err.error) && 'sx-invalid', `sx-align-${align}`, className)}
        style={widthStyle(width, style)}
        value={f.display}
        onFocus={(e) => {
          f.startEdit();
          e.target.select();
          onFocus?.(e);
        }}
        onChange={(e) => {
          err.clear();
          f.edit(e.target.value);
        }}
        onBlur={(e) => {
          f.commit(false);
          onBlur?.(e);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') f.commit(true);
          onKeyDown?.(e);
        }}
      />
      {err.message}
    </>
  );
});

// ---------------------------------------------------------------------------
// Address block

/** Builds the multi-line address text of a form ("BILL TO") from a name record's address. */
export function formatAddress(name: string | null | undefined, a?: Partial<Address> | null, extraLines: string[] = []): string {
  const cityLine = [a?.city, [a?.state, a?.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [name, ...extraLines, a?.line1, a?.line2, a?.line3, cityLine, a?.country]
    .map((s) => (s ?? '').trim())
    .filter(Boolean)
    .join('\n');
}

/** Props of {@link AddressBlock}. */
export interface AddressBlockProps {
  /** Address text, lines separated by "\n". */
  value: string | null | undefined;
  onChange?: (value: string) => void;
  /** Visible lines (default 5). */
  rows?: number;
  width?: number | string;
  readOnly?: boolean;
  name?: string;
  id?: string;
  placeholder?: string;
  'aria-label'?: string;
  className?: string;
}

/** Multi-line address box (BILL TO / SHIP TO / ADDRESS). */
export function AddressBlock({ value, onChange, rows = 5, width, readOnly, className, ...rest }: AddressBlockProps) {
  const err = useControlError(rest.name);
  return (
    <>
      <textarea
        {...rest}
        aria-invalid={!!err.error || undefined}
        className={cx('sx-textarea', 'sx-address', err.error && 'sx-invalid', className)}
        rows={rows}
        style={{ width }}
        readOnly={readOnly}
        spellCheck={false}
        value={value ?? ''}
        onChange={(e) => {
          err.clear();
          onChange?.(e.target.value);
        }}
      />
      {err.message}
    </>
  );
}

// Inline validation: errors keyed by field name, shown as a red border and a short message
// under the control with that `name` (TextField, MoneyField, NumberField, DateField, Select,
// TextArea, ComboBox and every picker read them automatically), plus a compact banner that
// lists the problems at the top of a form or dialog.
//
//   // edit dialogs (EditDialog does the provider + banner for you):
//   const fe = useFormErrors();
//   try { await api.post('/names', rec) } catch (e) { fe.fromError(e) }   // ApiError.field → inline
//   if (!rec.name.trim()) fe.setFieldError('name', 'Enter a name.');
//   <FormErrorsProvider value={fe}> ... <TextField name="name" .../> ... </FormErrorsProvider>
//
// Transaction forms get this from useTxnForm()/TxnFormFrame (form.fieldErrors / form.setFieldError).
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, X } from 'lucide-react';
import { ApiError } from '@/api/client';
import './layers';

/** Field name → short message ("Choose a customer."). */
export type FieldErrors = Record<string, string>;

/** What the controls read from {@link FormErrorsProvider}. */
export interface FormErrorsContextValue {
  errors: FieldErrors;
  /** Called by a control when the user changes it, so its error disappears. */
  clear?: (field: string) => void;
}

const Ctx = createContext<FormErrorsContextValue | null>(null);

/** Props of {@link FormErrorsProvider}. Pass either `value` (from useFormErrors) or `errors` (+ `onClear`). */
export interface FormErrorsProviderProps {
  /** State from {@link useFormErrors} (or any object with `errors` and an optional `clear`). */
  value?: { errors: FieldErrors; clear?: (field: string) => void; setFieldError?: (f: string, m: string | null) => void };
  /** Errors by field name (alternative to `value`). */
  errors?: FieldErrors;
  /** Called when the user edits a field that has an error. */
  onClear?: (field: string) => void;
  children: ReactNode;
}

/** Makes field errors available to every kit control below it (matched by the control's `name`). */
export function FormErrorsProvider({ value, errors, onClear, children }: FormErrorsProviderProps) {
  const errs = value?.errors ?? errors ?? EMPTY;
  const clearFn = onClear ?? (value?.setFieldError ? (f: string) => value.setFieldError!(f, null) : undefined);
  const ref = useRef(clearFn);
  ref.current = clearFn;
  const ctx = useMemo<FormErrorsContextValue>(() => ({ errors: errs, clear: (f) => ref.current?.(f) }), [errs]);
  return <Ctx.Provider value={ctx}>{children}</Ctx.Provider>;
}

const EMPTY: FieldErrors = {};

/** The error message of a field (undefined when none, or outside a provider). */
export function useFieldError(name?: string | null): string | undefined {
  const c = useContext(Ctx);
  if (!c || !name) return undefined;
  return c.errors[name];
}

/** Low-level access for custom controls: `{ error, clear() }` of one field. */
export function useFieldErrorState(name?: string | null): { error: string | undefined; clear: () => void } {
  const c = useContext(Ctx);
  const error = c && name ? c.errors[name] : undefined;
  return {
    error,
    clear: () => {
      if (error && name) c?.clear?.(name);
    },
  };
}

// ---------------------------------------------------------------------------
// State hook for dialogs

/** Error state of a dialog or a small form (see {@link useFormErrors}). */
export interface FormErrorsState {
  errors: FieldErrors;
  /** General problem not tied to a field (shown in the banner). */
  message: string | null;
  hasErrors: boolean;
  /** Sets (or clears with null) the error of one field. */
  setFieldError(field: string, message: string | null): void;
  /** Replaces every error (and the general message). */
  setErrors(errors: FieldErrors, message?: string | null): void;
  setMessage(message: string | null): void;
  /** Removes the error of a field (controls call it when edited). */
  clear(field: string): void;
  /** Removes every error and the message. */
  clearAll(): void;
  /**
   * Shows a thrown error: an ApiError with `field` becomes that field's inline error, a
   * "name … already in use" conflict goes under `nameField` (default "name"), any other error is
   * the banner message. Returns false for a cancelled server question (nothing shown).
   */
  fromError(e: unknown, opts?: { nameField?: string }): boolean;
}

/** Field error state for edit dialogs and popovers; pair it with FormErrorsProvider + ErrorBanner. */
export function useFormErrors(initial: FieldErrors = EMPTY): FormErrorsState {
  const [errors, setErrs] = useState<FieldErrors>(initial);
  const [message, setMessage] = useState<string | null>(null);
  const setFieldError = useCallback((field: string, msg: string | null) => {
    setErrs((cur) => {
      if (msg) return cur[field] === msg ? cur : { ...cur, [field]: msg };
      if (!(field in cur)) return cur;
      const n = { ...cur };
      delete n[field];
      return n;
    });
  }, []);
  const clear = useCallback((field: string) => setFieldError(field, null), [setFieldError]);
  const clearAll = useCallback(() => {
    setErrs(EMPTY);
    setMessage(null);
  }, []);
  const setErrors = useCallback((e: FieldErrors, m: string | null = null) => {
    setErrs(e);
    setMessage(m);
  }, []);
  const fromError = useCallback((e: unknown, opts: { nameField?: string } = {}): boolean => {
    const err = e as ApiError;
    if (err && err.code === 'cancelled') return false;
    const msg = (err && err.message) || 'Something went wrong. Please try again.';
    const field = err instanceof ApiError ? err.field || (/already in use/i.test(msg) ? opts.nameField ?? 'name' : undefined) : undefined;
    if (field) {
      setErrs({ [field]: msg });
      setMessage(null);
    } else {
      setErrs(EMPTY);
      setMessage(msg);
    }
    return true;
  }, []);
  return useMemo(
    () => ({ errors, message, hasErrors: !!message || Object.keys(errors).length > 0, setFieldError, setErrors, setMessage, clear, clearAll, fromError }),
    [errors, message, setFieldError, setErrors, clear, clearAll, fromError],
  );
}

// ---------------------------------------------------------------------------
// Focus helpers

function esc(s: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/"/g, '\\"');
}

/** The control element of a field inside root (by name or data-field), or null. */
export function findFieldElement(root: ParentNode | null | undefined, field: string): HTMLElement | null {
  if (!root) return null;
  const el = root.querySelector<HTMLElement>(`[name="${esc(field)}"], [data-field="${esc(field)}"]`);
  if (!el) return null;
  if (el.matches('input, select, textarea, button, [tabindex]')) return el;
  return el.querySelector<HTMLElement>('input:not([type=hidden]), select, textarea, [tabindex]:not([tabindex="-1"])') ?? el;
}

/**
 * Focuses the first field (in screen order) that has an error. Returns the field name, or null
 * when no erroneous field is on screen.
 */
export function focusFirstError(root: HTMLElement | null | undefined, errors: FieldErrors): string | null {
  if (!root) return null;
  const names = Object.keys(errors);
  if (!names.length) return null;
  let best: { el: HTMLElement; name: string } | null = null;
  for (const n of names) {
    const el = findFieldElement(root, n);
    if (!el) continue;
    if (!best || best.el.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING) best = { el, name: n };
  }
  if (!best) return null;
  best.el.focus();
  if (best.el instanceof HTMLInputElement) best.el.select();
  return best.name;
}

// ---------------------------------------------------------------------------
// Visual parts

/** Props of {@link FieldMessage}. */
export interface FieldMessageProps {
  children: ReactNode;
  id?: string;
  /** "error" (default, red) or "help" (gray helper text). */
  tone?: 'error' | 'help';
}

/** Short message under a control (rendered automatically by the kit controls for errors). */
export function FieldMessage({ children, id, tone = 'error' }: FieldMessageProps) {
  return (
    <div id={id} className={'sx-field-msg' + (tone === 'help' ? ' sx-help' : '')} role={tone === 'error' ? 'alert' : undefined}>
      {children}
    </div>
  );
}

/** One problem listed by {@link ErrorBanner}. */
export interface BannerProblem {
  /** Field to focus when the problem is clicked. */
  field?: string;
  message: string;
}

/** Props of {@link ErrorBanner}. */
export interface ErrorBannerProps {
  /** Field errors (listed in the given order). */
  errors?: FieldErrors;
  /** General message (listed first). */
  message?: string | null;
  /** Explicit list instead of errors/message. */
  problems?: BannerProblem[];
  /** Called with the field when a problem is clicked (default: focus it inside `root`). */
  onFieldClick?: (field: string) => void;
  /** Element searched for the field controls (default: the nearest form/dialog around the banner). */
  root?: HTMLElement | null;
  /** Shows a × that calls this. */
  onDismiss?: () => void;
  /** Heading when there are several problems (default "Please fix the following"). */
  title?: string;
  className?: string;
}

/** Compact red banner listing the problems of a form; clicking one focuses its field. */
export function ErrorBanner({ errors, message, problems, onFieldClick, root, onDismiss, title, className }: ErrorBannerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const list: BannerProblem[] = problems ?? [
    ...(message ? [{ message }] : []),
    ...Object.entries(errors ?? {})
      .filter(([, m]) => !!m && m !== message)
      .map(([field, m]) => ({ field, message: m })),
  ];
  // the same message for several fields is listed once
  const seen = new Set<string>();
  const items = list.filter((p) => (seen.has(p.message) ? false : (seen.add(p.message), true)));
  if (!items.length) return null;
  const go = (field?: string) => {
    if (!field) return;
    if (onFieldClick) return onFieldClick(field);
    const r = root ?? (ref.current?.closest('.sx-txnform, .sx-editdlg, .sx-dlg-box, [data-window-id], form') as HTMLElement | null);
    const el = findFieldElement(r, field);
    if (el) {
      el.focus();
      if (el instanceof HTMLInputElement) el.select();
    }
  };
  const single = items.length === 1;
  return (
    <div ref={ref} className={'sx-errbanner' + (className ? ' ' + className : '')} role="alert">
      <AlertCircle size={16} className="sx-errbanner-icon" aria-hidden="true" />
      <div className="sx-errbanner-body">
        {single ? (
          <ProblemText p={items[0]} onClick={go} />
        ) : (
          <>
            <div className="sx-errbanner-title">{title ?? 'Please fix the following'}</div>
            <ul className="sx-errbanner-list">
              {items.map((p, i) => (
                <li key={i}>
                  <ProblemText p={p} onClick={go} />
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      {onDismiss && (
        <button type="button" className="sx-errbanner-close" aria-label="Dismiss" title="Dismiss" onClick={onDismiss}>
          <X size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

function ProblemText({ p, onClick }: { p: BannerProblem; onClick: (f?: string) => void }) {
  if (!p.field) return <span className="sx-errbanner-text">{p.message}</span>;
  return (
    <button type="button" className="sx-errbanner-link" onClick={() => onClick(p.field)}>
      {p.message}
    </button>
  );
}

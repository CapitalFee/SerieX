// Standard layout of record edit dialogs (New/Edit Customer, Vendor, Item, Account, list entries,
// preferences...), so every module dialog looks and behaves the same:
//
//   ┌──────────────────────────────────────────────────────┐
//   │ [error banner]                                         │
//   │ top slot (name, opening balance...)                    │
//   │ ┌ Address info ─┐  section content (scrolls)           │
//   │ │ Payment       │                                       │
//   │ │ Sales tax  •  │  ← a dot marks sections with errors   │
//   │ └───────────────┘                                       │
//   │ footerLeft (Inactive)        Cancel  Save and new   OK  │
//   └──────────────────────────────────────────────────────┘
//
//   const fe = useFormErrors();
//   const save = async () => {
//     if (!rec.name.trim()) { fe.setFieldError('name', 'Enter a customer name.'); return false; }
//     try { const r = await api.post('/names', rec); notifyCreated({kind:'name', id:r.id}); toast('Customer saved'); return true; }
//     catch (e) { fe.fromError(e); return false; }
//   };
//   <EditDialog title="New Customer" errors={fe} sections={[{key:'address', label:'Address info', fields:['billAddress']}, ...]}
//     section={tab} onSectionChange={setTab} top={<NameRow/>} onOk={async () => (await save()) && close()} onSaveNew={...}>
//     {tab === 'address' && <AddressSection/>}
//   </EditDialog>
//
// Enter = OK (not in text areas, buttons or open drop-downs), Escape = Cancel (default: closes the
// window, which runs its "save changes?" hook). Pending field edits are committed before onOk runs.
// When `errors` change, the first field with an error is focused (switching to its section).
//
// Unsaved changes: pass `dirty` (or `values`, compared with the values first shown) and the
// dialog marks its window changed (dot on the tab) and asks "Do you want to save your changes?"
// (Yes / No / Cancel) before it closes by Escape, X, Cancel or Close All: Yes runs OK and closes
// when it succeeded, No discards, Cancel stays.
//
//   <EditDialog ... values={loaded ? rec : undefined} valuesKey={rec.id} onOk={...} />
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { msgBox } from './dialogs';
import type { LucideIcon } from 'lucide-react';
import { useOptionalWindow } from '@/windows/WindowContext';
import { Button, renderIcon } from './buttons';
import { commitActiveEditor, tabbables } from './focus';
import { ErrorBanner, FormErrorsProvider, focusFirstError, type FormErrorsState } from './formErrors';
import { isPopupOpen } from './layers';

/** One section (left tab) of {@link EditDialog}. */
export interface EditDialogSection {
  key: string;
  label: ReactNode;
  icon?: LucideIcon | ReactNode;
  /** Field names shown in this section: an error in one of them marks the tab and opens it. */
  fields?: string[];
  hidden?: boolean;
  disabled?: boolean;
}

/** Props of {@link EditDialog}. */
export interface EditDialogProps {
  /** Window title (set with useWindow().setTitle); shown as the heading when used outside a window. */
  title?: string;
  /** Heading inside the dialog (optional; the window title bar already shows `title`). */
  heading?: ReactNode;
  /** Fields above the sections (e.g. Customer name, Opening balance). */
  top?: ReactNode;
  /** Left section tabs; omit for a single-page dialog. */
  sections?: EditDialogSection[];
  /** Active section key (controlled). */
  section?: string;
  onSectionChange?: (key: string) => void;
  /** Content of the active section (or the whole dialog). */
  children?: ReactNode;
  /** Error state from useFormErrors(): inline errors for every control + the banner. */
  errors?: FormErrorsState;
  /** OK / Save and close. Return false (or throw) to keep the dialog open; closing is up to you. */
  onOk: () => unknown | Promise<unknown>;
  /** Cancel / Escape (default: closes the window). */
  onCancel?: () => void;
  /** Shows "Save and new" (Alt+N). */
  onSaveNew?: () => unknown | Promise<unknown>;
  /** Default "OK". Use "Save and close" for record dialogs if you prefer. */
  okLabel?: string;
  cancelLabel?: string;
  saveNewLabel?: string;
  /** Disables the buttons and shows a spinner on OK. */
  busy?: boolean;
  okDisabled?: boolean;
  /** Content at the left of the button row (e.g. "Customer is inactive" checkbox). */
  footerLeft?: ReactNode;
  /** Extra buttons before Cancel (e.g. "Delete"). */
  extraButtons?: ReactNode;
  /** Enter runs OK (default true). */
  enterSubmits?: boolean;
  /** Width of the section column (default 170). */
  navWidth?: number;
  /**
   * When the dialog opens and nothing inside it has focus yet, focus its first field (default
   * true), so typing, Enter = OK and Escape = Cancel work at once. Pass false to opt out (or
   * give a control `autoFocus`, which wins).
   */
  autoFocusFirst?: boolean;
  /**
   * The user changed something that is not saved yet: the window shows it (tab dot) and closing
   * asks "Do you want to save your changes?" (Yes = OK, No = discard, Cancel = stay).
   * Alternative to `values`.
   */
  dirty?: boolean;
  /**
   * The edited values (e.g. the record): the dialog is "changed" while they differ from the
   * values first given (pass undefined while loading). A new snapshot is taken when `valuesKey`
   * changes and after a successful Save and new.
   */
  values?: unknown;
  /** Identity of the edited values (e.g. the record id): a change takes a new snapshot of `values`. */
  valuesKey?: unknown;
  className?: string;
  style?: CSSProperties;
}

/** JSON with sorted keys (comparing edited values). */
function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x,
  );
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Consistent record edit dialog layout with sections, inline errors and OK/Cancel/Save and new. */
export function EditDialog(props: EditDialogProps) {
  const {
    title,
    heading,
    top,
    sections,
    section,
    onSectionChange,
    children,
    errors,
    okLabel = 'OK',
    cancelLabel = 'Cancel',
    saveNewLabel = 'Save and new',
    busy,
    okDisabled,
    footerLeft,
    extraButtons,
    enterSubmits = true,
    navWidth = 170,
    className,
    style,
  } = props;
  const win = useOptionalWindow();
  const rootRef = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const [running, setRunning] = useState<false | 'ok' | 'new'>(false);
  /** Re-render after an OK attempt (a synchronous onOk batches running true/false into no change). */
  const [, setRunCount] = useState(0);
  const wantFocus = useRef(false);

  // ---- unsaved changes (dirty / values)
  const tracking = props.dirty !== undefined || props.values !== undefined;
  const snap = useRef<{ key: unknown; json: string } | null>(null);
  const resnap = useRef(false);
  let isDirty = !!props.dirty;
  if (props.dirty === undefined && props.values !== undefined && props.values !== null) {
    const json = stableJson(props.values);
    if (!snap.current || snap.current.key !== props.valuesKey || resnap.current) {
      snap.current = { key: props.valuesKey, json };
      resnap.current = false;
    }
    isDirty = json !== snap.current.json;
  }
  const dirtyRef = useRef(isDirty);
  dirtyRef.current = isDirty;
  useEffect(() => {
    if (win && tracking) win.setDirty(isDirty);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDirty, tracking, win?.id]);

  // focus the first field when the dialog opens (unless a control focused itself)
  useEffect(() => {
    if (props.autoFocusFirst === false) return;
    const t = setTimeout(() => {
      const root = rootRef.current;
      if (!root || !root.isConnected) return;
      const ae = document.activeElement as HTMLElement | null;
      // only take focus from nothing / the window frame around the dialog (never from a message box)
      if (ae && ae !== document.body && !ae.contains(root)) return;
      const first = tabbables(root).find((el) => el.matches('input, select, textarea') && !el.closest('.sx-editdlg-nav') && !(el as HTMLInputElement).readOnly);
      if (first) {
        first.focus({ preventScroll: true });
        if (first instanceof HTMLInputElement && first.type === 'text') first.select();
      } else root.focus({ preventScroll: true });
    }, 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (title && win) win.setTitle(title);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, win?.id]);

  // Focus the first invalid field (switching sections when it is on another one) when errors
  // are added or changed, or after an OK / Save and new attempt that left errors - never when
  // an error is only removed because the user is fixing a field (focus stays where they type).
  const prevErrs = useRef<Record<string, string>>({});
  const afterRun = useRef(false);
  useEffect(() => {
    const cur = errors?.errors ?? {};
    const prev = prevErrs.current;
    prevErrs.current = cur;
    if (Object.keys(cur).some((k) => prev[k] !== cur[k])) wantFocus.current = true;
  }, [errors?.errors]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (afterRun.current && !running) {
      afterRun.current = false;
      if (errors && Object.keys(errors.errors).length) wantFocus.current = true;
    }
    if (!wantFocus.current || !errors) return;
    const errs = errors.errors;
    if (focusFirstError(rootRef.current, errs)) {
      wantFocus.current = false;
      return;
    }
    const target = sections?.find((s) => !s.hidden && s.fields?.some((f) => f in errs));
    if (target && target.key !== section && onSectionChange) onSectionChange(target.key);
    else wantFocus.current = false;
  });

  /** Runs OK / Save and new; resolves true when it succeeded (no false result, no error, no inline errors). */
  const run = async (which: 'ok' | 'new'): Promise<boolean> => {
    if (running || busy) return false;
    await commitActiveEditor(rootRef.current);
    await tick();
    // a field still holds text it could not accept (e.g. a date like 2/30): fix it first
    const badEntry = rootRef.current?.querySelector<HTMLInputElement>('[data-invalid-entry]');
    if (badEntry) {
      badEntry.focus();
      badEntry.select?.();
      return false;
    }
    const fn = which === 'ok' ? latest.current.onOk : latest.current.onSaveNew;
    if (!fn) return false;
    setRunning(which);
    let ok = true;
    try {
      if ((await fn()) === false) ok = false;
    } catch {
      /* the caller shows its own errors (errors.fromError) */
      ok = false;
    } finally {
      afterRun.current = true;
      if (rootRef.current?.isConnected) {
        setRunning(false);
        setRunCount((n) => n + 1);
      }
    }
    await tick();
    const e = latest.current.errors;
    if (e && (e.message || Object.keys(e.errors).length)) ok = false;
    // saved: what is shown now is the saved state (Save and new shows a fresh record)
    if (ok) resnap.current = true;
    return ok;
  };

  // "Do you want to save your changes?" before the window closes (Escape, X, Cancel, Close All)
  useEffect(() => {
    if (!win || !tracking) return;
    win.setBeforeClose(async () => {
      // a field still being typed in (amount, date, picker) commits on blur: count it as a change
      const root = rootRef.current;
      const ae = document.activeElement as HTMLElement | null;
      const editing = root && ae && ae !== root && root.contains(ae) ? ae : null;
      if (editing) {
        await commitActiveEditor(root);
        await tick();
      }
      if (!dirtyRef.current) return true;
      const r = await msgBox({
        title: 'Save Changes',
        message: 'You have changed this record. Do you want to save your changes?',
        buttons: ['Yes', 'No', 'Cancel'],
        icon: 'question',
      });
      if (r === 'No') return true;
      if (r !== 'Yes') {
        if (editing && editing.isConnected) editing.focus();
        return false;
      }
      return run('ok');
    });
    return () => win.setBeforeClose(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [win?.id, tracking]);
  const cancel = () => {
    const c = latest.current.onCancel;
    if (c) c();
    else void win?.close();
  };

  const visibleSections = sections?.filter((s) => !s.hidden) ?? [];
  const errKeys = errors ? Object.keys(errors.errors) : [];
  const disabled = !!busy || !!running;

  const body = (
    <div
      ref={rootRef}
      className={'sx-editdlg' + (visibleSections.length ? ' sx-has-nav' : '') + (className ? ' ' + className : '')}
      style={style}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.defaultPrevented || e.nativeEvent.isComposing) return;
        const t = e.target as HTMLElement;
        if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.metaKey) {
          if (isPopupOpen()) return;
          e.preventDefault();
          cancel();
          return;
        }
        if (e.key !== 'Enter' || !enterSubmits || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
        if (t.tagName === 'TEXTAREA' || t.tagName === 'BUTTON' || t.tagName === 'A' || t.tagName === 'SELECT') return;
        if (t.getAttribute('aria-expanded') === 'true' || isPopupOpen()) return;
        if (t.closest('.sx-grid')) return;
        e.preventDefault();
        void run('ok');
      }}
    >
      {!win && (title || heading) ? <div className="sx-editdlg-heading">{heading ?? title}</div> : heading ? <div className="sx-editdlg-heading">{heading}</div> : null}
      {errors && (errors.message || errKeys.length > 0) && (
        <div className="sx-editdlg-banner">
          <ErrorBanner errors={errors.errors} message={errors.message} root={rootRef.current} onDismiss={() => errors.setMessage(null)} />
        </div>
      )}
      {top && <div className="sx-editdlg-top">{top}</div>}
      <div className="sx-editdlg-main">
        {visibleSections.length > 0 && (
          <nav className="sx-editdlg-nav" style={{ width: navWidth }} role="tablist" aria-orientation="vertical">
            {visibleSections.map((s) => {
              const on = s.key === section;
              const bad = !!s.fields?.some((f) => errKeys.includes(f));
              return (
                <button
                  key={s.key}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  disabled={s.disabled}
                  className={'sx-editdlg-tab' + (on ? ' sx-active' : '') + (bad ? ' sx-has-error' : '')}
                  onClick={() => onSectionChange?.(s.key)}
                  onKeyDown={(e) => {
                    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
                    e.preventDefault();
                    const list = visibleSections.filter((x) => !x.disabled);
                    const i = list.findIndex((x) => x.key === s.key);
                    const n = list[(i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length];
                    if (n) {
                      onSectionChange?.(n.key);
                      requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>('.sx-editdlg-tab.sx-active')?.focus());
                    }
                  }}
                >
                  {s.icon && <span className="sx-editdlg-tab-icon">{renderIcon(s.icon, 15)}</span>}
                  <span className="sx-editdlg-tab-label">{s.label}</span>
                  {bad && <span className="sx-editdlg-tab-dot" aria-label="has errors" />}
                </button>
              );
            })}
          </nav>
        )}
        <div className="sx-editdlg-content" role={visibleSections.length ? 'tabpanel' : undefined}>
          {children}
        </div>
      </div>
      <div className="sx-editdlg-foot">
        <div className="sx-editdlg-footleft">{footerLeft}</div>
        {extraButtons}
        <Button variant="secondary" label={cancelLabel} onClick={cancel} disabled={!!running} title={`${cancelLabel} (Esc)`} />
        {props.onSaveNew && <Button variant="secondary" label={saveNewLabel} accessKey="n" onClick={() => void run('new')} disabled={disabled || okDisabled} busy={running === 'new'} />}
        <Button variant="primary" label={okLabel} onClick={() => void run('ok')} disabled={disabled || okDisabled} busy={running === 'ok'} title={`${okLabel} (Enter)`} />
      </div>
    </div>
  );
  return errors ? <FormErrorsProvider value={errors}>{body}</FormErrorsProvider> : body;
}

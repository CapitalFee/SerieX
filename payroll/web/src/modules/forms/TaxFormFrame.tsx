// Payroll Tax Form window shared by Form 941, Form 940 and the state quarterly wage report: a
// paper-like rendering of the form (header box, lines grouped by Part, editable cells for the
// values the user may change, overridden amounts marked with a "use calculated" button), Check
// for Errors, Save as Draft, Mark as Filed (keeps a copy of the form as filed), View filed copy,
// Print (printHtml) and the schedules (941 Schedule B for semiweekly depositors, 940 Schedule A).
// Totals follow the user's edits at once (engine.ts recomputes them like the server).
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, FileCheck2, FileClock, Printer, RefreshCw, RotateCcw, ShieldCheck, X } from 'lucide-react';
import { api, qs } from '@/api/client';
import { invalidateAll, queryClient } from '@/api/hooks';
import type { FormLine, TaxForm } from '@/api/types';
import {
  Button,
  Checkbox,
  MoneyField,
  NumberField,
  Spinner,
  StatusPill,
  TextField,
  ToolSeparator,
  ToolbarButton,
  ToolbarSpacer,
  alertBox,
  commitActiveEditor,
  confirmBox,
  msgBox,
  showDialog,
  toast,
  useHotkeys,
  EmptyState,
} from '@/components';
import { useWindow } from '@/windows/WindowContext';
import { todayIso } from '@/util/dates';
import { escHtml, printHtml } from '@/util/print';
import { fmtDate, fmtMoney, fmtPercent, fmtQty } from '@/util/format';
import { checkForm, effectiveValues, lineKey, sameValues, savedValues, type Effective, type FormProblem, type FormValues } from './engine';
import { stampDate } from './period';
import './forms.css';

export type TaxFormKind = '941' | '940' | 'STATE-UI';

export interface TaxFormFrameProps {
  kind: TaxFormKind;
  year: number;
  quarter?: number;
  state?: string;
  /** Period / state selectors shown at the left of the toolbar. */
  periodControls?: ReactNode;
  /** Extra content after the paper form (employee wage list of the state report...). */
  after?: (form: TaxForm) => ReactNode;
  /** Notes shown above the paper form (actions the form needs, e.g. the 940 credit reduction adjustment). */
  notes?: (form: TaxForm) => ReactNode;
  /** Server warnings a note above replaces (not listed twice). */
  hideWarning?: (form: TaxForm, warning: string) => boolean;
  /** Extra toolbar buttons (CSV export...). */
  extraTools?: (form: TaxForm | undefined) => ReactNode;
  /** Extra printed pages appended to the printed form. */
  printExtra?: (form: TaxForm) => string;
}

/** API path and query of a form. */
export function formUrl(kind: TaxFormKind, year: number, quarter?: number, state?: string): string {
  if (kind === '941') return '/forms/941' + qs({ year, quarter });
  if (kind === '940') return '/forms/940' + qs({ year });
  return '/forms/state-ui' + qs({ year, quarter, state });
}

const PART_TITLES: Record<TaxFormKind, Record<string, string>> = {
  '941': {
    'Part 1': 'Answer these questions for this quarter.',
    'Part 2': 'Tell us about your deposit schedule and tax liability for this quarter.',
    'Part 3': 'Tell us about your business. If a question does NOT apply to your business, leave it blank.',
    'Part 4': 'May we speak with your third-party designee?',
    'Part 5': 'Sign here. You MUST complete all three pages of Form 941 and SIGN it.',
  },
  '940': {
    'Part 1': 'Tell us about your return. If any line does NOT apply, leave it blank.',
    'Part 2': 'Determine your FUTA tax before adjustments. If any line does NOT apply, leave it blank.',
    'Part 3': 'Determine your adjustments. If any line does NOT apply, leave it blank.',
    'Part 4': 'Determine your FUTA tax and balance due or overpayment. If any line does NOT apply, leave it blank.',
    'Part 5': 'Report your FUTA tax liability by quarter only if line 12 is more than $500. If not, go to Part 6.',
    'Part 6': 'May we speak with your third-party designee?',
    'Part 7': 'Sign here. You MUST complete both pages of this form and SIGN it.',
  },
  'STATE-UI': {
    Report: 'Employees and wages',
    'Unemployment Insurance': 'Unemployment insurance',
    'Other State Taxes': 'Other state payroll taxes',
    Totals: 'Totals, payments and signature',
  },
};

/** Groups of text fields drawn as a small field grid (designee, signature, paid preparer). */
const FIELD_GROUPS = new Set(['designee', 'sign', 'preparer']);

const QUARTER_TEXT = ['January, February, March', 'April, May, June', 'July, August, September', 'October, November, December'];

/** Line number shown in the left column. */
function lineNo(kind: TaxFormKind, l: FormLine): string {
  if (FIELD_GROUPS.has(l.key) || l.key === 'agg' || l.key === 'type') return '';
  if (kind === 'STATE-UI') return /^[A-J1]$/.test(l.key) && (l.col === '' || l.col === 'm1') ? l.key : '';
  if (l.col && !['1', 'm1'].includes(l.col) && l.key !== '15b' && l.key !== '16') return '';
  if (l.key === '16' && l.col !== '1') return '';
  if (l.key === '15b' && l.col !== '1') return '';
  return l.key;
}

/** Display of a value cell when it is not edited (and in print). */
function showValue(l: FormLine, e: Effective): string {
  const k = lineKey(l);
  switch (l.kind) {
    case 'money':
      return fmtMoney(e.num.get(k) ?? 0);
    case 'count':
      return fmtQty(e.num.get(k) ?? 0);
    case 'number':
      return fmtPercent(e.num.get(k) ?? 0);
    case 'check':
      return e.chk.get(k) ? '☒' : '☐';
    default:
      return e.txt.get(k) ?? '';
  }
}

/** Label without the line number it repeats ("4a Fringe benefits" on line 4a). */
function bareLabel(l: FormLine): string {
  return l.label.startsWith(l.key + ' ') ? l.label.slice(l.key.length + 1) : l.label;
}

interface Row {
  lines: FormLine[];
  kind: 'single' | 'pair' | 'fields';
}

/** Rows of a section: column 1/2 pairs on one row, field groups as one block. */
function rowsOf(lines: FormLine[]): Row[] {
  const out: Row[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const n = lines[i + 1];
    if (FIELD_GROUPS.has(l.key)) {
      const last = out[out.length - 1];
      if (last && last.kind === 'fields' && last.lines[0].key === l.key) last.lines.push(l);
      else out.push({ lines: [l], kind: 'fields' });
      continue;
    }
    if (l.col === '1' && n && n.key === l.key && n.col === '2' && l.kind === 'money') {
      out.push({ lines: [l, n], kind: 'pair' });
      i++;
      continue;
    }
    out.push({ lines: [l], kind: 'single' });
  }
  return out;
}

export function TaxFormFrame(props: TaxFormFrameProps) {
  const { kind, year, quarter, state } = props;
  const win = useWindow();
  const url = formUrl(kind, year, quarter, state);
  const q = useQuery({
    queryKey: ['tax-form', kind, year, quarter ?? null, state ?? null],
    queryFn: ({ signal }) => api.get<TaxForm>(url, { signal }),
    enabled: kind !== 'STATE-UI' || !!state,
    staleTime: 0,
  });
  const form = q.data;
  const [values, setValues] = useState<FormValues>({ overrides: {}, texts: {}, checks: {} });
  const [base, setBase] = useState<FormValues>({ overrides: {}, texts: {}, checks: {} });
  const [problems, setProblems] = useState<FormProblem[] | null>(null);
  const [busy, setBusy] = useState<false | 'draft' | 'filed'>(false);
  const [flash, setFlash] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const loadedFor = useRef<TaxForm | null>(null);

  // the user's values start from the saved ones (again after every load)
  useEffect(() => {
    if (!form || loadedFor.current === form) return;
    loadedFor.current = form;
    const v = savedValues(form);
    setValues(v);
    setBase(v);
    setProblems(null);
  }, [form]);

  const dirty = !!form && !sameValues(values, base);
  const eff = useMemo(() => (form ? effectiveValues(form, values, dirty) : null), [form, values, dirty]);
  useEffect(() => {
    win.setDirty(dirty);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty]);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const formName = kind === '941' ? `Form 941 for Q${quarter} ${year}` : kind === '940' ? `Form 940 for ${year}` : form?.title ?? `${state} wage report Q${quarter} ${year}`;

  // ---- editing
  /** Effective value of a line when its override is removed (the calculated value). */
  const calculated = (l: FormLine): number | boolean | string => {
    if (!form) return 0;
    const k = lineKey(l);
    const v: FormValues = { overrides: { ...values.overrides }, texts: { ...values.texts }, checks: { ...values.checks } };
    delete v.overrides[k];
    delete v.checks[k];
    const e = effectiveValues(form, v, true);
    return l.kind === 'check' ? !!e.chk.get(k) : (e.num.get(k) ?? 0);
  };
  const setNum = (l: FormLine, val: number | null) => {
    const k = lineKey(l);
    const calc = calculated(l) as number;
    setValues((v) => {
      const o = { ...v.overrides };
      if (val === null || Math.abs(val - calc) < 0.0000001) delete o[k];
      else o[k] = val;
      return { ...v, overrides: o };
    });
  };
  const setChk = (l: FormLine, val: boolean) => {
    const k = lineKey(l);
    const calc = calculated(l) as boolean;
    setValues((v) => {
      const c = { ...v.checks };
      if (val === calc) delete c[k];
      else c[k] = val;
      return { ...v, checks: c };
    });
  };
  const setTxt = (l: FormLine, val: string) => {
    const k = lineKey(l);
    setValues((v) => {
      const t = { ...v.texts };
      if (val === '' && !(k in base.texts)) delete t[k];
      else t[k] = val;
      return { ...v, texts: t };
    });
  };
  const reset = (l: FormLine) => {
    const k = lineKey(l);
    setValues((v) => {
      const o = { ...v.overrides };
      const c = { ...v.checks };
      delete o[k];
      delete c[k];
      return { ...v, overrides: o, checks: c };
    });
  };
  const isOverridden = (l: FormLine) => {
    const k = lineKey(l);
    return l.kind === 'check' ? k in values.checks : l.kind === 'text' ? false : k in values.overrides;
  };

  // ---- saving
  const save = async (status: 'draft' | 'filed'): Promise<boolean> => {
    if (!form) return false;
    await commitActiveEditor(bodyRef.current);
    setBusy(status);
    try {
      const saved = await api.put<TaxForm>(url, { overrides: values.overrides, texts: values.texts, checks: values.checks, status });
      queryClient.setQueryData(['tax-form', kind, year, quarter ?? null, state ?? null], saved);
      await queryClient.invalidateQueries({ queryKey: ['filings'] });
      toast(status === 'filed' ? `${formName} marked as filed` : `${formName} saved as a draft`);
      return true;
    } catch (e) {
      if (!(e instanceof Error && 'code' in e && (e as { code: string }).code === 'cancelled')) await alertBox(e instanceof Error ? e.message : String(e), 'Save Form', 'error');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const runCheck = (): FormProblem[] => {
    if (!form || !eff) return [];
    const p = checkForm(form, eff);
    setProblems(p);
    bodyRef.current?.scrollTo({ top: 0 });
    return p;
  };

  const markFiled = async () => {
    if (!form || !eff) return;
    await commitActiveEditor(bodyRef.current);
    const p = runCheck();
    const errors = p.filter((x) => x.severity === 'error');
    if (errors.length) {
      const r = await msgBox({
        title: 'Check for Errors',
        message: `${formName} has ${errors.length} error${errors.length === 1 ? '' : 's'} (listed above the form). Fix ${errors.length === 1 ? 'it' : 'them'} before you file the form.`,
        buttons: ['&Show errors', 'Mark as filed &anyway'],
        icon: 'warning',
        cancelButton: 'Show errors',
      });
      if (r !== 'Mark as filed anyway') return;
    }
    if (!(await confirmBox(`Mark ${formName} as filed on ${fmtDate(todayIso())}?\n\nSerieX Payroll keeps a copy of the form as filed. If payroll data changes later, the form tells you to file a correction.`, 'Mark as Filed'))) return;
    await save('filed');
  };

  const askSave = async (): Promise<boolean> => {
    if (!dirtyRef.current) return true;
    const r = await msgBox({
      title: 'Unsaved Changes',
      message: `${formName} has changes that are not saved. Save them as a draft before you leave?`,
      buttons: ['&Save', "&Don't Save", 'Cancel'],
      icon: 'question',
    });
    if (r === 'Save') return save('draft');
    return r === "Don't Save";
  };
  const askRef = useRef(askSave);
  askRef.current = askSave;
  useEffect(() => {
    win.setBeforeClose(() => askRef.current());
    return () => win.setBeforeClose(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const goLine = (line: string) => {
    const root = bodyRef.current;
    if (!root) return;
    const el = line ? root.querySelector<HTMLElement>(`[data-line="${CSS.escape(line)}"]`) ?? root.querySelector<HTMLElement>(`[data-line^="${CSS.escape(line.split(':')[0])}"]`) : root.querySelector<HTMLElement>('.fx-head');
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    setFlash(el.dataset.line ?? null);
    setTimeout(() => setFlash(null), 1600);
    el.querySelector<HTMLElement>('input')?.focus();
  };

  const print = async (f: TaxForm = form!, e: Effective | null = eff) => {
    if (!f || !e) return;
    await printHtml(f.title, printForm(kind, f, e) + (props.printExtra?.(f) ?? ''), PRINT_CSS);
  };

  const viewFiled = async () => {
    try {
      const snap = await api.get<TaxForm>(url + '&snapshot=1');
      const e = effectiveValues(snap, savedValues(snap), false);
      await showDialog<void>({
        title: `${formName} - copy as filed on ${stampDate(snap.filedAt)}`,
        width: 900,
        cancelValue: undefined,
        render: (close) => (
          <div className="fx-dlg">
            <div className="fx-dlg-paper">
              <Paper kind={kind} form={snap} eff={e} readOnly winId={`${win.id}-snap`} />
            </div>
            <div className="sx-dlg-buttons">
              <Button variant="primary" label="Close" onClick={() => close()} />
              <Button icon={Printer} label="Print" onClick={() => void print(snap, e)} />
            </div>
          </div>
        ),
      });
    } catch (err) {
      await alertBox(err instanceof Error ? err.message : String(err), 'View filed copy', 'error');
    }
  };

  useHotkeys(
    {
      'ctrl+p': () => {
        if (!form) return false;
        void print();
      },
    },
    [form, eff],
  );

  if (kind === 'STATE-UI' && !state)
    return (
      <div className="fx-window">
        <div className="sx-txnbar" role="toolbar">
          {props.periodControls}
        </div>
        <EmptyState title="Choose the state" message="Choose the state of the unemployment wage report in the toolbar." />
      </div>
    );

  const statusText = !form ? '' : form.status === 'filed' ? 'Filed' : form.status === 'draft' ? 'Draft' : 'New';
  const errorsCount = problems?.filter((p) => p.severity === 'error').length ?? 0;
  const shownWarnings = form ? form.warnings.filter((w) => !props.hideWarning?.(form, w)) : [];

  return (
    <div className="fx-window">
      <div className="sx-txnbar fx-toolbar" role="toolbar" aria-label="Tax form">
        {props.periodControls}
        <ToolSeparator />
        <ToolbarButton label="Check for Errors" icon={ShieldCheck} disabled={!form} onClick={() => runCheck()} />
        <ToolbarButton label="Print" icon={Printer} shortcut="Ctrl+P" disabled={!form} onClick={() => void print()} />
        {props.extraTools?.(form)}
        {form?.status === 'filed' && <ToolbarButton label="View filed copy" icon={FileClock} onClick={() => void viewFiled()} />}
        <ToolbarButton label="Refresh" icon={RefreshCw} title="Read the form again (payroll data may have changed)" disabled={dirty || q.isFetching} onClick={() => void q.refetch()} />
        <ToolbarSpacer />
        {dirty && !busy && <span className="sx-txnbar-note">Unsaved changes</span>}
        {form && <StatusPill status={statusText} tone={form.status === 'filed' ? 'success' : form.status === 'draft' ? 'warning' : 'info'} detail={form.status === 'filed' && form.filedAt ? stampDate(form.filedAt) : undefined} />}
      </div>
      <div className="fx-body" ref={bodyRef}>
        {q.isLoading ? (
          <Spinner center label="Preparing the form..." />
        ) : q.isError || !form || !eff ? (
          <EmptyState icon={AlertTriangle} title="Could not prepare the form" message={q.error instanceof Error ? q.error.message : 'The form could not be read.'} action={{ label: 'Try again', onClick: () => void q.refetch() }} />
        ) : (
          <>
            {problems && (
              <div className={'fx-problems' + (errorsCount ? ' fx-has-errors' : problems.length ? ' fx-has-warnings' : '')} role="region" aria-label="Errors">
                <div className="fx-problems-head">
                  {problems.length ? <AlertTriangle size={16} aria-hidden="true" /> : <CheckCircle2 size={16} aria-hidden="true" />}
                  <span>
                    {problems.length
                      ? `${errorsCount} error${errorsCount === 1 ? '' : 's'} and ${problems.length - errorsCount} warning${problems.length - errorsCount === 1 ? '' : 's'} found`
                      : 'No errors found. The form is ready to be filed.'}
                  </span>
                  <span className="fx-spacer" />
                  <button type="button" className="fx-iconbtn" aria-label="Close the error list" onClick={() => setProblems(null)}>
                    <X size={14} />
                  </button>
                </div>
                {problems.length > 0 && (
                  <ul className="fx-problems-list">
                    {problems.map((p, i) => (
                      <li key={i} className={p.severity === 'error' ? 'fx-err' : 'fx-warn'}>
                        <span className="fx-sev">{p.severity === 'error' ? 'Error' : 'Warning'}</span>
                        <span>{p.message}</span>
                        {p.line && (
                          <button type="button" className="sx-linkbtn" onClick={() => goLine(p.line)}>
                            Go to line {p.line.split(':')[0]}
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {form.status === 'filed' && (
              <div className="fx-note fx-ok">
                <FileCheck2 size={15} aria-hidden="true" />
                <span>
                  Filed on {stampDate(form.filedAt)}. Saving it again replaces the filed copy; file an amended return with the tax agency if the filed form was wrong.
                </span>
              </div>
            )}
            {!problems && shownWarnings.length > 0 && (
              <div className="fx-note fx-warn">
                <AlertTriangle size={15} aria-hidden="true" />
                <ul>
                  {shownWarnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            )}
            {props.notes?.(form)}
            <Paper
              kind={kind}
              form={form}
              eff={eff}
              winId={win.id}
              flash={flash}
              isOverridden={isOverridden}
              calculated={calculated}
              onNum={setNum}
              onChk={setChk}
              onTxt={setTxt}
              onReset={reset}
            />
            {props.after?.(form)}
          </>
        )}
      </div>
      <div className="fx-bottom">
        <span className="fx-muted">
          {form ? (
            <>
              {form.dueDate && <>Due {fmtDate(form.dueDate)} · </>}
              {form.status === 'filed' ? `Filed ${stampDate(form.filedAt)}` : form.status === 'draft' ? 'Saved as a draft' : 'Not saved yet'}
              {' · '}Values you change are kept for this form only; they do not change payroll items or paychecks.
            </>
          ) : null}
        </span>
        <span className="fx-spacer" />
        {dirty && <Button variant="ghost" icon={RotateCcw} label="&Revert" onClick={() => setValues(base)} disabled={!!busy} />}
        <Button label="Save as &Draft" busy={busy === 'draft'} disabled={!form || !!busy} onClick={() => void save('draft')} />
        <Button variant="primary" label="Mark as &Filed" busy={busy === 'filed'} disabled={!form || !!busy} onClick={() => void markFiled()} />
        <Button label="Close" onClick={() => void win.close()} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The paper

interface PaperProps {
  kind: TaxFormKind;
  form: TaxForm;
  eff: Effective;
  winId: string;
  readOnly?: boolean;
  flash?: string | null;
  isOverridden?: (l: FormLine) => boolean;
  calculated?: (l: FormLine) => number | boolean | string;
  onNum?: (l: FormLine, v: number | null) => void;
  onChk?: (l: FormLine, v: boolean) => void;
  onTxt?: (l: FormLine, v: string) => void;
  onReset?: (l: FormLine) => void;
}

function Paper(p: PaperProps) {
  const { kind, form, eff } = p;
  const sections: { name: string; lines: FormLine[] }[] = [];
  for (const l of form.lines) {
    const s = sections.find((x) => x.name === l.section);
    if (s) s.lines.push(l);
    else sections.push({ name: l.section, lines: [l] });
  }
  const header = sections.find((s) => s.name === 'Header');
  return (
    <div className="fx-paper" role="document" aria-label={form.title}>
      <PaperHead kind={kind} form={form} eff={eff} headerLines={header?.lines ?? []} cell={(l) => <Cell {...p} l={l} />} />
      {sections
        .filter((s) => s.name !== 'Header')
        .map((s) => (
          <section key={s.name} className="fx-part">
            <div className="fx-part-head">
              <span className="fx-part-no">{s.name}:</span>
              <span>{PART_TITLES[kind][s.name] ?? ''}</span>
            </div>
            {rowsOf(s.lines).map((r, i) => (
              <RowView key={i} {...p} row={r} />
            ))}
          </section>
        ))}
    </div>
  );
}

function PaperHead({ kind, form, eff, headerLines, cell }: { kind: TaxFormKind; form: TaxForm; eff: Effective; headerLines: FormLine[]; cell: (l: FormLine) => ReactNode }) {
  const co = form.company;
  const qn = form.period.startsWith('Q') ? +form.period.slice(1) : 0;
  const addr = [co.address.line1, co.address.line2].filter(Boolean).join(', ');
  const city = [co.address.city, [co.address.state, co.address.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return (
    <div className="fx-head" data-line="">
      <div className="fx-head-title">
        {kind === 'STATE-UI' ? (
          <>
            <b>{form.title}</b>
            <span>{String(form.extra?.quarterlyReport ?? '')}</span>
          </>
        ) : (
          <>
            <b>Form {kind} for {form.year}:</b>
            <span>{kind === '941' ? "Employer's QUARTERLY Federal Tax Return" : "Employer's Annual Federal Unemployment (FUTA) Tax Return"}</span>
            <span className="fx-agency">Department of the Treasury — Internal Revenue Service</span>
          </>
        )}
      </div>
      <div className="fx-head-grid">
        <div className="fx-idbox">
          {kind === 'STATE-UI' ? (
            <div className="fx-idrow">
              <label>Employer account number</label>
              <span className="fx-idval">{co.stateId || <i className="fx-missing">not entered</i>}</span>
            </div>
          ) : (
            <div className="fx-idrow">
              <label>Employer identification number (EIN)</label>
              <span className="fx-idval fx-ein">{co.ein || <i className="fx-missing">not entered</i>}</span>
            </div>
          )}
          <div className="fx-idrow">
            <label>Name (not your trade name)</label>
            <span className="fx-idval">{co.name}</span>
          </div>
          <div className="fx-idrow">
            <label>Trade name (if any)</label>
            <span className="fx-idval">{co.tradeName}</span>
          </div>
          <div className="fx-idrow">
            <label>Address</label>
            <span className="fx-idval">
              {addr || <i className="fx-missing">no street address</i>}
              {city ? <br /> : null}
              {city}
            </span>
          </div>
        </div>
        <div className="fx-sidebox">
          {kind === '941' && (
            <>
              <div className="fx-sidebox-title">Report for this Quarter of {form.year}</div>
              <div className="fx-sidebox-sub">(Check one.)</div>
              {QUARTER_TEXT.map((t, i) => (
                <div key={i} className="fx-q">
                  <span className="fx-box">{qn === i + 1 ? '☒' : '☐'}</span>
                  <b>{i + 1}:</b> {t}
                </div>
              ))}
            </>
          )}
          {kind === '940' && (
            <>
              <div className="fx-sidebox-title">Type of Return</div>
              <div className="fx-sidebox-sub">(Check all that apply.)</div>
              {headerLines
                .filter((l) => l.key === 'type')
                .map((l) => (
                  <div key={l.col} className="fx-q" data-line={lineKey(l)}>
                    {cell(l)} <span>{l.label.replace(/^Type of Return: /, '')}</span>
                  </div>
                ))}
            </>
          )}
          {kind === 'STATE-UI' && (
            <>
              <div className="fx-sidebox-title">
                Quarter {form.period.slice(1)} of {form.year}
              </div>
              <div className="fx-sidebox-sub">State: {form.state}</div>
              <div className="fx-q">Due {fmtDate(form.dueDate)}</div>
              {form.extra?.suiRate !== undefined && <div className="fx-q">UI rate {fmtPercent(Number(form.extra.suiRate))}</div>}
            </>
          )}
        </div>
      </div>
      {headerLines.some((l) => l.key === 'agg') && (
        <div className="fx-agg">
          <span className="fx-muted">Aggregate return filers only:</span>
          {headerLines
            .filter((l) => l.key === 'agg')
            .map((l) => (
              <span key={l.col} className="fx-aggitem" data-line={lineKey(l)}>
                {cell(l)} {l.label.replace(/^Aggregate Return Filers Only: /, '')}
              </span>
            ))}
        </div>
      )}
    </div>
  );
}

function RowView(p: PaperProps & { row: Row }) {
  const { row, kind, flash } = p;
  const first = row.lines[0];
  const k = lineKey(first);
  if (row.kind === 'fields') {
    return (
      <div className={'fx-fields' + (flash && row.lines.some((l) => lineKey(l) === flash) ? ' fx-flash' : '')}>
        {row.lines.map((l) => (
          <div key={l.col || 'x'} className={'fx-fld' + (l.kind === 'check' ? ' fx-fld-check' : '')} data-line={lineKey(l)}>
            {l.kind === 'check' ? (
              <>
                <Cell {...p} l={l} />
                <span>{l.label}</span>
              </>
            ) : (
              <>
                <label>{l.label}</label>
                <Cell {...p} l={l} />
              </>
            )}
          </div>
        ))}
      </div>
    );
  }
  const no = lineNo(kind, first);
  if (row.kind === 'pair') {
    const second = row.lines[1];
    const label = first.label.replace(/\s*\(Column 1\)$/, '');
    const rate = /×\s*([0-9.]+)/.exec(second.label)?.[1];
    return (
      <div className={'fx-row fx-pair' + (flash === k || flash === lineKey(second) ? ' fx-flash' : '')} data-line={k}>
        <div className="fx-no">{no}</div>
        <div className="fx-label">{label}</div>
        <div className="fx-val">
          <span className="fx-colhead">Column 1</span>
          <Cell {...p} l={first} />
        </div>
        <div className="fx-op">× {rate} =</div>
        <div className="fx-val" data-line={lineKey(second)}>
          <span className="fx-colhead">Column 2</span>
          <Cell {...p} l={second} />
        </div>
      </div>
    );
  }
  const sub = !!first.col && !no;
  return (
    <div className={'fx-row' + (sub ? ' fx-sub' : '') + (first.kind === 'check' ? ' fx-checkrow' : '') + (flash === k ? ' fx-flash' : '')} data-line={k}>
      <div className="fx-no">{no}</div>
      {first.kind === 'check' ? (
        <>
          <div className="fx-checkcell">
            <Cell {...p} l={first} />
          </div>
          <div className="fx-label">{bareLabel(first)}</div>
        </>
      ) : (
        <>
          <div className="fx-label">{bareLabel(first)}</div>
          <div className="fx-val">
            <Cell {...p} l={first} />
          </div>
        </>
      )}
    </div>
  );
}

function Cell(p: PaperProps & { l: FormLine }) {
  const { l, eff, readOnly } = p;
  const k = lineKey(l);
  const id = `${p.winId}-ln-${k.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  const over = !!p.isOverridden?.(l);
  const editable = l.editable && !readOnly;
  const resetBtn =
    over && editable ? (
      <button
        type="button"
        className="fx-reset"
        title={`Use the calculated ${l.kind === 'check' ? 'answer' : 'amount'} (${l.kind === 'check' ? (p.calculated?.(l) ? 'checked' : 'not checked') : l.kind === 'money' ? fmtMoney(p.calculated?.(l) as number) : String(p.calculated?.(l))})`}
        aria-label="Use the calculated value"
        onClick={() => p.onReset?.(l)}
      >
        <RotateCcw size={12} />
      </button>
    ) : null;
  if (l.kind === 'check') {
    return (
      <span className={'fx-chk' + (over ? ' fx-over' : '')}>
        <Checkbox id={id} aria-label={l.label} checked={!!eff.chk.get(k)} disabled={!editable} onChange={(v) => p.onChk?.(l, v)} />
        {resetBtn}
      </span>
    );
  }
  if (!editable) {
    const cls = l.kind === 'text' ? 'fx-text-ro' : 'fx-calc';
    return <span className={cls + (l.kind === 'money' && (eff.num.get(k) ?? 0) < 0 ? ' fx-neg' : '')}>{showValue(l, eff) || ' '}</span>;
  }
  if (l.kind === 'text')
    return <TextField id={id} aria-label={l.label} className="fx-in fx-in-text" value={eff.txt.get(k) ?? ''} onChange={(v) => p.onTxt?.(l, v)} />;
  const val = eff.num.get(k) ?? 0;
  return (
    <span className={'fx-edit' + (over ? ' fx-over' : '')}>
      {l.kind === 'money' ? (
        <MoneyField id={id} aria-label={l.label} className="fx-in" value={val} onChange={(v) => p.onNum?.(l, v)} width={136} />
      ) : (
        <NumberField id={id} aria-label={l.label} className="fx-in" value={val} decimals={l.kind === 'count' ? 0 : 4} suffix={l.kind === 'number' ? '%' : undefined} onChange={(v) => p.onNum?.(l, v)} width={l.kind === 'count' ? 90 : 110} />
      )}
      {resetBtn}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Printing

export const PRINT_CSS = `
  .pf { page-break-after: always; }
  .pf:last-child { page-break-after: auto; }
  .pf-title { display: flex; align-items: baseline; gap: 10px; border-bottom: 2px solid #000; padding-bottom: 4px; }
  .pf-title b { font-size: 15px; }
  .pf-title .ag { margin-left: auto; font-size: 9px; }
  .pf-id { display: grid; grid-template-columns: 1.6fr 1fr; gap: 8px; margin: 6px 0; }
  .pf-box { border: 1px solid #000; padding: 4px 6px; }
  .pf-box div { display: flex; gap: 8px; padding: 2px 0; }
  .pf-box label { width: 170px; color: #333; font-size: 9.5px; }
  .pf-part { background: #000; color: #fff; padding: 2px 6px; margin-top: 8px; font-weight: bold; }
  .pf-part span { font-weight: normal; margin-left: 6px; }
  .pf-row { display: grid; grid-template-columns: 34px 1fr 120px; gap: 6px; border-bottom: 1px solid #ccc; padding: 2px 0; align-items: center; }
  .pf-row.pair { grid-template-columns: 34px 1fr 110px 60px 110px; }
  .pf-row .no { font-weight: bold; }
  .pf-row .v { border: 1px solid #000; padding: 1px 4px; text-align: right; min-height: 15px; font-family: 'Courier New', monospace; }
  .pf-row .t { border-bottom: 1px solid #000; min-height: 15px; }
  .pf-row .op { text-align: center; font-size: 9px; }
  .pf-sub .lbl { padding-left: 14px; }
  .pf-sched { border-collapse: collapse; width: 100%; margin-top: 6px; }
  .pf-sched td, .pf-sched th { border: 1px solid #000; padding: 1px 3px; font-size: 9px; }
  .pf-sched td.v { text-align: right; font-family: 'Courier New', monospace; }
  .pf-days { table-layout: fixed; margin-top: 8px; }
  .pf-note { font-size: 9px; color: #333; margin-top: 4px; }
`;

const esc = (s: string) => escHtml(s ?? '');

/** HTML of a printed form (header, parts, lines with values). */
export function printForm(kind: TaxFormKind, form: TaxForm, e: Effective): string {
  const co = form.company;
  const qn = form.period.startsWith('Q') ? +form.period.slice(1) : 0;
  const sections: { name: string; lines: FormLine[] }[] = [];
  for (const l of form.lines) {
    const s = sections.find((x) => x.name === l.section);
    if (s) s.lines.push(l);
    else sections.push({ name: l.section, lines: [l] });
  }
  const val = (l: FormLine) => {
    const k = lineKey(l);
    if (l.kind === 'check') return e.chk.get(k) ? '☒' : '☐';
    if (l.kind === 'text') return esc(e.txt.get(k) ?? '');
    return esc(showValue(l, e));
  };
  const head =
    kind === 'STATE-UI'
      ? `<div class="pf-title"><b>${esc(form.title)}</b><span>${esc(String(form.extra?.quarterlyReport ?? ''))}</span></div>`
      : `<div class="pf-title"><b>Form ${kind} for ${form.year}:</b><span>${kind === '941' ? "Employer's QUARTERLY Federal Tax Return" : "Employer's Annual Federal Unemployment (FUTA) Tax Return"}</span><span class="ag">Department of the Treasury — Internal Revenue Service</span></div>`;
  const side =
    kind === '941'
      ? `<div class="pf-box"><b>Report for this Quarter of ${form.year}</b>${QUARTER_TEXT.map((t, i) => `<div>${qn === i + 1 ? '☒' : '☐'} ${i + 1}: ${t}</div>`).join('')}</div>`
      : kind === '940'
        ? `<div class="pf-box"><b>Type of Return</b>${form.lines
            .filter((l) => l.key === 'type')
            .map((l) => `<div>${val(l)} ${esc(l.label.replace(/^Type of Return: /, ''))}</div>`)
            .join('')}</div>`
        : `<div class="pf-box"><b>Quarter ${qn} of ${form.year}</b><div>State: ${esc(form.state)}</div><div>Due ${fmtDate(form.dueDate)}</div></div>`;
  const idBox = `<div class="pf-box">
    <div><label>${kind === 'STATE-UI' ? 'Employer account number' : 'Employer identification number (EIN)'}</label><b>${esc(kind === 'STATE-UI' ? co.stateId : co.ein)}</b></div>
    <div><label>Name (not your trade name)</label>${esc(co.name)}</div>
    <div><label>Trade name (if any)</label>${esc(co.tradeName)}</div>
    <div><label>Address</label>${esc([co.address.line1, co.address.line2].filter(Boolean).join(', '))} ${esc([co.address.city, co.address.state, co.address.zip].filter(Boolean).join(' '))}</div></div>`;
  const parts = sections
    .filter((s) => s.name !== 'Header')
    .map((s) => {
      const rows = rowsOf(s.lines)
        .map((r) => {
          if (r.kind === 'pair') {
            const [a, b] = r.lines;
            const rate = /×\s*([0-9.]+)/.exec(b.label)?.[1] ?? '';
            return `<div class="pf-row pair"><span class="no">${esc(lineNo(kind, a))}</span><span class="lbl">${esc(a.label.replace(/\s*\(Column 1\)$/, ''))}</span><span class="v">${val(a)}</span><span class="op">× ${rate} =</span><span class="v">${val(b)}</span></div>`;
          }
          return r.lines
            .map((l) => {
              const no = r.kind === 'fields' ? '' : lineNo(kind, l);
              const cls = l.kind === 'text' ? 't' : l.kind === 'check' ? '' : 'v';
              return `<div class="pf-row${l.col && !no ? ' pf-sub' : ''}"><span class="no">${esc(no)}</span><span class="lbl">${esc(l.label)}</span><span class="${cls}">${val(l)}</span></div>`;
            })
            .join('');
        })
        .join('');
      return `<div class="pf-part">${esc(s.name)}:<span>${esc(PART_TITLES[kind][s.name] ?? '')}</span></div>${rows}`;
    })
    .join('');
  const agg = form.lines.filter((l) => l.key === 'agg');
  const aggHtml = agg.length ? `<div class="pf-note">Aggregate return filers only: ${agg.map((l) => `${val(l)} ${esc(l.label.replace(/^Aggregate Return Filers Only: /, ''))}`).join(' &nbsp; ')}</div>` : '';
  return `<div class="pf">${head}<div class="pf-id">${idBox}${side}</div>${aggHtml}${parts}<div class="pf-note">Prepared with SerieX Payroll ${fmtDate(todayIso())}. Keep a copy for your records.</div></div>`;
}

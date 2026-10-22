// File > Utilities > Import > QuickBooks Desktop (IIF): brings books kept in QuickBooks Desktop into
// a new company file or into the open one when it has no transactions yet.
//   1 Start: where the books go and how (every transaction, or opening balances on a conversion date)
//   2 Files: the IIF file (lists, and transactions), plus for opening balances the Trial Balance,
//     Open Invoices and Unpaid Bills Detail reports saved as CSV
//   3 Preview: what the files contain (POST qbimport/preview)
//   4 Mapping review: accounts, items and names that need a look (unknown types, used but not listed,
//     names already taken); each can be created, matched to a record of the company, said to be the
//     same as another entry of the files, or (items) left out
//   5 Check: a dry run that imports everything and rolls it back, listing the problems per line
//   6 Bank rules: rules suggested by transactions classified the same way again and again (the files
//     carry no rules); the ticked ones are created by the import
//   7 Import report: what was created, the trial balance compared with QuickBooks, and the checks
// The files go to the server with every step (nothing is stored until the import).
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowRightLeft, Check, ClipboardCheck, FileSearch, FileUp, FolderInput, Lightbulb, ListChecks, Printer, Rocket, Search } from 'lucide-react';
import { api } from '@/api/client';
import { invalidateAll } from '@/api/hooks';
import type { Account, Item, Name } from '@/api/types';
import { Badge, Button, Checkbox, DateField, ErrorBanner, Field, FieldRow, FormErrorsProvider, Select, Spinner, TextField, useFormErrors } from '@/components';
import { SuggestionSummary, type RuleSuggestion } from '@/modules/banking/ruleSuggestions';
import { switchCompany, useSession } from '@/state/session';
import { fmtDate, fmtMoney } from '@/util/format';
import { escHtml, printHtml } from '@/util/print';
import { useOptionalWindow } from '@/windows/WindowContext';
import { MONTH_OPTIONS } from './shared';
import './company.css';
import './qbimport.css';

export interface QuickBooksImportProps {
  /** "new" starts with a new company file (always when no company is open). */
  target?: 'new' | 'current';
}

// ---------------------------------------------------------------------------
// Server contract (server/internal/qbimport)

interface Problem {
  file: '' | 'iif' | 'tb' | 'invoices' | 'bills';
  line: number;
  level: 'error' | 'note';
  message: string;
}

interface MapRow {
  source: string;
  line: number;
  action: 'create' | 'existing' | 'map' | 'use' | 'none';
  targetId: number;
  targetName: string;
  review: string;
  blocking: boolean;
  useSource: string;
  uses: number;
}
interface AccountRow extends MapRow {
  sourceType: string;
  number: string;
  type: string;
}
interface ItemRow extends MapRow {
  sourceType: string;
  type: string;
}
interface NameRow extends MapRow {
  kind: 'customer' | 'vendor' | 'other';
}

interface TxnCount {
  source: string;
  label: string;
  count: number;
  imported: number;
  asJournal: number;
  skipped: number;
}

interface BalanceRow {
  accountId: number;
  account: string;
  number: string;
  type: string;
  source: number;
  books: number;
  difference: number;
}

interface Preview {
  fileName: string;
  product: string;
  version: string;
  lines: number;
  sections: { key: string; label: string; count: number }[];
  transactions: TxnCount[];
  dateFrom: string;
  dateTo: string;
  accounts: AccountRow[];
  names: NameRow[];
  items: ItemRow[];
  balances: BalanceRow[];
  trialBalance?: { rows: number; debits: number; credits: number; asOf: string };
  openInvoices?: { count: number; total: number; credits: number };
  openBills?: { count: number; total: number; credits: number };
  target: { transactions: number; empty: boolean };
  problems: Problem[];
  errors: number;
  notes: number;
  blocking: number;
}

interface Report {
  dryRun: boolean;
  imported: boolean;
  mode: Mode;
  asOf: string;
  company?: { id: string; name: string };
  counts: { what: string; created: number; matched: number; skipped: number }[];
  transactions: TxnCount[];
  opening?: {
    date: string;
    invoices: number;
    invoicesTotal: number;
    bills: number;
    billsTotal: number;
    inventoryItems: number;
    inventoryValue: number;
    journalLines: number;
    journalEntered: boolean;
  };
  paymentsApplied: number;
  depositsLinked: number;
  clearedEntries: number;
  trialBalance: BalanceRow[];
  totalDebits: number;
  totalCredits: number;
  checks: { key: string; label: string; ok: boolean; detail: string }[];
  errors: number;
  notes: number;
  problems: Problem[];
  truncated: boolean;
  ruleSuggestions: RuleSuggestion[];
  rulesCreated: string[];
}

type Mode = 'transactions' | 'opening';
type Kind = 'accounts' | 'items' | 'names';

/** A choice of the mapping review (server Options.accounts / items / names). */
interface Choice {
  action: 'create' | 'map' | 'use' | 'none';
  type?: string;
  kind?: string;
  targetId?: number;
  source?: string;
}

interface Files {
  iif: File | null;
  tb: File | null;
  invoices: File | null;
  bills: File | null;
}

const ACCOUNT_TYPES = [
  'Bank', 'Accounts Receivable', 'Other Current Asset', 'Fixed Asset', 'Other Asset', 'Accounts Payable', 'Credit Card',
  'Other Current Liability', 'Long Term Liability', 'Equity', 'Income', 'Cost of Goods Sold', 'Expense', 'Other Income',
  'Other Expense', 'Non-Posting',
];
const ITEM_TYPES = ['Service', 'Inventory Part', 'Non-inventory Part', 'Other Charge', 'Subtotal', 'Discount', 'Payment', 'Sales Tax Item'];
const NAME_KINDS = [
  { value: 'customer', label: 'Customer' },
  { value: 'vendor', label: 'Vendor' },
  { value: 'other', label: 'Other name' },
];
const KIND_WORD: Record<string, string> = { customer: 'customer', vendor: 'vendor', other: 'other name' };
const FILE_LABEL: Record<string, string> = { iif: 'IIF file', tb: 'Trial balance', invoices: 'Open invoices', bills: 'Unpaid bills', '': '' };

const STEPS = [
  { key: 'start', label: 'Start', icon: FolderInput },
  { key: 'files', label: 'Files', icon: FileUp },
  { key: 'preview', label: 'Preview', icon: FileSearch },
  { key: 'review', label: 'Mapping', icon: ArrowRightLeft },
  { key: 'check', label: 'Check', icon: ClipboardCheck },
  { key: 'rules', label: 'Bank rules', icon: Lightbulb },
  { key: 'done', label: 'Report', icon: ListChecks },
] as const;
type StepKey = (typeof STEPS)[number]['key'];

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export default function QuickBooksImport(props: QuickBooksImportProps) {
  const win = useOptionalWindow();
  const fe = useFormErrors();
  const rootRef = useRef<HTMLDivElement>(null);
  const session = useSession();
  const openId = session.companyId;
  const openName = session.company?.name ?? '';

  const [step, setStep] = useState<StepKey>('start');
  const [target, setTarget] = useState<'new' | 'current'>(props.target === 'current' && openId ? 'current' : 'new');
  const [companyName, setCompanyName] = useState('');
  const [fyMonth, setFyMonth] = useState(1);
  const [mode, setMode] = useState<Mode>('transactions');
  const [files, setFiles] = useState<Files>({ iif: null, tb: null, invoices: null, bills: null });
  const [conversionDate, setConversionDate] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [choices, setChoices] = useState<Record<Kind, Record<string, Choice>>>({ accounts: {}, items: {}, names: {} });
  /** The choices changed since the last preview. */
  const [stale, setStale] = useState(false);
  const [dry, setDry] = useState<Report | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [skipProblems, setSkipProblems] = useState(false);
  /** Suggested bank rules: kept or not, and their text (by suggestion key). */
  const [rulePick, setRulePick] = useState<Record<string, { on: boolean; matchText: string }>>({});
  const [busy, setBusy] = useState('');

  // the open company can take the books only while it has no transactions
  const openTxns = useQuery({
    queryKey: ['qbimport-open-txns', openId],
    enabled: !!openId,
    queryFn: () => api.get<{ rows: unknown[] }>('/txns?limit=1').then((r) => r.rows.length),
  });
  const openHasTxns = (openTxns.data ?? 0) > 0;
  useEffect(() => {
    if (target === 'current' && (!openId || openHasTxns)) setTarget('new');
  }, [openId, openHasTxns, target]);

  useEffect(() => {
    win?.setDirty(!!files.iif && !report?.imported);
  }, [win, files.iif, report]);

  // strong patterns are kept by default; earlier choices stay when the check runs again
  useEffect(() => {
    if (!dry) return;
    setRulePick((cur) => {
      const next: typeof cur = {};
      for (const s of dry.ruleSuggestions ?? []) next[s.key] = cur[s.key] ?? { on: s.confidence === 'high', matchText: s.rule.matchText };
      return next;
    });
  }, [dry]);

  const stepIndex = STEPS.findIndex((s) => s.key === step);

  const options = (extra: Record<string, unknown> = {}) => ({
    mode,
    conversionDate: mode === 'opening' ? conversionDate : '',
    accounts: choices.accounts,
    items: choices.items,
    names: choices.names,
    company: target === 'new' ? { name: companyName.trim(), fiscalYearStartMonth: fyMonth } : undefined,
    ...extra,
  });

  /** Sends the files and options to qbimport/{preview|run} of the chosen target. */
  const call = <T,>(path: 'preview' | 'run', opts: Record<string, unknown>, dryRun = false): Promise<T> => {
    const fd = new FormData();
    if (files.iif) fd.append('iif', files.iif);
    if (mode === 'opening') {
      if (files.tb) fd.append('tb', files.tb);
      if (files.invoices) fd.append('invoices', files.invoices);
      if (files.bills) fd.append('bills', files.bills);
    }
    fd.append('options', JSON.stringify(opts));
    const p = `/qbimport/${path}${dryRun ? '?dryRun=1' : ''}`;
    return target === 'new' ? api.global.post<T>(p, fd) : api.post<T>(p, fd);
  };

  const runPreview = async (): Promise<Preview | null> => {
    setBusy('Reading the files...');
    try {
      const pv = await call<Preview>('preview', options());
      setPreview(pv);
      setStale(false);
      setDry(null);
      if (mode === 'opening' && !conversionDate && pv.trialBalance?.asOf) setConversionDate(pv.trialBalance.asOf);
      return pv;
    } catch (e) {
      fe.fromError(e);
      return null;
    } finally {
      setBusy('');
    }
  };

  const runCheck = async () => {
    fe.clearAll();
    setBusy('Checking the import: everything is entered once and then undone. Large files take a minute.');
    try {
      setDry(await call<Report>('run', options({ skipProblems: false }), true));
    } catch (e) {
      fe.fromError(e);
    } finally {
      setBusy('');
    }
  };

  const runImport = async () => {
    fe.clearAll();
    setBusy('Importing your books...');
    try {
      const rules: Record<string, { matchText: string }> = {};
      for (const [k, v] of Object.entries(rulePick)) if (v.on) rules[k] = { matchText: v.matchText.trim() };
      const r = await call<Report>('run', options({ skipProblems, rules }));
      setReport(r);
      setStep('done');
      if (r.imported && target === 'current') await invalidateAll();
    } catch (e) {
      fe.fromError(e);
    } finally {
      setBusy('');
    }
  };

  // ------------------------------------------------------------------ navigation

  const validate = (k: StepKey): boolean => {
    fe.clearAll();
    if (k === 'start') {
      if (target === 'new' && !companyName.trim()) {
        fe.setErrors({ companyName: 'Enter the name of the new company.' });
        return false;
      }
    }
    if (k === 'files') {
      if (!files.iif) {
        fe.setErrors({ iif: 'Choose the IIF file exported from QuickBooks® Desktop.' });
        return false;
      }
      if (mode === 'opening') {
        if (!files.tb) {
          fe.setErrors({ tb: 'Choose the trial balance file.' });
          return false;
        }
      }
    }
    return true;
  };

  const next = async () => {
    if (busy || !validate(step)) return;
    switch (step) {
      case 'start':
        setStep('files');
        break;
      case 'files':
        if (await runPreview()) setStep('preview');
        break;
      case 'preview':
        setStep('review');
        break;
      case 'review': {
        let pv = preview;
        if (stale) pv = await runPreview();
        if (!pv) return;
        if (pv.blocking > 0) {
          fe.setMessage(`${pv.blocking} ${pv.blocking === 1 ? 'entry needs' : 'entries need'} a choice before importing. They are marked in red.`);
          return;
        }
        setStep('check');
        await runCheck();
        break;
      }
      case 'check':
        setStep('rules');
        break;
      case 'rules':
        await runImport();
        break;
    }
  };

  const goto = (k: StepKey) => {
    if (busy || report) return;
    const i = STEPS.findIndex((s) => s.key === k);
    if (i < stepIndex) {
      fe.clearAll();
      setStep(k);
    }
  };

  const setFile = (k: keyof Files, f: File | null) => {
    setFiles((cur) => ({ ...cur, [k]: f }));
    setPreview(null);
    setDry(null);
    fe.clear(k);
  };

  const choose = (kind: Kind, source: string, c: Choice | null) => {
    setChoices((cur) => {
      const next = { ...cur[kind] };
      if (c) next[source] = c;
      else delete next[source];
      return { ...cur, [kind]: next };
    });
    setStale(true);
    setDry(null);
  };

  const nChoices = Object.keys(choices.accounts).length + Object.keys(choices.items).length + Object.keys(choices.names).length;

  // ------------------------------------------------------------------ render

  const checkErrors = dry ? dry.errors : 0;
  const nextLabel =
    step === 'rules' ? (target === 'new' ? 'Create company and import' : 'Import') : step === 'files' ? 'Read the files' : 'Next';
  const nextDisabled = !!busy || (step === 'check' && (!dry || (checkErrors > 0 && !skipProblems)));

  return (
    <FormErrorsProvider value={fe}>
      <div className="cx-wizard qb-wizard" ref={rootRef}>
        <nav className="cx-wiz-rail" aria-label="Steps">
          <div className="cx-wiz-railtitle">From QuickBooks® Desktop files</div>
          {STEPS.map((s, i) => {
            const Icon = s.icon;
            return (
              <button
                key={s.key}
                type="button"
                className={'cx-wiz-step' + (s.key === step ? ' cx-on' : '') + (i < stepIndex ? ' cx-done' : '')}
                onClick={() => goto(s.key)}
                disabled={!!busy || !!report || i > stepIndex}
                aria-current={s.key === step ? 'step' : undefined}
              >
                <span className="cx-wiz-num">{i < stepIndex ? <Check size={13} /> : <Icon size={13} />}</span>
                {s.label}
              </button>
            );
          })}
          <div className="cx-wiz-railfoot cx-muted cx-small">Nothing is saved until the last step. You can go back and change your choices.</div>
        </nav>
        <div className="cx-wiz-main">
          {busy ? (
            <div className="qb-busy">
              <Spinner label={busy} />
            </div>
          ) : (
            <div className="cx-wiz-body" key={step}>
              {(fe.message || Object.keys(fe.errors).length > 0) && (
                <ErrorBanner errors={fe.errors} message={fe.message} root={rootRef.current} onDismiss={() => fe.clearAll()} />
              )}
              {step === 'start' && (
                <StartStep
                  target={target}
                  setTarget={setTarget}
                  openName={openId ? openName : ''}
                  openHasTxns={openHasTxns}
                  companyName={companyName}
                  setCompanyName={setCompanyName}
                  fyMonth={fyMonth}
                  setFyMonth={setFyMonth}
                  mode={mode}
                  setMode={(m) => {
                    setMode(m);
                    setPreview(null);
                    setDry(null);
                  }}
                />
              )}
              {step === 'files' && (
                <FilesStep mode={mode} files={files} setFile={setFile} conversionDate={conversionDate} setConversionDate={setConversionDate} />
              )}
              {step === 'preview' && preview && <PreviewStep preview={preview} mode={mode} />}
              {step === 'review' && preview && (
                <ReviewStep
                  preview={preview}
                  choices={choices}
                  choose={choose}
                  stale={stale}
                  nChoices={nChoices}
                  onApply={() => void runPreview()}
                  currentTarget={target === 'current'}
                />
              )}
              {step === 'check' && dry && (
                <>
                  <WizHead
                    title={dry.errors ? 'The check found problems' : 'Ready to import'}
                    sub={
                      dry.errors
                        ? 'Fix them in the files (or in the mapping review) and check again, or import everything else and skip the lines with problems.'
                        : 'Everything was entered once and undone again. Here is what the import will do.'
                    }
                  />
                  <ReportView report={dry} />
                  {dry.errors > 0 && (
                    <Checkbox
                      checked={skipProblems}
                      onChange={setSkipProblems}
                      label={`Skip the ${dry.errors} ${dry.errors === 1 ? 'line' : 'lines'} with problems and import everything else`}
                    />
                  )}
                </>
              )}
              {step === 'rules' && dry && <RulesStep suggestions={dry.ruleSuggestions ?? []} pick={rulePick} setPick={setRulePick} />}
              {step === 'check' && !dry && (
                <div className="qb-empty">
                  <Button label="Run the check" variant="primary" onClick={() => void runCheck()} />
                </div>
              )}
              {step === 'done' && report && (
                <>
                  <WizHead
                    title={report.imported ? 'Your books are in SerieX Books' : 'Nothing was imported'}
                    sub={
                      report.imported
                        ? report.company
                          ? `The company file "${report.company.name}" was created with everything below.`
                          : 'Everything below was added to this company file.'
                        : 'The import found problems, so nothing was saved. Fix them and run the import again.'
                    }
                  />
                  <ReportView report={report} />
                </>
              )}
            </div>
          )}
          <div className="cx-dlg-foot">
            <div className="cx-grow cx-muted cx-small">
              Step {stepIndex + 1} of {STEPS.length}
            </div>
            {step === 'done' && report ? (
              <>
                <Button icon={Printer} label="Print report" onClick={() => void printReport(report, preview, report.company?.name ?? openName)} />
                {report.imported && report.company ? (
                  <>
                    <Button label="Close" onClick={() => void win?.close(true)} />
                    <Button
                      variant="primary"
                      icon={Rocket}
                      label={`Open ${report.company.name.replace(/&/g, '&&')}`}
                      onClick={() => void switchCompany(report.company!.id)}
                    />
                  </>
                ) : (
                  <Button variant="primary" label="Close" onClick={() => void win?.close(true)} />
                )}
              </>
            ) : (
              <>
                <Button label="Cancel" onClick={() => void win?.close()} disabled={!!busy} />
                {stepIndex > 0 && <Button label="Back" onClick={() => goto(STEPS[stepIndex - 1].key)} disabled={!!busy} />}
                {step === 'check' && dry && <Button label="Check again" onClick={() => void runCheck()} disabled={!!busy} />}
                <Button variant="primary" label={nextLabel} busy={!!busy} disabled={nextDisabled} onClick={() => void next()} />
              </>
            )}
          </div>
        </div>
      </div>
    </FormErrorsProvider>
  );
}

function WizHead({ title, sub }: { title: string; sub: ReactNode }) {
  return (
    <div className="cx-wiz-head">
      <h2>{title}</h2>
      <div className="cx-muted">{sub}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 1 Start

function StartStep(p: {
  target: 'new' | 'current';
  setTarget: (t: 'new' | 'current') => void;
  openName: string;
  openHasTxns: boolean;
  companyName: string;
  setCompanyName: (v: string) => void;
  fyMonth: number;
  setFyMonth: (m: number) => void;
  mode: Mode;
  setMode: (m: Mode) => void;
}) {
  return (
    <>
      <WizHead
        title="Bring your books from QuickBooks® Desktop files"
        sub="Your accounts, customers, vendors, items and other lists come along, with your transactions or with your balances on a conversion date."
      />
      <Field label="Where should the books go?">
        <div className="qb-cards">
          <ChoiceCard checked={p.target === 'new'} onChange={() => p.setTarget('new')} title="A new company file" desc="Recommended. Your other company files are not touched." />
          <ChoiceCard
            checked={p.target === 'current'}
            onChange={() => p.setTarget('current')}
            disabled={!p.openName || p.openHasTxns}
            title={p.openName ? `This company file (${p.openName})` : 'This company file'}
            desc={
              !p.openName
                ? 'No company file is open.'
                : p.openHasTxns
                  ? 'It already has transactions, so books cannot be imported into it.'
                  : 'It has no transactions yet. Accounts and lists with the same names are used as they are.'
            }
          />
        </div>
      </Field>
      {p.target === 'new' && (
        <FieldRow>
          <Field label="Name of the new company" required width={320}>
            <TextField name="companyName" value={p.companyName} onChange={p.setCompanyName} autoFocus placeholder="As in QuickBooks®" />
          </Field>
          <Field label="First month of the fiscal year" width={200}>
            <Select name="fyMonth" value={p.fyMonth} onChange={(v) => p.setFyMonth(Number(v))} options={MONTH_OPTIONS} />
          </Field>
        </FieldRow>
      )}
      <Field label="What do you want to bring?">
        <div className="qb-cards">
          <ChoiceCard
            checked={p.mode === 'transactions'}
            onChange={() => p.setMode('transactions')}
            title="Every transaction"
            desc="Your lists and every transaction of the files, one by one. Reports of past years work in SerieX Books."
          />
          <ChoiceCard
            checked={p.mode === 'opening'}
            onChange={() => p.setMode('opening')}
            title="Opening balances on a conversion date"
            desc="Your lists, every account balance on one date, and the invoices and bills still open then, so aging is right from day one. Transactions after that date can come too."
          />
        </div>
      </Field>
      <div className="qb-help">
        <b>Getting the files out of QuickBooks® Desktop</b>
        <ol>
          <li>
            Lists: <i>File &gt; Utilities &gt; Export &gt; Lists to IIF Files</i>, tick every list, and save the file.
          </li>
          {p.mode === 'transactions' ? (
            <li>Transactions: an IIF file with your transactions (from an IIF export tool or your accountant). They can be in the same file as the lists.</li>
          ) : (
            <>
              <li>
                Trial balance: <i>Reports &gt; Accountant &amp; Taxes &gt; Trial Balance</i>, set the date to your conversion date, then{' '}
                <i>Excel &gt; Create New Worksheet &gt; Create a comma separated values (.csv) file</i>.
              </li>
              <li>
                Open invoices: <i>Reports &gt; Customers &amp; Receivables &gt; Open Invoices</i>, same date, saved the same way.
              </li>
              <li>
                Unpaid bills: <i>Reports &gt; Vendors &amp; Payables &gt; Unpaid Bills Detail</i>, same date, saved the same way.
              </li>
            </>
          )}
        </ol>
      </div>
    </>
  );
}

function ChoiceCard({ checked, onChange, title, desc, disabled }: { checked: boolean; onChange: () => void; title: string; desc: string; disabled?: boolean }) {
  return (
    <label className={'cx-trackcard' + (checked ? ' cx-on' : '') + (disabled ? ' cx-locked' : '')}>
      <input type="radio" checked={checked} disabled={disabled} onChange={onChange} />
      <span>
        <b>{title}</b>
        <span className="cx-muted cx-small">{desc}</span>
      </span>
    </label>
  );
}

// ---------------------------------------------------------------------------
// 2 Files

function FilesStep(p: {
  mode: Mode;
  files: Files;
  setFile: (k: keyof Files, f: File | null) => void;
  conversionDate: string;
  setConversionDate: (d: string) => void;
}) {
  return (
    <>
      <WizHead
        title="Choose the files"
        sub={
          p.mode === 'transactions'
            ? 'The IIF file with your lists and your transactions.'
            : 'The IIF file with your lists, and the three reports saved as CSV files on your conversion date.'
        }
      />
      <FileDrop
        name="iif"
        label="IIF file from QuickBooks® Desktop"
        hint={p.mode === 'transactions' ? 'Lists and transactions (.iif)' : 'Lists (.iif). Transactions after the conversion date in it are imported too.'}
        accept=".iif,.txt,text/plain"
        file={p.files.iif}
        onFile={(f) => p.setFile('iif', f)}
      />
      {p.mode === 'opening' && (
        <>
          <Field
            label="Conversion date"
            hint="The date of the trial balance and of the open invoices and bills. Leave it empty to take the date printed on the trial balance."
            width={460}
          >
            <DateField value={p.conversionDate} onChange={p.setConversionDate} width={150} />
          </Field>
          <FileDrop name="tb" label="Trial balance" hint="Trial Balance report as of the conversion date (.csv)" accept=".csv,text/csv,.txt" file={p.files.tb} onFile={(f) => p.setFile('tb', f)} />
          <FileDrop
            name="invoices"
            label="Open invoices"
            hint="Open Invoices report on the conversion date (.csv). Not needed when nothing was owed to you."
            accept=".csv,text/csv,.txt"
            file={p.files.invoices}
            onFile={(f) => p.setFile('invoices', f)}
          />
          <FileDrop
            name="bills"
            label="Unpaid bills"
            hint="Unpaid Bills Detail report on the conversion date (.csv). Not needed when you owed nothing."
            accept=".csv,text/csv,.txt"
            file={p.files.bills}
            onFile={(f) => p.setFile('bills', f)}
          />
        </>
      )}
    </>
  );
}

function FileDrop({ name, label, hint, accept, file, onFile }: { name: string; label: string; hint: string; accept: string; file: File | null; onFile: (f: File | null) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <Field label={label}>
      <div
        className={'qb-drop' + (over ? ' qb-over' : '') + (file ? ' qb-has' : '')}
        data-field={name}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f) onFile(f);
        }}
      >
        <FileUp size={18} className="qb-drop-icon" />
        <div className="qb-drop-text">
          {file ? (
            <>
              <b>{file.name}</b>
              <span className="cx-muted cx-small">{(file.size / 1024).toFixed(1)} KB</span>
            </>
          ) : (
            <>
              <span>Drop the file here or choose it.</span>
              <span className="cx-muted cx-small">{hint}</span>
            </>
          )}
        </div>
        {file && <Button size="sm" label="Remove" onClick={() => onFile(null)} />}
        <Button size="sm" label={file ? 'Choose another...' : 'Choose file...'} onClick={() => ref.current?.click()} />
        <input
          ref={ref}
          type="file"
          accept={accept}
          hidden
          aria-label={label}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFile(f);
            e.target.value = '';
          }}
        />
      </div>
    </Field>
  );
}

// ---------------------------------------------------------------------------
// 3 Preview

function PreviewStep({ preview: p, mode }: { preview: Preview; mode: Mode }) {
  const txTotal = sum(p.transactions.map((t) => t.count));
  return (
    <>
      <WizHead
        title={`What ${p.fileName || 'the file'} holds`}
        sub={
          <>
            {p.product ? `${p.product} ${p.version}`.trim() + ' · ' : ''}
            {p.lines.toLocaleString()} lines{txTotal ? ` · transactions from ${fmtDate(p.dateFrom)} to ${fmtDate(p.dateTo)}` : ''}
          </>
        }
      />
      <div className="qb-two">
        <div>
          <div className="cx-section-title">Lists</div>
          <table className="qb-table">
            <tbody>
              {p.sections
                .filter((s) => s.key !== 'TRNS')
                .map((s) => (
                  <tr key={s.key}>
                    <td>{s.label}</td>
                    <td className="qb-num">{s.count.toLocaleString()}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        <div>
          <div className="cx-section-title">{mode === 'opening' ? 'Transactions after the conversion date' : 'Transactions'}</div>
          {p.transactions.length ? (
            <table className="qb-table">
              <thead>
                <tr>
                  <th>In the QuickBooks® file</th>
                  <th>In SerieX Books</th>
                  <th className="qb-num">Count</th>
                </tr>
              </thead>
              <tbody>
                {p.transactions.map((t) => (
                  <tr key={t.source}>
                    <td>{t.source}</td>
                    <td>{t.label}</td>
                    <td className="qb-num">{t.count.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="cx-muted">None.</div>
          )}
        </div>
      </div>
      {mode === 'opening' && (
        <div className="qb-stats">
          {p.trialBalance && (
            <Stat
              label="Trial balance"
              value={`${p.trialBalance.rows} accounts`}
              sub={`Debits ${fmtMoney(p.trialBalance.debits)} · credits ${fmtMoney(p.trialBalance.credits)}${p.trialBalance.asOf ? ` · as of ${fmtDate(p.trialBalance.asOf)}` : ''}`}
            />
          )}
          {p.openInvoices && <Stat label="Open invoices and credits" value={String(p.openInvoices.count)} sub={`Total ${fmtMoney(p.openInvoices.total)}`} />}
          {p.openBills && <Stat label="Unpaid bills and credits" value={String(p.openBills.count)} sub={`Total ${fmtMoney(p.openBills.total)}`} />}
        </div>
      )}
      <ProblemList problems={p.problems} title="Found while reading the files" empty="The files were read without problems." />
    </>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="qb-stat">
      <span className="cx-muted cx-small">{label}</span>
      <b>{value}</b>
      <span className="cx-muted cx-small">{sub}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 4 Mapping review

const MAX_ROWS = 200;

function ReviewStep(p: {
  preview: Preview;
  choices: Record<Kind, Record<string, Choice>>;
  choose: (kind: Kind, source: string, c: Choice | null) => void;
  stale: boolean;
  nChoices: number;
  onApply: () => void;
  currentTarget: boolean;
}) {
  const [kind, setKind] = useState<Kind>('accounts');
  const [all, setAll] = useState(false);
  const [q, setQ] = useState('');
  const rows: MapRow[] = p.preview[kind];
  const attention = (r: MapRow) => r.blocking || !!r.review;
  const count = (k: Kind) => (p.preview[k] as MapRow[]).filter(attention).length;
  const shown = rows.filter((r) => (all || attention(r) || !!p.choices[kind][r.source]) && (!q || r.source.toLowerCase().includes(q.toLowerCase())));

  // records of the open company (only when importing into it)
  const enabled = p.currentTarget;
  const accounts = useQuery({ queryKey: ['accounts', { active: 'all' }], enabled, queryFn: () => api.get<Account[]>('/accounts?active=all') });
  const items = useQuery({ queryKey: ['items', { active: 'all' }], enabled, queryFn: () => api.get<Item[]>('/items?active=all') });
  const names = useQuery({ queryKey: ['names', undefined, { active: 'all' }], enabled, queryFn: () => api.get<Name[]>('/names?active=all') });
  const company = useMemo(() => {
    const opts = (list: { id: number; fullName: string }[] | undefined) => (list ?? []).map((x) => ({ value: x.id, label: x.fullName }));
    return { accounts: opts(accounts.data), items: opts(items.data), names: opts(names.data) };
  }, [accounts.data, items.data, names.data]);

  const blocking = (p.preview.accounts as MapRow[]).concat(p.preview.items, p.preview.names).filter((r) => r.blocking).length;
  const what = { accounts: 'account', items: 'item', names: 'name' }[kind];

  return (
    <>
      <WizHead
        title="Review the mapping"
        sub="How each account, item and name of the files comes into SerieX Books. Entries that need a look are listed; red ones need a choice before importing."
      />
      <div className="qb-tabs" role="tablist">
        {(['accounts', 'items', 'names'] as Kind[]).map((k) => (
          <button key={k} type="button" role="tab" aria-selected={kind === k} className={'qb-tab' + (kind === k ? ' qb-on' : '')} onClick={() => setKind(k)}>
            {{ accounts: 'Accounts', items: 'Items', names: 'Customers, vendors and names' }[k]}
            {count(k) > 0 && (
              <Badge tone={(p.preview[k] as MapRow[]).some((r) => r.blocking) ? 'danger' : 'warning'}>{count(k)}</Badge>
            )}
          </button>
        ))}
        <span className="cx-spacer" />
        <div className="qb-search">
          <Search size={14} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Find ${what}`} aria-label={`Find ${what}`} />
        </div>
        <Checkbox checked={all} onChange={setAll} label={`Show all ${rows.length}`} />
      </div>
      {(p.stale || blocking > 0) && (
        <div className={'qb-bar' + (blocking > 0 && !p.stale ? ' qb-bad' : '')}>
          {p.stale
            ? `You changed ${p.nChoices === 1 ? 'a choice' : 'some choices'}. Apply them to see the result.`
            : `${blocking} ${blocking === 1 ? 'entry needs' : 'entries need'} a choice.`}
          {p.stale && <Button size="sm" variant="primary" label="Apply changes" onClick={p.onApply} />}
        </div>
      )}
      {shown.length === 0 ? (
        <div className="qb-empty cx-muted">
          {all || q ? `No ${what} matches.` : `Every ${what} comes in as it is. Tick "Show all" to see them.`}
        </div>
      ) : (
        <div className="qb-mapwrap">
          <datalist id={`qb-src-${kind}`}>
            {rows.map((r) => (
              <option key={r.source} value={r.source} />
            ))}
          </datalist>
          <table className="qb-table qb-map">
            <thead>
              <tr>
                <th>In the files</th>
                <th>What happens</th>
                <th>In SerieX Books</th>
              </tr>
            </thead>
            <tbody>
              {shown.slice(0, MAX_ROWS).map((r) => (
                <MapRowView
                  key={r.source}
                  kind={kind}
                  row={r}
                  choice={p.choices[kind][r.source]}
                  choose={(c) => p.choose(kind, r.source, c)}
                  companyOptions={company[kind]}
                  currentTarget={p.currentTarget}
                />
              ))}
            </tbody>
          </table>
          {shown.length > MAX_ROWS && (
            <div className="cx-muted cx-small qb-more">
              Showing {MAX_ROWS} of {shown.length.toLocaleString()}. Use Find to narrow the list.
            </div>
          )}
        </div>
      )}
    </>
  );
}

function MapRowView({
  kind,
  row,
  choice,
  choose,
  companyOptions,
  currentTarget,
}: {
  kind: Kind;
  row: MapRow;
  choice: Choice | undefined;
  choose: (c: Choice | null) => void;
  companyOptions: { value: number; label: string }[];
  currentTarget: boolean;
}) {
  const a = row as AccountRow & ItemRow & NameRow;
  const job = kind === 'names' && row.source.includes(':');
  // what the automatic plan does when the user chose nothing
  const [auto] = useState(() => (choice ? null : { action: row.action, targetName: row.targetName }));
  const action = choice?.action ?? (row.action === 'existing' ? 'existing' : row.action);
  const word = { accounts: 'account', items: 'item', names: 'name' }[kind];

  const actions: { value: string; label: string }[] = [];
  if (auto?.action === 'existing' || row.action === 'existing') actions.push({ value: 'existing', label: `Use ${auto?.targetName || row.targetName}` });
  actions.push({ value: 'create', label: 'Create it' });
  if (currentTarget) actions.push({ value: 'map', label: `Use another ${word} of this company` });
  actions.push({ value: 'use', label: `Same as another ${word} in the files` });
  if (kind === 'items') actions.push({ value: 'none', label: 'Leave it out (lines keep their account)' });

  const onAction = (v: string) => {
    switch (v) {
      case 'existing':
        choose(null);
        break;
      case 'create':
        if (kind === 'accounts') choose({ action: 'create', type: a.type || 'Expense' });
        else if (kind === 'items') choose({ action: 'create', type: a.type && ITEM_TYPES.includes(a.type) ? a.type : 'Service' });
        else choose({ action: 'create', kind: job ? 'customer' : a.kind || 'customer' });
        break;
      case 'map': {
        // a record of the company with the same name, else the user picks one
        const name = row.source.toLowerCase();
        const last = name.split(':').pop() ?? name;
        const same =
          companyOptions.find((o) => o.label.toLowerCase() === name) ?? companyOptions.find((o) => (o.label.toLowerCase().split(':').pop() ?? '') === last);
        choose({ action: 'map', targetId: same?.value ?? 0 });
        break;
      }
      case 'use':
        choose({ action: 'use', source: '' });
        break;
      case 'none':
        choose({ action: 'none' });
        break;
    }
  };

  let detail: ReactNode = null;
  if (action === 'create') {
    if (kind === 'accounts')
      detail = (
        <Select
          value={choice?.type ?? a.type ?? ''}
          onChange={(v) => choose({ action: 'create', type: v })}
          options={[...(a.type ? [] : [{ value: '', label: 'Choose a type...' }]), ...ACCOUNT_TYPES.map((t) => ({ value: t, label: t }))]}
          aria-label="Account type"
        />
      );
    else if (kind === 'items')
      detail = (
        <Select
          value={choice?.type ?? (ITEM_TYPES.includes(a.type) ? a.type : '')}
          onChange={(v) => choose({ action: 'create', type: v })}
          options={[...(ITEM_TYPES.includes(a.type) ? [] : [{ value: '', label: 'Choose a type...' }]), ...ITEM_TYPES.map((t) => ({ value: t, label: t }))]}
          aria-label="Item type"
        />
      );
    else if (!job)
      detail = <Select value={choice?.kind ?? a.kind} onChange={(v) => choose({ action: 'create', kind: v })} options={NAME_KINDS} aria-label="Kind of name" />;
  } else if (action === 'map') {
    detail = (
      <Select
        value={choice?.targetId || row.targetId || ''}
        onChange={(v) => choose({ action: 'map', targetId: Number(v) })}
        options={[...(choice?.targetId || row.targetId ? [] : [{ value: '', label: `Choose the ${word}...` }]), ...companyOptions]}
        aria-label={`${word} of this company`}
      />
    );
  } else if (action === 'use') {
    detail = (
      <input
        className="qb-input"
        list={`qb-src-${kind}`}
        defaultValue={choice?.source ?? row.useSource}
        placeholder={`Name of the ${word} in the files`}
        aria-label={`Same as which ${word}`}
        onBlur={(e) => {
          if (e.target.value !== (choice?.source ?? row.useSource)) choose({ action: 'use', source: e.target.value.trim() });
        }}
      />
    );
  }

  const typeText = kind === 'names' ? KIND_WORD[a.kind] : a.sourceType || '';
  return (
    <tr className={row.blocking ? 'qb-blocking' : undefined}>
      <td>
        <b>{row.source}</b>
        <div className="cx-muted cx-small">
          {[typeText && kind !== 'names' ? `type ${typeText} in the file` : '', row.line ? `line ${row.line}` : 'used, not listed', row.uses ? `${row.uses} ${row.uses === 1 ? 'use' : 'uses'}` : '']
            .filter(Boolean)
            .join(' · ')}
        </div>
      </td>
      <td className="qb-what">
        <Select value={action} onChange={onAction} options={actions} aria-label="What happens" />
        {detail}
      </td>
      <td>
        {row.action === 'none' ? <span className="cx-muted">Not created</span> : <span>{row.targetName || row.source}</span>}
        {kind === 'accounts' && a.type && row.action !== 'none' && <span className="cx-muted cx-small"> · {a.type}</span>}
        {kind === 'items' && a.type && row.action !== 'none' && <span className="cx-muted cx-small"> · {a.type}</span>}
        {kind === 'names' && <span className="cx-muted cx-small"> · {KIND_WORD[a.kind]}</span>}
        {row.review && <div className={'cx-small ' + (row.blocking ? 'qb-red' : 'qb-amber')}>{row.review}</div>}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// 6 Bank rules

function RulesStep({
  suggestions,
  pick,
  setPick,
}: {
  suggestions: RuleSuggestion[];
  pick: Record<string, { on: boolean; matchText: string }>;
  setPick: (f: (cur: Record<string, { on: boolean; matchText: string }>) => Record<string, { on: boolean; matchText: string }>) => void;
}) {
  const kept = suggestions.filter((s) => pick[s.key]?.on).length;
  const set = (key: string, p: Partial<{ on: boolean; matchText: string }>) => setPick((cur) => ({ ...cur, [key]: { ...cur[key], ...p } }));
  const all = (on: boolean) => setPick((cur) => Object.fromEntries(Object.entries(cur).map(([k, v]) => [k, { ...v, on }])));
  return (
    <>
      <WizHead
        title="Bank rules from your patterns"
        sub="QuickBooks® Desktop files do not include bank rules, so SerieX Books looked for transactions classified the same way again and again. A rule fills in the payee and category of matching lines in Bank Feeds; you still confirm each line."
      />
      {suggestions.length === 0 ? (
        <div className="qb-empty cx-muted">
          No repeated patterns were found in these transactions. Banking &gt; Bank Rules suggests rules later, as you classify downloaded bank transactions.
        </div>
      ) : (
        <>
          <div className="qb-titlerow">
            <b>
              {kept} of {suggestions.length} {suggestions.length === 1 ? 'rule' : 'rules'} will be created
            </b>
            <span className="cx-spacer" />
            <button type="button" className="sx-linkbtn" onClick={() => all(true)}>
              Keep all
            </button>
            <button type="button" className="sx-linkbtn" onClick={() => all(false)}>
              Keep none
            </button>
          </div>
          <div className="qb-rules">
            {suggestions.map((s) => {
              const p = pick[s.key] ?? { on: false, matchText: s.rule.matchText };
              return (
                <div key={s.key} className={'rs-item' + (p.on ? ' qb-rule-on' : '')}>
                  <input
                    type="checkbox"
                    className="rs-pick"
                    checked={p.on}
                    onChange={(e) => set(s.key, { on: e.target.checked })}
                    aria-label={`Create the rule for ${s.rule.matchText}`}
                  />
                  <SuggestionSummary
                    s={s}
                    matchText={
                      <input
                        className="rs-edit"
                        value={p.matchText}
                        onChange={(e) => set(s.key, { matchText: e.target.value, on: true })}
                        aria-label="Text the bank description must contain"
                      />
                    }
                  />
                </div>
              );
            })}
          </div>
          <div className="cx-muted cx-small">You can change or delete these rules later in Banking &gt; Bank Rules.</div>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// 5 / 7 Report

function ReportView({ report: r }: { report: Report }) {
  const [tbAll, setTbAll] = useState(false);
  const diffs = r.trialBalance.filter((b) => Math.abs(b.difference) >= 0.005);
  const tbRows = tbAll ? r.trialBalance : diffs.length ? diffs : r.trialBalance.slice(0, 12);
  const txImported = sum(r.transactions.map((t) => t.imported));
  return (
    <>
      <div className="qb-checks">
        {r.checks.map((c) => (
          <div key={c.key} className={'qb-check' + (c.ok ? ' qb-ok' : ' qb-badcheck')}>
            <span className="qb-checkmark">{c.ok ? '✓' : '!'}</span>
            <span>
              <b>{c.label}</b>
              <span className="cx-muted cx-small">{c.detail}</span>
            </span>
          </div>
        ))}
      </div>
      <div className="qb-two">
        <div>
          <div className="cx-section-title">Lists</div>
          <table className="qb-table">
            <thead>
              <tr>
                <th />
                <th className="qb-num">Created</th>
                <th className="qb-num">Already there</th>
                <th className="qb-num">Skipped</th>
              </tr>
            </thead>
            <tbody>
              {r.counts.map((c) => (
                <tr key={c.what}>
                  <td>{c.what}</td>
                  <td className="qb-num">{c.created || ''}</td>
                  <td className="qb-num">{c.matched || ''}</td>
                  <td className={'qb-num' + (c.skipped ? ' qb-red' : '')}>{c.skipped || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <div className="cx-section-title">Transactions ({txImported.toLocaleString()})</div>
          {r.transactions.length ? (
            <table className="qb-table">
              <thead>
                <tr>
                  <th>In the file</th>
                  <th>Entered as</th>
                  <th className="qb-num">Entered</th>
                  <th className="qb-num">Skipped</th>
                </tr>
              </thead>
              <tbody>
                {r.transactions.map((t) => (
                  <tr key={t.source}>
                    <td>{t.source}</td>
                    <td>
                      {t.label}
                      {t.asJournal > 0 && t.asJournal < t.imported && <span className="cx-muted cx-small"> ({t.asJournal} as journal entries)</span>}
                      {t.asJournal > 0 && t.asJournal === t.imported && t.label !== 'General Journal' && (
                        <span className="cx-muted cx-small"> (as journal entries)</span>
                      )}
                    </td>
                    <td className="qb-num">{t.imported.toLocaleString()}</td>
                    <td className={'qb-num' + (t.skipped ? ' qb-red' : '')}>{t.skipped || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="cx-muted">None.</div>
          )}
          <div className="cx-muted cx-small qb-gap">
            {[
              r.paymentsApplied ? `${r.paymentsApplied} payments applied to open invoices and bills` : '',
              r.depositsLinked ? `${r.depositsLinked} deposited payments matched` : '',
              r.clearedEntries ? `${r.clearedEntries} cleared entries kept for reconciling` : '',
            ]
              .filter(Boolean)
              .join(' · ')}
          </div>
        </div>
      </div>
      {r.opening && (
        <div className="qb-stats">
          <Stat label="Conversion date" value={fmtDate(r.opening.date)} sub={r.opening.journalEntered ? `Opening balance entry with ${r.opening.journalLines} lines` : 'No opening balance entry'} />
          <Stat label="Open invoices and credits" value={String(r.opening.invoices)} sub={`Total ${fmtMoney(r.opening.invoicesTotal)}`} />
          <Stat label="Unpaid bills and credits" value={String(r.opening.bills)} sub={`Total ${fmtMoney(r.opening.billsTotal)}`} />
          {r.opening.inventoryItems > 0 && <Stat label="Opening inventory" value={`${r.opening.inventoryItems} items`} sub={`Value ${fmtMoney(r.opening.inventoryValue)}`} />}
        </div>
      )}
      <div>
        <div className="cx-section-title qb-titlerow">
          <span>Trial balance after the import, as of {fmtDate(r.asOf)}</span>
          <span className="cx-spacer" />
          <Checkbox checked={tbAll} onChange={setTbAll} label={`Show all ${r.trialBalance.length} accounts`} />
        </div>
        <table className="qb-table qb-tb">
          <thead>
            <tr>
              <th>Account</th>
              <th>Type</th>
              <th className="qb-num">QuickBooks® files</th>
              <th className="qb-num">SerieX Books</th>
              <th className="qb-num">Difference</th>
            </tr>
          </thead>
          <tbody>
            {tbRows.map((b) => (
              <tr key={b.accountId + b.account}>
                <td>
                  {b.number ? <span className="cx-muted">{b.number} · </span> : null}
                  {b.account}
                </td>
                <td className="cx-muted">{b.type}</td>
                <td className="qb-num">{fmtMoney(b.source, { parens: true })}</td>
                <td className="qb-num">{fmtMoney(b.books, { parens: true })}</td>
                <td className={'qb-num' + (Math.abs(b.difference) >= 0.005 ? ' qb-red' : '')}>{fmtMoney(b.difference, { blankZero: true, parens: true })}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={3}>Total debits {fmtMoney(r.totalDebits)} · total credits {fmtMoney(r.totalCredits)}</td>
              <td colSpan={2} className="qb-num cx-muted cx-small">
                Debits positive, credits in parentheses
              </td>
            </tr>
          </tfoot>
        </table>
        {!tbAll && diffs.length === 0 && r.trialBalance.length > tbRows.length && (
          <div className="cx-muted cx-small qb-gap">Every account matches the QuickBooks® files; the first {tbRows.length} are shown.</div>
        )}
      </div>
      {!r.dryRun && (r.rulesCreated ?? []).length > 0 && (
        <div>
          <div className="cx-section-title">Bank rules created</div>
          <ul className="qb-plain">
            {r.ruleSuggestions
              .filter((s) => r.rulesCreated.includes(s.key))
              .map((s) => (
                <li key={s.key}>
                  {s.rule.matchText} → {s.payee ? `${s.payee} · ` : ''}
                  {s.category}
                </li>
              ))}
          </ul>
        </div>
      )}
      <ProblemList problems={r.problems} title="Problems and notes" empty="No problems." truncated={r.truncated} />
    </>
  );
}

function ProblemList({ problems, title, empty, truncated }: { problems: Problem[]; title: string; empty: string; truncated?: boolean }) {
  const [only, setOnly] = useState<'all' | 'error' | 'note'>('all');
  const errors = problems.filter((p) => p.level === 'error').length;
  const notes = problems.length - errors;
  const shown = problems.filter((p) => only === 'all' || p.level === only);
  return (
    <div>
      <div className="cx-section-title qb-titlerow">
        <span>{title}</span>
        <span className="cx-spacer" />
        {problems.length > 0 && (
          <Select
            value={only}
            onChange={(v) => setOnly(v as typeof only)}
            options={[
              { value: 'all', label: `All (${problems.length})` },
              { value: 'error', label: `Problems (${errors})` },
              { value: 'note', label: `Notes (${notes})` },
            ]}
            aria-label="Show"
            width={150}
          />
        )}
      </div>
      {problems.length === 0 ? (
        <div className="cx-muted">{empty}</div>
      ) : (
        <ul className="qb-problems">
          {shown.slice(0, 500).map((p, i) => (
            <li key={i} className={p.level === 'error' ? 'qb-perr' : 'qb-pnote'}>
              <span className="qb-where">{p.file ? `${FILE_LABEL[p.file]}${p.line ? `, line ${p.line}` : ''}` : 'Import'}</span>
              <span>{p.message}</span>
            </li>
          ))}
        </ul>
      )}
      {(truncated || shown.length > 500) && <div className="cx-muted cx-small qb-gap">Only the first problems are listed.</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Printing

function printReport(r: Report, p: Preview | null, company: string): Promise<void> {
  const e = escHtml;
  const m = (n: number) => e(fmtMoney(n, { parens: true }));
  const rows = (cells: string[]) => `<tr>${cells.join('')}</tr>`;
  const html = [
    `<h1>Import of QuickBooks® Desktop files</h1>`,
    `<div class="muted">${e(company)}${p?.fileName ? ` · ${e(p.fileName)}` : ''} · ${r.mode === 'opening' ? 'opening balances' : 'every transaction'} · printed ${e(fmtDate(new Date().toISOString().slice(0, 10)))}</div>`,
    `<h2 style="margin-top:12px">Checks</h2><table>${r.checks.map((c) => rows([`<td>${c.ok ? '✓' : '✗'}</td>`, `<td class="bold">${e(c.label)}</td>`, `<td>${e(c.detail)}</td>`])).join('')}</table>`,
    `<h2 style="margin-top:12px">Lists</h2><table><tr><th></th><th class="num">Created</th><th class="num">Already there</th><th class="num">Skipped</th></tr>${r.counts
      .map((c) => rows([`<td>${e(c.what)}</td>`, `<td class="num">${c.created || ''}</td>`, `<td class="num">${c.matched || ''}</td>`, `<td class="num">${c.skipped || ''}</td>`]))
      .join('')}</table>`,
    `<h2 style="margin-top:12px">Transactions</h2><table><tr><th>In the files</th><th>Entered as</th><th class="num">Entered</th><th class="num">As journal entries</th><th class="num">Skipped</th></tr>${r.transactions
      .map((t) => rows([`<td>${e(t.source)}</td>`, `<td>${e(t.label)}</td>`, `<td class="num">${t.imported}</td>`, `<td class="num">${t.asJournal || ''}</td>`, `<td class="num">${t.skipped || ''}</td>`]))
      .join('')}</table>`,
    `<h2 style="margin-top:12px">Trial balance as of ${e(fmtDate(r.asOf))}</h2><table><tr><th>Account</th><th>Type</th><th class="num">QuickBooks® files</th><th class="num">SerieX Books</th><th class="num">Difference</th></tr>${r.trialBalance
      .map((b) =>
        rows([
          `<td>${e((b.number ? b.number + ' · ' : '') + b.account)}</td>`,
          `<td>${e(b.type)}</td>`,
          `<td class="num">${m(b.source)}</td>`,
          `<td class="num">${m(b.books)}</td>`,
          `<td class="num">${Math.abs(b.difference) >= 0.005 ? m(b.difference) : ''}</td>`,
        ]),
      )
      .join('')}<tr><td colspan="5" class="bold">Total debits ${e(fmtMoney(r.totalDebits))} · total credits ${e(fmtMoney(r.totalCredits))}</td></tr></table>`,
    r.problems.length
      ? `<h2 style="margin-top:12px">Problems and notes</h2><table>${r.problems
          .map((p) => rows([`<td>${p.level === 'error' ? 'Problem' : 'Note'}</td>`, `<td>${e(p.file ? `${FILE_LABEL[p.file]}${p.line ? ` line ${p.line}` : ''}` : '')}</td>`, `<td>${e(p.message)}</td>`]))
          .join('')}</table>`
      : '',
  ].join('\n');
  return printHtml('Import of QuickBooks® Desktop files', html);
}

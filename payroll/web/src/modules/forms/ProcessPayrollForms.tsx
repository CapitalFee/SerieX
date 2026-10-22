// Tax Forms: the payroll tax forms to file for a year (FORM, FEDERAL/STATE, FILING PERIOD,
// DUE DATE, STATUS) with Open Form, the Forms ▾ menu (a form for any period, asked in the
// filing period dialog) and the Forms Filed tab with the saved forms.
import { useEffect, useMemo, useState } from 'react';
import { FilePlus2, Files } from 'lucide-react';
import { useCompany, useFilings, useStateSettings } from '@/api/hooks';
import type { FormFiling } from '@/api/types';
import { Button, DropdownButton, EmptyState, Field, ListView, Select, StatusPill, Tabs, showDialog, type ListColumn } from '@/components';
import { useWindow } from '@/windows/WindowContext';
import { openWindow } from '@/windows/windowStore';
import { todayIso } from '@/util/dates';
import { fmtDate } from '@/util/format';
import { lastEndedQuarter } from './Form941Window';
import { stampDate, useFormYears } from './period';
import './forms.css';

export interface ProcessPayrollFormsProps {
  /** Year to list. */
  year?: number;
}

type FormKind = '941' | '940' | 'W-2' | 'STATE-UI';

interface Row extends FormFiling {
  key: string;
}

const FORM_LABEL: Record<string, string> = { '941': 'Form 941', '940': 'Form 940', 'W-2': 'W-2/W-3', 'STATE-UI': 'State UI report' };

function periodLabel(f: FormFiling): string {
  if (f.period.startsWith('Q')) return `Quarterly · Q${f.period.slice(1)} ${f.year}`;
  return `Annually · ${f.year}`;
}

/** Opens the window of a form period. */
export function openForm(form: string, year: number, period: string, state?: string) {
  const quarter = period.startsWith('Q') ? +period.slice(1) : undefined;
  if (form === '941') openWindow('form941', { year, quarter });
  else if (form === '940') openWindow('form940', { year });
  else if (form === 'W-2') openWindow('formW2', { year });
  else openWindow('stateWageReport', { year, quarter, state });
}

export default function ProcessPayrollForms(props: ProcessPayrollFormsProps) {
  const win = useWindow();
  const today = todayIso();
  const lq = lastEndedQuarter();
  const [year, setYear] = useState<number>(props.year ?? +today.slice(0, 4));
  useEffect(() => {
    if (props.year) setYear(props.year);
  }, [props.year]);
  const years = useFormYears([year]);
  const q = useFilings(year);
  const { data: company } = useCompany();
  const { data: settings } = useStateSettings();
  const [tab, setTab] = useState<'file' | 'history'>('file');
  const [sel, setSel] = useState<string | null>(null);

  useEffect(() => {
    win.setTitle('Tax Forms');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rows: Row[] = useMemo(() => (q.data ?? []).map((f) => ({ ...f, key: `${f.form}|${f.year}|${f.period}|${f.state}` })), [q.data]);
  const history = rows.filter((r) => r.status === 'draft' || r.status === 'filed');
  const shown = tab === 'file' ? rows : history;
  const cur = shown.find((r) => r.key === sel) ?? null;
  const states = useMemo(() => {
    const set = new Set<string>((settings ?? []).map((s) => s.state));
    if (company?.primaryState) set.add(company.primaryState);
    rows.filter((r) => r.state).forEach((r) => set.add(r.state));
    return [...set].sort();
  }, [settings, company, rows]);

  const create = (r: Row | null) => {
    if (r) openForm(r.form, r.year, r.period, r.state || undefined);
  };

  /** Filing period dialog for a form chosen in the Forms menu. */
  const askPeriod = async (form: FormKind) => {
    const quarterly = form === '941' || form === 'STATE-UI';
    const res = await showDialog<{ year: number; quarter: number; state: string } | null>({
      title: `${FORM_LABEL[form]} - Select Filing Period`,
      width: 420,
      cancelValue: null,
      render: (close) => (
        <PeriodBody
          quarterly={quarterly}
          needsState={form === 'STATE-UI'}
          years={years}
          states={states}
          initial={{ year: quarterly ? lq.year : year, quarter: lq.quarter, state: company?.primaryState ?? states[0] ?? '' }}
          close={close}
        />
      ),
    });
    if (!res) return;
    openForm(form, res.year, quarterly ? `Q${res.quarter}` : 'Y', res.state);
  };

  const columns: ListColumn<Row>[] = [
    { key: 'title', label: 'FORM', width: 380, grow: true },
    { key: 'scope', label: 'FEDERAL/STATE', width: 120, render: (r) => (r.form === 'STATE-UI' ? r.state : 'Federal'), sortValue: (r) => (r.form === 'STATE-UI' ? r.state : 'Federal') },
    { key: 'period', label: 'FILING PERIOD', width: 150, render: periodLabel, sortValue: (r) => r.period },
    {
      key: 'dueDate',
      label: 'DUE DATE',
      width: 100,
      render: (r) => <span className={r.status !== 'filed' && r.dueDate < today ? 'fx-danger' : undefined}>{fmtDate(r.dueDate)}</span>,
      sortValue: (r) => r.dueDate,
    },
    {
      key: 'status',
      label: 'STATUS',
      width: 150,
      render: (r) => (
        <StatusPill
          status={r.status === 'filed' ? 'Filed' : r.status === 'draft' ? 'Draft' : r.dueDate < today ? 'Overdue' : 'New'}
          tone={r.status === 'filed' ? 'success' : r.status === 'draft' ? 'warning' : undefined}
          detail={r.status === 'filed' && r.filedAt ? stampDate(r.filedAt) : undefined}
        />
      ),
      sortValue: (r) => r.status,
    },
  ];
  const historyCols: ListColumn<Row>[] = [
    { key: 'periodEnd', label: 'PERIOD END DATE', width: 130, render: (r) => fmtDate(periodEnd(r)), sortValue: (r) => periodEnd(r) },
    { key: 'title', label: 'FORM', width: 380, grow: true },
    { key: 'status', label: 'STATUS', width: 110, render: (r) => (r.status === 'filed' ? 'Filed' : 'Draft') },
    { key: 'updatedAt', label: 'SAVED', width: 150, render: (r) => stampDate(r.filedAt || r.updatedAt), sortValue: (r) => r.updatedAt },
  ];

  const menu = [
    { label: 'Quarterly Form &941/Schedule B...', onClick: () => void askPeriod('941') },
    { label: 'Annual Form 9&40/Schedule A...', onClick: () => void askPeriod('940') },
    { label: 'Annual Form &W-2/W-3...', onClick: () => void askPeriod('W-2') },
    { label: '&State Unemployment Report...', onClick: () => void askPeriod('STATE-UI') },
  ];

  const list = (cols: ListColumn<Row>[], data: Row[], empty: string) =>
    data.length || q.isLoading ? (
      <ListView<Row>
        aria-label="Payroll tax forms"
        columns={cols}
        rows={data}
        getKey={(r) => r.key}
        selectedKey={sel}
        onSelect={(k) => setSel(String(k))}
        onActivate={create}
        loading={q.isLoading}
        persistKey={tab === 'file' ? 'processforms' : 'processforms-hist'}
        contextMenu={(r) => (r ? [{ label: 'Open Form', onClick: () => create(r) }] : [])}
      />
    ) : (
      <EmptyState icon={Files} compact title="No forms" message={empty} action={{ label: 'Choose a form...', onClick: () => void askPeriod('941') }} />
    );

  return (
    <div className="fx-process">
      <div className="fx-process-bar">
        <span className="fx-cap">File forms for</span>
        <Select aria-label="Year" value={year} width={90} options={years.map((y) => ({ value: y, label: String(y) }))} onChange={(v) => setYear(+v)} />
        <span className="fx-muted">Forms of the periods with paychecks, with their due dates. Select a form and click Open Form.</span>
      </div>
      <div className="fx-list">
        <Tabs
          fill
          active={tab}
          onChange={(k) => setTab(k as 'file' | 'history')}
          tabs={[
            { key: 'file', label: 'Forms to File', content: list(columns, rows, `No payroll forms for ${year}: no paychecks were created in ${year}.`) },
            { key: 'history', label: `Forms Filed${history.length ? ` (${history.length})` : ''}`, content: list(historyCols, history, `No form of ${year} was saved or filed yet.`) },
          ]}
        />
      </div>
      <div className="fx-actions">
        <DropdownButton label="&Forms" items={menu} up />
        <span className="fx-muted">{cur ? `${cur.title} · due ${fmtDate(cur.dueDate)}` : ''}</span>
        <span className="fx-spacer" />
        <Button label="Close" onClick={() => void win.close()} />
        <Button variant="primary" icon={FilePlus2} label="&Open Form" disabled={!cur} onClick={() => create(cur)} />
      </div>
    </div>
  );
}

function periodEnd(r: FormFiling): string {
  if (r.period.startsWith('Q')) {
    const q = +r.period.slice(1);
    return `${r.year}-${['03-31', '06-30', '09-30', '12-31'][q - 1]}`;
  }
  return `${r.year}-12-31`;
}

function PeriodBody({
  quarterly,
  needsState,
  years,
  states,
  initial,
  close,
}: {
  quarterly: boolean;
  needsState: boolean;
  years: number[];
  states: string[];
  initial: { year: number; quarter: number; state: string };
  close: (v: { year: number; quarter: number; state: string } | null) => void;
}) {
  const [v, setV] = useState(initial);
  return (
    <div className="fx-dlg">
      <div className="fx-dlg-grid">
        <Field label="Year" htmlFor="fx-pd-year">
          <Select id="fx-pd-year" value={v.year} options={years.map((y) => ({ value: y, label: String(y) }))} onChange={(x) => setV({ ...v, year: +x })} />
        </Field>
        {quarterly && (
          <Field label="Quarter" htmlFor="fx-pd-q" hint={`Quarter ending ${fmtDate(`${v.year}-${['03-31', '06-30', '09-30', '12-31'][v.quarter - 1]}`)}`}>
            <Select id="fx-pd-q" value={v.quarter} options={[1, 2, 3, 4].map((q) => ({ value: q, label: `Q${q}` }))} onChange={(x) => setV({ ...v, quarter: +x })} />
          </Field>
        )}
        {needsState && (
          <Field label="State" htmlFor="fx-pd-state">
            <Select id="fx-pd-state" value={v.state} options={states.map((s) => ({ value: s, label: s }))} onChange={(x) => setV({ ...v, state: x })} />
          </Field>
        )}
      </div>
      <div className="sx-dlg-buttons">
        <Button variant="primary" label="OK" disabled={needsState && !v.state} onClick={() => close(v)} />
        <Button label="Cancel" onClick={() => close(null)} />
      </div>
    </div>
  );
}

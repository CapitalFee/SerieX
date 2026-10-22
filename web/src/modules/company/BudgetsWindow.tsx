// Budgets: amounts per account and month for a fiscal year (Company menu).
// Pick a budget (or create one: fiscal year, Profit and Loss or Balance Sheet, optional customer:job
// or class criteria, from scratch or from last year's actual amounts), then type the monthly amounts
// per account: ACCOUNT, ANNUAL TOTAL and the 12 fiscal months, with Copy Across, Adjust Row
// Amounts and Clear.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRightToLine, Eraser, Percent, Plus, Save, Trash2, Wand2 } from 'lucide-react';
import { api } from '@/api/client';
import { invalidateAll, queryClient, useAccounts, useCompanyInfo, usePrefValues } from '@/api/hooks';
import { BALANCE_SHEET_TYPES, PROFIT_LOSS_TYPES, type Account, type Budget, type BudgetLine, type ID, type ReportResult } from '@/api/types';
import {
  Button,
  ClassPicker,
  EmptyState,
  ErrorBanner,
  Field,
  FormErrorsProvider,
  Grid,
  MoneyField,
  NamePicker,
  RadioGroup,
  Select,
  Spinner,
  TextField,
  Toolbar,
  ToolbarButton,
  ToolSeparator,
  ToolbarSpacer,
  confirmBox,
  msgBox,
  promptBox,
  showDialog,
  toast,
  useFormErrors,
  type GridApi,
  type GridColumn,
} from '@/components';
import { FooterTotals } from '@/forms';
import { useOptionalWindow } from '@/windows/WindowContext';
import { openWindow } from '@/windows/windowStore';
import { todayIso } from '@/util/dates';
import { fmtMoney, round2 } from '@/util/format';
import { MONTHS_SHORT, fiscalYearOf, fiscalYearRange, useBudgets } from './shared';
import './company.css';

export interface BudgetsWindowProps {
  /** Budget to open. */
  id?: number;
}

interface Row {
  accountId: ID;
  name: string;
  type: Account['type'];
  level: number;
  amounts: number[];
}

const ZERO = () => Array.from({ length: 12 }, () => 0);
const INCOME = ['Income', 'Other Income'];
const BUDGET_TIP = 'Tip: type an amount and press Tab. Copy Across repeats the month you last edited for the rest of the year.';

/** Budget picker label: "FY2026 · Marketing", or just the name when it already starts with its fiscal year. */
function budgetLabel(b: Pick<Budget, 'fiscalYear' | 'name'>): string {
  const fy = `FY${b.fiscalYear}`;
  return b.name.trim().toUpperCase().startsWith(fy) ? b.name : `${fy} · ${b.name}`;
}

/** Key of a budget line's criteria ("" for none, "c<id>" class, "n<id>" customer:job). */
function critKey(l: Pick<BudgetLine, 'classId' | 'nameId'>): string {
  return l.classId ? `c${l.classId}` : l.nameId ? `n${l.nameId}` : '';
}

export default function BudgetsWindow({ id }: BudgetsWindowProps) {
  const win = useOptionalWindow();
  const info = useCompanyInfo();
  const prefs = usePrefValues();
  const fyStart = info.data?.fiscalYearStartMonth ?? 1;
  const budgets = useBudgets();
  const accounts = useAccounts();
  const [selId, setSelId] = useState<number | null>(id ?? null);
  const [budget, setBudget] = useState<Budget | null>(null);
  const [crit, setCrit] = useState<ID | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const gridApi = useRef<GridApi | null>(null);
  const lastCol = useRef<number>(0);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const budgetRef = useRef(budget);
  budgetRef.current = budget;

  // choose the newest budget at first
  useEffect(() => {
    if (selId === null && budgets.data?.length) setSelId([...budgets.data].sort((a, b) => b.fiscalYear - a.fiscalYear || b.id - a.id)[0].id);
  }, [budgets.data, selId]);
  // load the selected budget (a fresh copy to edit)
  useEffect(() => {
    if (selId === null) return;
    const b = budgets.data?.find((x) => x.id === selId);
    if (b && (!budget || budget.id !== b.id)) {
      setBudget(structuredClone(b));
      setDirty(false);
      setCrit(null);
    }
  }, [selId, budgets.data]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    win?.setDirty(dirty);
  }, [dirty]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (): Promise<boolean> => {
    const b = budgetRef.current;
    if (!b) return true;
    setSaving(true);
    try {
      const lines = b.lines.filter((l) => l.amounts.some((a) => a !== 0));
      const saved = await api.put<Budget>(`/budgets/${b.id}`, { ...b, lines });
      queryClient.setQueryData(['budgets'], (old: Budget[] | undefined) => (old ?? []).map((x) => (x.id === saved.id ? saved : x)));
      setBudget(structuredClone(saved));
      setDirty(false);
      dirtyRef.current = false;
      void invalidateAll();
      toast(`Budget "${saved.name}" saved`);
      return true;
    } catch (e) {
      await msgBox({ title: 'Budgets', icon: 'error', message: (e as Error).message });
      return false;
    } finally {
      setSaving(false);
    }
  };

  const confirmLeave = async (): Promise<boolean> => {
    if (!dirtyRef.current) return true;
    const r = await msgBox({
      title: 'Budgets',
      icon: 'question',
      message: 'You have changed this budget. Do you want to save your changes?',
      buttons: ['Yes', 'No', 'Cancel'],
    });
    if (r === 'Yes') return save();
    if (r === 'No') {
      setDirty(false);
      dirtyRef.current = false;
    }
    return r === 'No';
  };
  useEffect(() => {
    if (!win) return;
    win.setBeforeClose(confirmLeave);
    return () => win.setBeforeClose(null);
  }, [win?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // accounts shown for this budget kind
  const acctRows = useMemo(() => {
    if (!budget) return [];
    const types = budget.kind === 'pl' ? PROFIT_LOSS_TYPES : BALANCE_SHEET_TYPES;
    return (accounts.data ?? []).filter((a) => types.includes(a.type) && a.type !== 'Non-Posting');
  }, [accounts.data, budget]);

  const key = budget?.criteria === 'class' ? (crit ? `c${crit}` : '') : budget?.criteria === 'customer' ? (crit ? `n${crit}` : '') : '';
  const needCrit = !!budget && budget.criteria !== 'none' && !crit;

  const rows: Row[] = useMemo(() => {
    if (!budget) return [];
    const byAcct = new Map<ID, BudgetLine>();
    for (const l of budget.lines) if (critKey(l) === key) byAcct.set(l.accountId, l);
    // the tree shows each account's own name, with its number first when account numbers are on (as the pickers do)
    const label = (a: Account) => (prefs.useAccountNumbers && a.number ? `${a.number} · ${a.name}` : a.name);
    return acctRows.map((a) => ({ accountId: a.id, name: label(a), type: a.type, level: a.level, amounts: byAcct.get(a.id)?.amounts.slice() ?? ZERO() }));
  }, [budget, acctRows, key, prefs.useAccountNumbers]);

  const setRows = (next: Row[]) => {
    if (!budget) return;
    const shown = new Set(next.map((r) => r.accountId));
    const other = budget.lines.filter((l) => critKey(l) !== key || !shown.has(l.accountId));
    const mine: BudgetLine[] = next
      .filter((r) => r.amounts.some((a) => a !== 0) || budget.lines.some((l) => l.accountId === r.accountId && critKey(l) === key))
      .map((r) => ({
        accountId: r.accountId,
        classId: budget.criteria === 'class' ? crit : null,
        nameId: budget.criteria === 'customer' ? crit : null,
        amounts: r.amounts.map(round2),
      }));
    setBudget({ ...budget, lines: [...other, ...mine] });
    setDirty(true);
  };

  const months = useMemo(() => {
    const fy = budget?.fiscalYear ?? fiscalYearOf(todayIso(), fyStart);
    return Array.from({ length: 12 }, (_, i) => {
      const m = (fyStart - 1 + i) % 12;
      const y = fyStart - 1 + i >= 12 ? fy + 1 : fy;
      return `${MONTHS_SHORT[m]} ${String(y).slice(2)}`;
    });
  }, [budget?.fiscalYear, fyStart]);

  const columns = useMemo<GridColumn<Row>[]>(
    () => [
      {
        key: 'name',
        label: 'ACCOUNT',
        // account numbers make the names longer
        width: prefs.useAccountNumbers ? 250 : 200,
        readOnly: true,
        render: (r) => (
          <span style={{ paddingLeft: r.level * 14 }} title={`${r.name} (${r.type})`}>
            {r.name}
          </span>
        ),
      },
      {
        key: 'total',
        label: 'ANNUAL TOTAL',
        width: 116,
        align: 'right',
        readOnly: true,
        render: (r) => <b>{fmtMoney(round2(r.amounts.reduce((s, a) => s + a, 0)), { blankZero: true })}</b>,
      },
      ...months.map<GridColumn<Row>>((label, i) => ({
        key: `m${i}`,
        label: label.toUpperCase(),
        width: 82,
        align: 'right',
        editor: 'money',
        blankZero: true,
        get: (r) => r.amounts[i],
        set: (r, v: number | null) => {
          const amounts = r.amounts.slice();
          amounts[i] = round2(v ?? 0);
          return { ...r, amounts };
        },
      })),
    ],
    [months, prefs.useAccountNumbers],
  );

  const currentRow = (): number | null => gridApi.current?.currentRow() ?? null;

  const copyAcross = () => {
    const ri = currentRow();
    if (ri === null || !rows[ri]) {
      toast('Click a month amount of the account first.', { kind: 'info' });
      return;
    }
    const col = Math.max(0, lastCol.current);
    const v = rows[ri].amounts[col];
    const next = rows.slice();
    next[ri] = { ...rows[ri], amounts: rows[ri].amounts.map((a, i) => (i >= col ? v : a)) };
    setRows(next);
  };

  const adjust = async () => {
    const ri = currentRow();
    if (ri === null || !rows[ri]) {
      toast('Click a month amount of the account first.', { kind: 'info' });
      return;
    }
    const r = await showDialog<{ pct: number; from: number } | null>({
      title: 'Adjust Row Amounts',
      cancelValue: null,
      render: (close) => <AdjustForm months={months} startCol={lastCol.current} onDone={close} />,
    });
    if (!r) return;
    const next = rows.slice();
    next[ri] = { ...rows[ri], amounts: rows[ri].amounts.map((a, i) => (i >= r.from ? round2(a * (1 + r.pct / 100)) : a)) };
    setRows(next);
  };

  const clear = async () => {
    if (!(await confirmBox('Clear every amount shown in this budget? (Nothing is saved until you click Save.)', 'Clear Budget'))) return;
    setRows(rows.map((r) => ({ ...r, amounts: ZERO() })));
  };

  const fillActuals = async () => {
    if (!budget || budget.kind !== 'pl') return;
    if (rows.some((r) => r.amounts.some((a) => a !== 0)) && !(await confirmBox("Replace the amounts shown with last year's actual amounts?", 'Budgets')))
      return;
    try {
      const amounts = await actualsByAccount(
        budget.fiscalYear - 1,
        fyStart,
        budget.criteria === 'class' ? crit : null,
        budget.criteria === 'customer' ? crit : null,
      );
      setRows(rows.map((r) => ({ ...r, amounts: amounts.get(r.accountId) ?? ZERO() })));
      toast(`Filled with the actual amounts of fiscal year ${budget.fiscalYear - 1}`);
    } catch (e) {
      toast((e as Error).message, { kind: 'error' });
    }
  };

  const create = async () => {
    if (!(await confirmLeave())) return;
    const made = await showDialog<Budget | null>({
      title: 'Create New Budget',
      cancelValue: null,
      render: (close) => <CreateBudgetForm fyStart={fyStart} classes={prefs.useClassTracking} existing={budgets.data ?? []} onDone={close} />,
    });
    if (made) {
      await queryClient.invalidateQueries({ queryKey: ['budgets'] });
      setBudget(structuredClone(made));
      setSelId(made.id);
      setDirty(false);
      setCrit(null);
      toast(`Budget "${made.name}" created`);
    }
  };

  const rename = async () => {
    if (!budget) return;
    const n = await promptBox('New name of the budget:', { defaultValue: budget.name, title: 'Rename Budget' });
    if (n === null || !n.trim() || n.trim() === budget.name) return;
    setBudget({ ...budget, name: n.trim() });
    setDirty(true);
  };

  const remove = async () => {
    if (!budget) return;
    if (!(await confirmBox(`Delete the budget "${budget.name}"? This cannot be undone.`, 'Delete Budget'))) return;
    try {
      await api.del(`/budgets/${budget.id}`);
      setDirty(false);
      setBudget(null);
      setSelId(null);
      await queryClient.invalidateQueries({ queryKey: ['budgets'] });
      void invalidateAll();
      toast('Budget deleted', { kind: 'info' });
    } catch (e) {
      await msgBox({ title: 'Delete Budget', icon: 'error', message: (e as Error).message });
    }
  };

  const pick = async (v: string) => {
    const next = Number(v);
    if (next === budget?.id || !(await confirmLeave())) return;
    const b = budgets.data?.find((x) => x.id === next);
    setBudget(b ? structuredClone(b) : null);
    setDirty(false);
    setCrit(null);
    setSelId(next);
  };

  // annual totals (P&L: income, expenses, net)
  const sum = (filter: (r: Row) => boolean) => round2(rows.filter(filter).reduce((s, r) => s + r.amounts.reduce((a, b) => a + b, 0), 0));
  const income = sum((r) => INCOME.includes(r.type));
  const expenses = sum((r) => !INCOME.includes(r.type));

  const list = [...(budgets.data ?? [])].sort((a, b) => b.fiscalYear - a.fiscalYear || a.name.localeCompare(b.name));

  if (budgets.isLoading) {
    return (
      <div className="cx-budgets" style={{ display: 'grid', placeItems: 'center' }}>
        <Spinner label="Loading budgets..." />
      </div>
    );
  }

  return (
    <div className="cx-budgets">
      <Toolbar>
        <span className="cx-muted" style={{ margin: '0 6px 0 4px' }}>
          Budget
        </span>
        <Select
          value={selId ?? ''}
          width={280}
          onChange={(v) => void pick(v)}
          aria-label="Budget"
          options={list.length ? list.map((b) => ({ value: b.id, label: budgetLabel(b) })) : [{ value: '', label: 'No budgets yet' }]}
        />
        <ToolbarButton label="Create New Budget" icon={Plus} onClick={() => void create()} />
        <ToolSeparator />
        <ToolbarButton label="Rename" onClick={() => void rename()} disabled={!budget} />
        <ToolbarButton label="Delete" icon={Trash2} onClick={() => void remove()} disabled={!budget} />
        <ToolbarSpacer />
        {budget && (
          <ToolbarButton
            label="Budget vs. Actual"
            onClick={() =>
              openWindow('report', { key: 'budget_vs_actual', params: { budgetId: String(budget.id), ...fiscalYearRange(budget.fiscalYear, fyStart) } })
            }
          />
        )}
      </Toolbar>
      {!budget ? (
        <EmptyState
          icon={Wand2}
          title="No budget yet"
          message="A budget sets the amount you expect for each income and expense account, month by month. Compare it with what really happened in the Budget vs. Actual report."
          action={{ label: 'Create New Budget', onClick: () => void create() }}
        />
      ) : (
        <>
          <div className="cx-budget-head">
            <div>
              <div className="cx-h2" style={{ margin: 0 }}>
                {budget.name}
              </div>
              <div className="cx-muted cx-small">
                Fiscal year {budget.fiscalYear} · {budget.kind === 'pl' ? 'Profit and Loss' : 'Balance Sheet'}
                {budget.criteria === 'class' ? ' by class' : budget.criteria === 'customer' ? ' by customer or job' : ''}
              </div>
            </div>
            {budget.criteria === 'class' && (
              <Field label="Current class" width={240}>
                <ClassPicker value={crit} onChange={(v) => setCrit(v)} addNew={false} placeholder="Choose a class" />
              </Field>
            )}
            {budget.criteria === 'customer' && (
              <Field label="Current customer or job" width={260}>
                <NamePicker kinds={['customer']} value={crit} onChange={(v) => setCrit(v)} addNew={false} placeholder="Choose a customer or job" />
              </Field>
            )}
            <span className="cx-spacer" />
            <div className="cx-row" style={{ alignSelf: 'flex-end' }}>
              {budget.kind === 'pl' && (
                <Button
                  size="sm"
                  icon={Wand2}
                  label="Fill from last year"
                  disabled={needCrit}
                  onClick={() => void fillActuals()}
                  title={`Use the actual amounts of fiscal year ${budget.fiscalYear - 1}`}
                />
              )}
              <Button
                size="sm"
                icon={ArrowRightToLine}
                label="Copy Across"
                disabled={needCrit}
                onClick={copyAcross}
                title="Copy the amount of the selected month to the following months of that account"
              />
              <Button size="sm" icon={Percent} label="Adjust Row Amounts..." disabled={needCrit} onClick={() => void adjust()} />
              <Button size="sm" icon={Eraser} label="Clear" disabled={needCrit} onClick={() => void clear()} />
            </div>
          </div>
          <div className="cx-budget-grid">
            {needCrit ? (
              <EmptyState
                compact
                title={`Choose a ${budget.criteria === 'class' ? 'class' : 'customer or job'}`}
                message="This budget has separate amounts for each one. Choose which one to see above."
              />
            ) : (
              <Grid<Row>
                aria-label="Budget amounts"
                columns={columns}
                rows={rows}
                onChange={setRows}
                newRow={() => ({ accountId: 0, name: '', type: 'Expense', level: 0, amounts: ZERO() })}
                allowAdd={false}
                allowInsertDelete={false}
                minRows={10}
                enterMoves="down"
                apiRef={gridApi}
                onRowChange={(next, _prev, k) => {
                  const m = /^m(\d+)$/.exec(k);
                  if (m) lastCol.current = Number(m[1]);
                  return next;
                }}
                persistKey="budget"
              />
            )}
          </div>
          <div className="cx-budget-foot">
            <span className="cx-muted cx-small" title={BUDGET_TIP}>
              {BUDGET_TIP}
            </span>
            {budget.kind === 'pl' && (
              <FooterTotals
                totals={[
                  { key: 'i', label: 'Income', value: income },
                  { key: 'e', label: 'Expenses', value: expenses },
                  { key: 'n', label: 'Net income', value: round2(income - expenses), strong: true, tone: income - expenses < 0 ? 'danger' : undefined },
                ]}
              />
            )}
            <Button
              label="Revert"
              disabled={!dirty || saving}
              onClick={() => {
                const b = budgets.data?.find((x) => x.id === budget.id);
                if (b) setBudget(structuredClone(b));
                setDirty(false);
              }}
            />
            <Button icon={Save} label="Save" disabled={!dirty} busy={saving} onClick={() => void save()} />
            <Button
              variant="primary"
              label="Save and close"
              busy={saving}
              onClick={() => {
                void (async () => {
                  if (!dirtyRef.current || (await save())) await win?.close(true);
                })();
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}

/** Actual monthly amounts per P&L account for fiscal year fy (natural sign, from the P&L report). */
async function actualsByAccount(fy: number, fyStart: number, classId: ID | null, nameId: ID | null): Promise<Map<ID, number[]>> {
  const { from, to } = fiscalYearRange(fy, fyStart);
  const params = new URLSearchParams({ from, to, columns: 'month', basis: 'accrual' });
  if (classId) params.set('classIds', String(classId));
  if (nameId) {
    params.set('nameIds', String(nameId));
    params.set('includeJobs', '1');
  }
  const r = await api.get<ReportResult>(`/reports/profit_loss?${params.toString()}`);
  const out = new Map<ID, number[]>();
  for (const row of r.rows) {
    if (row.kind !== 'data') continue;
    const ids = row.drill?.params?.accountIds;
    if (!ids || ids.includes(',')) continue;
    const amounts = ZERO().map((_, i) => {
      const v = row.cells[`p${i}`];
      return typeof v === 'number' ? round2(v) : 0;
    });
    out.set(Number(ids), amounts);
  }
  return out;
}

function AdjustForm({ months, startCol, onDone }: { months: string[]; startCol: number; onDone: (r: { pct: number; from: number } | null) => void }) {
  const [pct, setPct] = useState<number | null>(10);
  const [from, setFrom] = useState(0);
  const [dir, setDir] = useState<'up' | 'down'>('up');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onDone({ pct: (dir === 'up' ? 1 : -1) * Math.abs(pct ?? 0), from });
      }}
    >
      <div className="cx-userform" style={{ width: 380 }}>
        <Field label="Start at">
          <RadioGroup<number>
            value={from}
            onChange={setFrom}
            options={[
              { value: 0, label: `The first month (${months[0]})` },
              ...(startCol > 0 ? [{ value: startCol, label: `The month you last edited (${months[startCol]})` }] : []),
            ]}
          />
        </Field>
        <div className="cx-row" style={{ gap: 8 }}>
          <Select
            value={dir}
            onChange={(v) => setDir(v as 'up' | 'down')}
            width={170}
            options={[
              { value: 'up', label: 'Increase each month by' },
              { value: 'down', label: 'Decrease each month by' },
            ]}
            aria-label="Increase or decrease"
          />
          <MoneyField value={pct} nullable width={80} onChange={setPct} aria-label="Percent" autoFocus />
          <span>%</span>
        </div>
      </div>
      <div className="sx-dlg-buttons">
        <button type="submit" className="sx-btn sx-btn-primary">
          OK
        </button>
        <button type="button" className="sx-btn sx-btn-secondary" onClick={() => onDone(null)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function CreateBudgetForm({
  fyStart,
  classes,
  existing,
  onDone,
}: {
  fyStart: number;
  classes: boolean;
  existing: Budget[];
  onDone: (b: Budget | null) => void;
}) {
  const fe = useFormErrors();
  const cur = fiscalYearOf(todayIso(), fyStart);
  const [fy, setFy] = useState(existing.some((b) => b.fiscalYear === cur && b.kind === 'pl') ? cur + 1 : cur);
  const [kind, setKind] = useState<'pl' | 'bs'>('pl');
  const [criteria, setCriteria] = useState<'none' | 'class' | 'customer'>('none');
  const [start, setStart] = useState<'scratch' | 'actuals'>('scratch');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLFormElement>(null);
  const defName = `FY${fy} ${kind === 'pl' ? 'Profit and Loss' : 'Balance Sheet'}${criteria === 'class' ? ' by Class' : criteria === 'customer' ? ' by Customer' : ''}`;

  const submit = async () => {
    fe.clearAll();
    setBusy(true);
    try {
      let lines: BudgetLine[] = [];
      if (kind === 'pl' && criteria === 'none' && start === 'actuals') {
        const m = await actualsByAccount(fy - 1, fyStart, null, null);
        lines = [...m.entries()].filter(([, a]) => a.some((x) => x !== 0)).map(([accountId, amounts]) => ({ accountId, classId: null, nameId: null, amounts }));
      }
      const b = await api.post<Budget>('/budgets', { id: 0, name: name.trim() || defName, fiscalYear: fy, kind, criteria, lines });
      onDone(b);
    } catch (e) {
      fe.fromError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormErrorsProvider value={fe}>
      <form
        ref={root}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="cx-userform" style={{ width: 460 }}>
          {fe.message && <ErrorBanner message={fe.message} root={root.current} onDismiss={() => fe.setMessage(null)} />}
          <div className="cx-row" style={{ gap: 12, alignItems: 'flex-start' }}>
            <Field label="Fiscal year" width={130}>
              <Select
                name="fiscalYear"
                value={fy}
                onChange={(v) => setFy(Number(v))}
                options={[cur - 1, cur, cur + 1, cur + 2].map((y) => ({ value: y, label: `FY${y}` }))}
              />
            </Field>
            <Field label="Name" width={290}>
              <TextField name="name" value={name} onChange={setName} placeholder={defName} autoFocus />
            </Field>
          </div>
          <Field label="Budget type">
            <RadioGroup<'pl' | 'bs'>
              row
              value={kind}
              onChange={(v) => {
                setKind(v);
                if (v === 'bs') setStart('scratch');
              }}
              options={[
                { value: 'pl', label: 'Profit and Loss' },
                { value: 'bs', label: 'Balance Sheet' },
              ]}
            />
          </Field>
          <Field label="Additional criteria">
            <RadioGroup<'none' | 'class' | 'customer'>
              row
              value={criteria}
              onChange={(v) => {
                setCriteria(v);
                if (v !== 'none') setStart('scratch');
              }}
              options={[
                { value: 'none', label: 'None' },
                { value: 'customer', label: 'Customer or Job' },
                ...(classes ? [{ value: 'class' as const, label: 'Class' }] : []),
              ]}
            />
          </Field>
          {kind === 'pl' && criteria === 'none' && (
            <Field label="Start with">
              <RadioGroup<'scratch' | 'actuals'>
                value={start}
                onChange={setStart}
                options={[
                  { value: 'scratch', label: 'An empty budget (create it from scratch)' },
                  { value: 'actuals', label: `Last year's actual amounts (FY${fy - 1})` },
                ]}
              />
            </Field>
          )}
        </div>
        <div className="sx-dlg-buttons">
          <button type="submit" className="sx-btn sx-btn-primary" disabled={busy}>
            {busy ? 'Creating...' : 'Create'}
          </button>
          <button type="button" className="sx-btn sx-btn-secondary" onClick={() => onDone(null)}>
            Cancel
          </button>
        </div>
      </form>
    </FormErrorsProvider>
  );
}

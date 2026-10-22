// Filter bar of the report window: report period + From/To (or As of), accounting
// method, display columns by, compare to, aging interval, required record pickers, report
// specific choices (rows by, total by, sort by).
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowDownWideNarrow, ArrowUpNarrowWide } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import type { Budget, ReportColumn, ReportInfo } from '@/api/types';
import { api } from '@/api/client';
import { usePrefValues, useReportsCatalog } from '@/api/hooks';
import { AccountPicker, ClassPicker, DateField, HelpTip, ItemPicker, NamePicker, NumberField, SegmentedControl, Select } from '@/components';
import { DATE_PRESETS_WITH_CUSTOM } from '@/util/dates';
import { REQUIRED_ID, ROWS_BY, TOTAL_BY, columnOptions, compareOptions, defaultColumns, hasParam } from './reportMeta';
import type { ParamPatch } from './CustomizePanel';

/** Props of {@link FilterBar}. */
export interface FilterBarProps {
  info: ReportInfo;
  rp: Record<string, string>;
  setRp: (patch: ParamPatch, opts?: { debounce?: boolean }) => void;
  /** Dates shown in the fields (server echo, or the client resolution while loading). */
  shown: { preset: string; from: string; to: string; asOf: string; basis: string; columns: string; budgetId: string };
  /** Switches the report (Compare to). */
  onSwitchReport: (key: string) => void;
  /** Sort of flat reports (null when the report cannot be sorted). */
  sort: { value: string; columns: ReportColumn[]; onChange: (s: string) => void } | null;
}

function F({ label, children, className, help }: { label: string; children: ReactNode; className?: string; help?: ReactNode }) {
  return (
    <div className={'rpt-f' + (className ? ' ' + className : '')}>
      <span className="rpt-f-label">
        {label}
        {help && <HelpTip text={help} title={label.charAt(0) + label.slice(1).toLowerCase()} size={13} />}
      </span>
      <div className="rpt-f-ctl">{children}</div>
    </div>
  );
}

/** Budgets for the budget reports' picker. */
function useBudgets(enabled: boolean) {
  return useQuery({
    queryKey: ['budgets'],
    queryFn: ({ signal }) => api.get<Budget[]>('/budgets', { signal }),
    enabled,
  });
}

/** A date field that keeps the typed value while the report reloads. */
function DateBox({ value, onChange, name, label }: { value: string; onChange: (v: string) => void; name: string; label: string }) {
  const [v, setV] = useState(value);
  const last = useRef(value);
  useEffect(() => {
    if (value !== last.current) {
      last.current = value;
      setV(value);
    }
  }, [value]);
  return (
    <DateField
      name={name}
      aria-label={label}
      width={124}
      hideErrorMessage
      value={v}
      onChange={(iso) => {
        setV(iso);
        onChange(iso);
      }}
    />
  );
}

export function FilterBar({ info, rp, setRp, shown, onSwitchReport, sort }: FilterBarProps) {
  const prefs = usePrefValues();
  const { data: catalog } = useReportsCatalog();
  const isBudget = hasParam(info, 'budgetId');
  const { data: budgets } = useBudgets(isBudget);
  const colOpts = columnOptions(info, prefs, rp);
  const cmpOpts = compareOptions(info.key, catalog);
  const hasDates = hasParam(info, 'dates') || hasParam(info, 'asOf');
  const asOfOnly = hasParam(info, 'asOf') && !hasParam(info, 'dates') && (!colOpts || shown.columns === 'total' || !shown.columns);
  const required = REQUIRED_ID[info.key];
  const budget = useMemo(() => budgets?.find((b) => String(b.id) === shown.budgetId), [budgets, shown.budgetId]);

  const fields: ReactNode[] = [];

  if (hasDates) {
    fields.push(
      <F key="preset" label={asOfOnly ? 'Report date' : 'Report period'}>
        <Select
          name="dates"
          width={196}
          value={shown.preset}
          aria-label="Report period"
          options={DATE_PRESETS_WITH_CUSTOM.map((p) => ({ value: p.key, label: p.label }))}
          onChange={(v) => {
            if (v === 'custom')
              setRp(asOfOnly ? { dates: 'custom', asOf: shown.asOf, to: shown.asOf, from: undefined } : { dates: 'custom', from: shown.from, to: shown.to, asOf: undefined });
            else setRp({ dates: v, from: undefined, to: undefined, asOf: undefined });
          }}
        />
      </F>,
    );
    if (asOfOnly) {
      fields.push(
        <F key="asOf" label="As of">
          <DateBox name="asOf" label="As of" value={shown.asOf} onChange={(v) => v && setRp({ dates: 'custom', asOf: v, to: v, from: undefined }, { debounce: true })} />
        </F>,
      );
    } else {
      fields.push(
        <F key="from" label="From">
          <DateBox
            name="from"
            label="From"
            value={shown.from}
            onChange={(v) => setRp({ dates: 'custom', from: v || '', to: shown.to, asOf: hasParam(info, 'asOf') ? shown.to : undefined }, { debounce: true })}
          />
        </F>,
        <F key="to" label="To">
          <DateBox
            name="to"
            label="To"
            value={shown.to}
            onChange={(v) => v && setRp({ dates: 'custom', from: shown.from, to: v, asOf: hasParam(info, 'asOf') ? v : undefined }, { debounce: true })}
          />
        </F>,
      );
    }
  }

  if (hasParam(info, 'basis')) {
    fields.push(
      <F
        key="basis"
        label="Accounting method"
        help="Accrual counts income when you invoice and expenses when you enter a bill. Cash counts income when you are paid and expenses when you pay."
      >
        <SegmentedControl
          size="sm"
          name="basis"
          aria-label="Accounting method"
          value={shown.basis === 'cash' ? 'cash' : 'accrual'}
          onChange={(v) => setRp({ basis: v })}
          options={[
            { value: 'accrual', label: 'Accrual', title: 'Income when you invoice, expenses when you get the bill' },
            { value: 'cash', label: 'Cash', title: 'Income when you are paid, expenses when you pay' },
          ]}
        />
      </F>,
    );
  }

  if (colOpts) {
    fields.push(
      <F key="columns" label="Display columns by">
        <Select
          name="columns"
          width={136}
          value={shown.columns || defaultColumns(info.key)}
          aria-label="Display columns by"
          options={colOpts}
          onChange={(v) => setRp({ columns: v === defaultColumns(info.key) ? undefined : v })}
        />
      </F>,
    );
  }

  if (cmpOpts) {
    fields.push(
      <F
        key="compare"
        label="Compare to"
        help={
          cmpOpts.some((o) => o.value.endsWith('_prev_period'))
            ? 'Adds columns that compare this report with the period just before it, the same period a year earlier, or the year to date.'
            : 'Adds columns that compare this report with the same period a year earlier, or with the year to date.'
        }
      >
        <Select name="compare" width={176} value={info.key} aria-label="Compare to" options={cmpOpts} onChange={onSwitchReport} />
      </F>,
    );
  }

  if (hasParam(info, 'agingInterval')) {
    fields.push(
      <F key="ai" label="Days per aging period" help="How many days each aging column covers, counted from the due date (for example 1 - 30, 31 - 60).">
        <NumberField
          name="agingInterval"
          width={70}
          value={rp.agingInterval ? Number(rp.agingInterval) : 30}
          onChange={(v) => setRp({ agingInterval: v && v > 0 ? String(Math.round(v)) : undefined })}
          aria-label="Days per aging period"
        />
      </F>,
      <F key="at" label="Through (days past due)">
        <NumberField
          name="agingThrough"
          width={70}
          value={rp.agingThrough ? Number(rp.agingThrough) : 90}
          onChange={(v) => setRp({ agingThrough: v && v > 0 ? String(Math.round(v)) : undefined })}
          aria-label="Through days past due"
        />
      </F>,
    );
  }

  if (isBudget) {
    fields.push(
      <F key="budget" label="Budget">
        <Select
          name="budgetId"
          width={200}
          value={shown.budgetId}
          aria-label="Budget"
          options={budgets?.length ? budgets.map((b) => ({ value: String(b.id), label: b.name })) : [{ value: '', label: 'No budgets yet' }]}
          onChange={(v) => setRp({ budgetId: v || undefined, classId: undefined, nameId: undefined })}
        />
      </F>,
    );
    if (budget?.criteria === 'class') {
      fields.push(
        <F key="cls" label="Class">
          <ClassPicker
            name="classId"
            width={170}
            addNew={false}
            value={rp.classId ? Number(rp.classId) : null}
            placeholder="All classes"
            onChange={(id) => setRp({ classId: id ? String(id) : undefined })}
          />
        </F>,
      );
    }
    if (budget?.criteria === 'customer') {
      fields.push(
        <F key="cust" label="Customer or Job">
          <NamePicker
            name="nameId"
            kinds={['customer']}
            width={200}
            addNew={false}
            value={rp.nameId ? Number(rp.nameId) : null}
            placeholder="All customers"
            onChange={(id) => setRp({ nameId: id ? String(id) : undefined })}
          />
        </F>,
      );
    }
  }

  if (hasParam(info, 'accountId')) {
    const bankOnly = info.key === 'missing_checks';
    fields.push(
      <F key="acct" label={bankOnly ? 'Bank account' : 'Account'} className={required === 'accountId' && !rp.accountId ? 'rpt-f-need' : ''}>
        <AccountPicker
          name="accountId"
          width={230}
          addNew={false}
          types={bankOnly ? ['Bank', 'Credit Card'] : undefined}
          value={rp.accountId ? Number(rp.accountId) : null}
          placeholder={bankOnly ? 'All bank accounts' : 'Choose an account'}
          onChange={(id) => setRp({ accountId: id ? String(id) : undefined })}
        />
      </F>,
    );
  }
  if (hasParam(info, 'nameId') && !isBudget) {
    fields.push(
      <F key="name" label="Name" className={required === 'nameId' && !rp.nameId ? 'rpt-f-need' : ''}>
        <NamePicker
          name="nameId"
          width={230}
          addNew={false}
          value={rp.nameId ? Number(rp.nameId) : null}
          placeholder="Choose a name"
          onChange={(id) => setRp({ nameId: id ? String(id) : undefined })}
        />
      </F>,
    );
  }
  if (hasParam(info, 'itemId')) {
    fields.push(
      <F key="item" label="Item" className={required === 'itemId' && !rp.itemId ? 'rpt-f-need' : ''}>
        <ItemPicker
          name="itemId"
          width={220}
          addNew={false}
          compact
          types={info.key === 'inventory_valuation_detail' ? ['Inventory Part'] : undefined}
          value={rp.itemId ? Number(rp.itemId) : null}
          placeholder={required === 'itemId' ? 'Choose an item' : 'All items'}
          onChange={(id) => setRp({ itemId: id ? String(id) : undefined })}
        />
      </F>,
    );
  }
  if (info.key === 'custom_summary') {
    fields.push(
      <F key="rows" label="Rows by">
        <Select
          name="rows"
          width={130}
          value={rp.rows || 'account'}
          aria-label="Rows by"
          options={ROWS_BY}
          onChange={(v) =>
            setRp({ rows: v === 'account' ? undefined : v, columns: v === 'account' ? rp.columns : ['class', 'customer'].includes(rp.columns ?? '') ? undefined : rp.columns })
          }
        />
      </F>,
    );
  }
  if (info.key === 'custom_transaction_detail') {
    fields.push(
      <F key="totalBy" label="Total by">
        <Select
          name="totalBy"
          width={140}
          value={rp.totalBy || 'account'}
          aria-label="Total by"
          options={TOTAL_BY}
          onChange={(v) => setRp({ totalBy: v === 'account' ? undefined : v })}
        />
      </F>,
    );
  }
  if (sort) {
    const desc = sort.value.startsWith('-');
    const key = sort.value.replace(/^-/, '');
    fields.push(
      <F key="sort" label="Sort by">
        <div className="rpt-f-sort">
          <Select
            name="sort"
            width={130}
            value={key}
            aria-label="Sort by"
            options={[{ value: '', label: 'Default' }, ...sort.columns.filter((c) => c.label).map((c) => ({ value: c.key, label: c.label }))]}
            onChange={(v) => sort.onChange(v ? (desc ? '-' + v : v) : '')}
          />
          <button
            type="button"
            className="sx-iconbtn rpt-f-dir"
            disabled={!key}
            title={desc ? 'Descending (click for ascending)' : 'Ascending (click for descending)'}
            aria-label={desc ? 'Sort descending' : 'Sort ascending'}
            onClick={() => sort.onChange(desc ? key : '-' + key)}
          >
            {desc ? <ArrowDownWideNarrow size={15} /> : <ArrowUpNarrowWide size={15} />}
          </button>
        </div>
      </F>,
    );
  }

  if (!fields.length) return null;
  return (
    <div className="rpt-filterbar" role="group" aria-label="Report options">
      {fields}
    </div>
  );
}

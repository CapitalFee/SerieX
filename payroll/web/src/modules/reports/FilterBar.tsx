// Filter bar of the report window (ported from the SerieX Books report viewer, payroll
// parameters): report period + From/To (or As of), Show columns, Employee, Payroll item, State,
// tax form year/quarter, active filter, voided and hand-changed lines, and the sort of flat lists.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowDownWideNarrow, ArrowUpNarrowWide } from 'lucide-react';
import type { ReportColumn, ReportInfo } from '@/api/types';
import { useMeta } from '@/api/hooks';
import { Checkbox, DateField, EmployeePicker, HelpTip, PayrollItemPicker, Select, StatePicker } from '@/components';
import { DATE_PRESETS_WITH_CUSTOM } from '@/util/dates';
import { columnOptions, defaultColumns, hasParam, payrollPresetLabel } from './reportMeta';
import type { ParamPatch } from './CustomizePanel';

/** Props of {@link FilterBar}. */
export interface FilterBarProps {
  info: ReportInfo;
  rp: Record<string, string>;
  setRp: (patch: ParamPatch, opts?: { debounce?: boolean }) => void;
  /** Values shown in the fields (server echo, or the client resolution while loading). */
  shown: { preset: string; from: string; to: string; asOf: string; columns: string; year: string; quarter: string };
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

const PRESETS = DATE_PRESETS_WITH_CUSTOM.map((p) => ({ value: p.key, label: payrollPresetLabel(p.label) }));

export function FilterBar({ info, rp, setRp, shown, sort }: FilterBarProps) {
  const meta = useMeta().data;
  const colOpts = columnOptions(info);
  const hasDates = hasParam(info, 'dates') || hasParam(info, 'asOf');
  const asOfOnly = hasParam(info, 'asOf') && !hasParam(info, 'dates');
  const years = useMemo(() => {
    const now = new Date().getFullYear();
    const ys = new Set<number>([now - 2, now - 1, now, now + 1, ...(meta?.taxYears ?? [])]);
    if (shown.year) ys.add(Number(shown.year));
    return Array.from(ys)
      .filter((y) => y > 1999)
      .sort((a, b) => b - a);
  }, [meta, shown.year]);

  const fields: ReactNode[] = [];

  if (hasDates) {
    fields.push(
      <F key="preset" label={asOfOnly ? 'Report date' : 'Report period'}>
        <Select
          name="dates"
          width={206}
          value={shown.preset}
          aria-label="Report period"
          options={PRESETS}
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
          <DateBox name="from" label="From" value={shown.from} onChange={(v) => setRp({ dates: 'custom', from: v || '', to: shown.to, asOf: undefined }, { debounce: true })} />
        </F>,
        <F key="to" label="To">
          <DateBox name="to" label="To" value={shown.to} onChange={(v) => v && setRp({ dates: 'custom', from: shown.from, to: v, asOf: undefined }, { debounce: true })} />
        </F>,
      );
    }
  }

  if (hasParam(info, 'year')) {
    fields.push(
      <F key="year" label="Year">
        <Select name="year" width={90} value={shown.year} aria-label="Year" options={years.map((y) => ({ value: String(y), label: String(y) }))} onChange={(v) => setRp({ year: v })} />
      </F>,
    );
  }
  if (hasParam(info, 'quarter')) {
    fields.push(
      <F key="quarter" label="Quarter">
        <Select
          name="quarter"
          width={150}
          value={shown.quarter}
          aria-label="Quarter"
          options={[1, 2, 3, 4].map((q) => ({ value: String(q), label: `Q${q} (${['Jan - Mar', 'Apr - Jun', 'Jul - Sep', 'Oct - Dec'][q - 1]})` }))}
          onChange={(v) => setRp({ quarter: v })}
        />
      </F>,
    );
  }

  if (colOpts) {
    fields.push(
      <F key="columns" label="Show columns">
        <Select
          name="columns"
          width={130}
          value={shown.columns || defaultColumns(info.key)}
          aria-label="Show columns"
          options={colOpts}
          onChange={(v) => setRp({ columns: v === defaultColumns(info.key) ? undefined : v })}
        />
      </F>,
    );
  }

  if (hasParam(info, 'employeeId')) {
    fields.push(
      <F key="emp" label="Employee">
        <EmployeePicker
          name="employeeId"
          width={210}
          showRecent={false}
          value={rp.employeeId ? Number(rp.employeeId) : null}
          placeholder="All employees"
          aria-label="Employee"
          onChange={(id) => setRp({ employeeId: id ? String(id) : undefined })}
        />
      </F>,
    );
  }
  if (hasParam(info, 'itemId')) {
    fields.push(
      <F key="item" label="Payroll item">
        <PayrollItemPicker
          name="itemId"
          width={210}
          addNew={false}
          showRecent={false}
          value={rp.itemId ? Number(rp.itemId) : null}
          placeholder="All payroll items"
          aria-label="Payroll item"
          onChange={(id) => setRp({ itemId: id ? String(id) : undefined })}
        />
      </F>,
    );
  }
  if (hasParam(info, 'state')) {
    fields.push(
      <F key="state" label="State">
        <StatePicker name="state" width={90} value={rp.state ?? ''} placeholder="All" aria-label="State" onChange={(code) => setRp({ state: code || undefined })} />
      </F>,
    );
  }
  if (hasParam(info, 'active')) {
    fields.push(
      <F key="active" label="Show">
        <Select
          name="active"
          width={150}
          value={rp.active || 'active'}
          aria-label="Show"
          options={
            info.key === 'payroll_item_listing'
              ? [
                  { value: 'active', label: 'Active items' },
                  { value: 'all', label: 'All items' },
                  { value: 'inactive', label: 'Inactive items' },
                ]
              : [
                  { value: 'active', label: 'Active employees' },
                  { value: 'all', label: 'All employees' },
                  { value: 'inactive', label: 'Released employees' },
                ]
          }
          onChange={(v) => setRp({ active: v === 'active' ? undefined : v })}
        />
      </F>,
    );
  }
  if (hasParam(info, 'includeVoided')) {
    fields.push(
      <F key="voided" label="Voided">
        <Checkbox
          name="includeVoided"
          checked={rp.includeVoided === '1'}
          onChange={(v) => setRp({ includeVoided: v ? '1' : undefined })}
          label="Include voided"
          title="List voided paychecks and tax payments (their amounts are zero)"
        />
      </F>,
    );
  }
  if (hasParam(info, 'differences')) {
    fields.push(
      <F key="diff" label="Lines">
        <Checkbox
          name="differences"
          checked={rp.differences === '1'}
          onChange={(v) => setRp({ differences: v ? '1' : undefined })}
          label="Only amounts changed by hand"
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

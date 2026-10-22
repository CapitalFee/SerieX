// Filing period controls of the tax form windows (Year, Quarter, State) and switching the period
// of an open form window (another open window of that period is focused instead).
import { useEffect, useMemo, useState } from 'react';
import { useFilings, useMeta } from '@/api/hooks';
import { Select, confirmBox } from '@/components';
import { useWindow } from '@/windows/WindowContext';
import { defaultTitle, windowKey } from '@/windows/registry';
import { focusWindow, useWindowStore } from '@/windows/windowStore';
import type { WindowKind } from '@/windows/kinds';
import { fmtDate, localIso } from '@/util/format';

/** A server timestamp (UTC) as a local MM/DD/YYYY date. */
export function stampDate(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? fmtDate((ts ?? '').slice(0, 10)) : fmtDate(localIso(d));
}

export interface Period {
  year: number;
  quarter?: number;
  state?: string;
}

/** Years offered by the period controls (tax years, years with forms, this year). */
export function useFormYears(extra: number[] = []): number[] {
  const { data: meta } = useMeta();
  const { data: filings } = useFilings();
  return useMemo(() => {
    const set = new Set<number>([new Date().getFullYear(), ...extra.filter(Boolean)]);
    (meta?.taxYears ?? []).forEach((y) => set.add(y));
    (filings ?? []).forEach((f) => set.add(f.year));
    return [...set].sort((a, b) => b - a);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta, filings, extra.join(',')]);
}

/** The period shown by a form window; `change` switches it (asking first when the form has unsaved changes). */
export function usePeriodSwitch(kind: WindowKind, initial: Period) {
  const win = useWindow();
  const [period, setPeriod] = useState<Period>(initial);
  // the window may be opened again with other props (menus): follow them
  useEffect(() => {
    setPeriod(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial.year, initial.quarter, initial.state]);
  useEffect(() => {
    win.setTitle(defaultTitle(kind, period));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period.year, period.quarter, period.state]);
  const change = async (next: Period) => {
    if (next.year === period.year && next.quarter === period.quarter && next.state === period.state) return;
    const key = windowKey(kind, next);
    const other = useWindowStore.getState().windows.find((w) => w.key === key && w.id !== win.id);
    if (other) {
      focusWindow(other.id);
      return;
    }
    const me = useWindowStore.getState().windows.find((w) => w.id === win.id);
    if (me?.dirty && !(await confirmBox('This form has unsaved changes. Show another period and discard them?', 'Payroll Tax Form'))) return;
    win.setDirty(false);
    win.setKeyProps(next);
    setPeriod(next);
  };
  return { period, change };
}

export function YearSelect({ value, years, onChange }: { value: number; years: number[]; onChange: (y: number) => void }) {
  return (
    <span className="fx-period">
      <span className="sx-label">YEAR</span>
      <Select aria-label="Year" value={value} width={84} options={years.map((y) => ({ value: y, label: String(y) }))} onChange={(v) => onChange(+v)} />
    </span>
  );
}

export function QuarterSelect({ value, onChange }: { value: number; onChange: (q: number) => void }) {
  return (
    <span className="fx-period">
      <span className="sx-label">QUARTER</span>
      <Select
        aria-label="Quarter"
        value={value}
        width={150}
        options={[1, 2, 3, 4].map((q) => ({ value: q, label: `Q${q} (${['Jan-Mar', 'Apr-Jun', 'Jul-Sep', 'Oct-Dec'][q - 1]})` }))}
        onChange={(v) => onChange(+v)}
      />
    </span>
  );
}

export function StateSelect({ value, states, onChange }: { value: string; states: string[]; onChange: (s: string) => void }) {
  return (
    <span className="fx-period">
      <span className="sx-label">STATE</span>
      <Select aria-label="State" value={value} width={76} options={[...(value ? [] : [{ value: '', label: '—' }]), ...states.map((s) => ({ value: s, label: s }))]} onChange={(v) => onChange(v)} />
    </span>
  );
}

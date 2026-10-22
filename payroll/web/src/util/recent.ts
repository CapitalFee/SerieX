// Recently opened / saved payroll records and recently picked list entries (per company,
// kept in localStorage under "sxp."). Same design as SerieX Books' util/recent.ts.
// The shell reads the records for the "+ New" panel and the search box; the paycheck,
// tax payment and adjustment windows call recordRecent() after opening or saving a record
// (and forgetRecent() after deleting it).
import { useEffect, useState } from 'react';
import { getCompanyId } from '@/api/client';
import type { RecordKind } from '@/windows/windowStore';

/** One recent payroll record. */
export interface RecentRecord {
  kind: Extract<RecordKind, 'paycheck' | 'liability_payment' | 'adjustment'>;
  id: number;
  /** Check number ("1001", "DD12") or ''. */
  number: string;
  /** Employee or agency name. */
  name: string;
  amount: number;
  date: string;
  at: number; // Date.now() when recorded
}

export const RECENT_KIND_LABELS: Record<RecentRecord['kind'], string> = {
  paycheck: 'Paycheck',
  liability_payment: 'Tax Payment',
  adjustment: 'Tax Balance Adjustment',
};

const MAX = 15;
const listeners = new Set<() => void>();

function key(): string {
  return `sxp.recentRecords.${getCompanyId() ?? 'none'}`;
}

export function getRecentRecords(): RecentRecord[] {
  try {
    const raw = localStorage.getItem(key());
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? (v as RecentRecord[]) : [];
  } catch {
    return [];
  }
}

const same = (a: { kind: string; id: number }, b: { kind: string; id: number }) => a.kind === b.kind && a.id === b.id;

/** Record a payroll record as recently used (moves it to the top). */
export function recordRecent(r: Omit<RecentRecord, 'at'>): void {
  if (!r.id) return;
  const list = getRecentRecords().filter((x) => !same(x, r));
  list.unshift({ ...r, at: Date.now() });
  try {
    localStorage.setItem(key(), JSON.stringify(list.slice(0, MAX)));
  } catch {
    /* storage full or blocked */
  }
  listeners.forEach((fn) => fn());
}

/** Remove a deleted record from the list. */
export function forgetRecent(kind: RecentRecord['kind'], id: number): void {
  const list = getRecentRecords().filter((x) => !same(x, { kind, id }));
  try {
    localStorage.setItem(key(), JSON.stringify(list));
  } catch {
    /* ignore */
  }
  listeners.forEach((fn) => fn());
}

/** Subscribe to changes; returns an unsubscribe function. */
export function onRecentChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** React hook: the recent records (most recent first), re-rendering when the list changes. */
export function useRecentRecords(limit = MAX): RecentRecord[] {
  const [list, setList] = useState<RecentRecord[]>(() => getRecentRecords().slice(0, limit));
  useEffect(() => {
    const update = () => setList(getRecentRecords().slice(0, limit));
    update();
    return onRecentChange(update);
  }, [limit]);
  return list;
}

/** Label of a recent record: "Paycheck #1001". */
export function recentLabel(r: RecentRecord): string {
  const t = RECENT_KIND_LABELS[r.kind] ?? r.kind;
  return r.number ? `${t} #${r.number}` : t;
}

// ---------------------------------------------------------------------------
// Recently picked list entries (pickers show them first when the field is empty)

const PICKS_MAX = 8;

function picksKey(kind: string): string {
  return `sxp.recentPicks.${getCompanyId() ?? 'none'}.${kind}`;
}

/** Ids recently chosen in pickers of a kind ("account", "vendor", "employee", "item"...), most recent first. */
export function getRecentPicks(kind: string): Array<string | number> {
  try {
    const raw = localStorage.getItem(picksKey(kind));
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Remembers that an entry was chosen in a picker of this kind (moves it to the top). */
export function recordRecentPick(kind: string, id: string | number | null | undefined): void {
  if (id === null || id === undefined || id === '' || id === 0) return;
  const list = getRecentPicks(kind).filter((x) => x !== id);
  list.unshift(id);
  try {
    localStorage.setItem(picksKey(kind), JSON.stringify(list.slice(0, PICKS_MAX)));
  } catch {
    /* storage full or blocked */
  }
}

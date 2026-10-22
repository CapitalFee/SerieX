// Recently opened / saved transactions (per company, kept in localStorage).
// The shell reads it for the "+ New" panel and search; useTxnForm records into it.
import { useEffect, useState } from 'react';
import { getCompanyId } from '@/api/client';
import type { TxnType } from '@/api/types';

export interface RecentTxn {
  id: number;
  type: TxnType;
  refNumber: string;
  nameFull: string;
  amount: number;
  date: string;
  at: number; // Date.now() when recorded
}

const MAX = 15;
const listeners = new Set<() => void>();

function key(): string {
  return `sx.recentTxns.${getCompanyId() ?? 'none'}`;
}

export function getRecentTxns(): RecentTxn[] {
  try {
    const raw = localStorage.getItem(key());
    return raw ? (JSON.parse(raw) as RecentTxn[]) : [];
  } catch {
    return [];
  }
}

/** Record a transaction as recently used (moves it to the top). */
export function recordRecentTxn(t: Omit<RecentTxn, 'at'>): void {
  if (!t.id) return;
  const list = getRecentTxns().filter((r) => r.id !== t.id);
  list.unshift({ ...t, at: Date.now() });
  try {
    localStorage.setItem(key(), JSON.stringify(list.slice(0, MAX)));
  } catch {
    /* storage full or blocked */
  }
  listeners.forEach((fn) => fn());
}

/** Remove a deleted transaction from the list. */
export function forgetRecentTxn(id: number): void {
  const list = getRecentTxns().filter((r) => r.id !== id);
  try {
    localStorage.setItem(key(), JSON.stringify(list));
  } catch {
    /* ignore */
  }
  listeners.forEach((fn) => fn());
}

/** Subscribe to changes; returns an unsubscribe function. */
export function onRecentTxnsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** React hook: the recent transactions (most recent first), re-rendering when the list changes. */
export function useRecentTxns(limit = MAX): RecentTxn[] {
  const [list, setList] = useState<RecentTxn[]>(() => getRecentTxns().slice(0, limit));
  useEffect(() => {
    const update = () => setList(getRecentTxns().slice(0, limit));
    update();
    return onRecentTxnsChange(update);
  }, [limit]);
  return list;
}

// ---------------------------------------------------------------------------
// Recently picked list entries (pickers show them first when the field is empty)

const PICKS_MAX = 8;

function picksKey(kind: string): string {
  return `sx.recentPicks.${getCompanyId() ?? 'none'}.${kind}`;
}

/**
 * Ids recently chosen in pickers of a kind ("account", "customer", "vendor", "item", "list:terms"...),
 * most recent first, for the open company.
 */
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

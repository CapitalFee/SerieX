// Report favorites (★) and recently run reports, kept per company in this browser (localStorage).
import { useEffect, useState } from 'react';
import { getCompanyId } from '@/api/client';

/** A recently run report. */
export interface RecentReport {
  key: string;
  title: string;
  at: number;
}

const MAX_RECENT = 12;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

const favKey = () => `sx.reportFavorites.${getCompanyId() ?? 'none'}`;
const recentKey = () => `sx.reportRecent.${getCompanyId() ?? 'none'}`;

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    const v = raw ? JSON.parse(raw) : fallback;
    return Array.isArray(fallback) && !Array.isArray(v) ? fallback : (v as T);
  } catch {
    return fallback;
  }
}

function write(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage full or blocked: favorites simply are not remembered */
  }
  emit();
}

/** Keys of the favorite reports (in the order they were starred). */
export function getFavorites(): string[] {
  return read<string[]>(favKey(), []).filter((k) => typeof k === 'string');
}

/** Stars or un-stars a report. */
export function toggleFavorite(key: string): void {
  const cur = getFavorites();
  write(favKey(), cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]);
}

/** Recently run reports, most recent first. */
export function getRecentReports(): RecentReport[] {
  return read<RecentReport[]>(recentKey(), []).filter((r) => r && typeof r.key === 'string');
}

/** Remembers that a report was run (moves it to the top of Recent). */
export function recordRecentReport(key: string, title: string): void {
  if (!key || !getCompanyId()) return;
  const list = getRecentReports().filter((r) => r.key !== key);
  list.unshift({ key, title, at: Date.now() });
  write(recentKey(), list.slice(0, MAX_RECENT));
}

/** Clears the Recent list. */
export function clearRecentReports(): void {
  write(recentKey(), []);
}

/** React hook: favorites and recent reports, re-rendering when they change. */
export function useReportPrefs(): { favorites: string[]; recent: RecentReport[] } {
  const [state, setState] = useState(() => ({ favorites: getFavorites(), recent: getRecentReports() }));
  useEffect(() => {
    const update = () => setState({ favorites: getFavorites(), recent: getRecentReports() });
    listeners.add(update);
    const onStorage = (e: StorageEvent) => {
      if (e.key === favKey() || e.key === recentKey()) update();
    };
    window.addEventListener('storage', onStorage);
    update();
    return () => {
      listeners.delete(update);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  return state;
}

/** "5 minutes ago", "Yesterday", "Mar 3". */
export function timeAgo(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return 'Just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  if (d === 1) return 'Yesterday';
  if (d < 7) return `${d} days ago`;
  return new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

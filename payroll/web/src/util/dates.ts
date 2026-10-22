// Date helpers and report date presets.
// Preset keys, labels and resolve logic are identical to the backend
// (server/internal/reports/params.go: PresetLabels / ResolvePreset). Keep them in sync.
import { localIso } from './format';

/** A report date preset (key shared with the backend). */
export interface DatePreset {
  key: string;
  label: string;
}

/** Preset keys in the order of the "Dates" drop-down (same as backend `reports.PresetLabels`). */
export const DATE_PRESETS: DatePreset[] = [
  { key: 'all', label: 'All' },
  { key: 'today', label: 'Today' },
  { key: 'thisWeek', label: 'This Week' },
  { key: 'thisWeekToDate', label: 'This Week-to-date' },
  { key: 'thisMonth', label: 'This Month' },
  { key: 'thisMonthToDate', label: 'This Month-to-date' },
  { key: 'thisFiscalQuarter', label: 'This Fiscal Quarter' },
  { key: 'thisFiscalQuarterToDate', label: 'This Fiscal Quarter-to-date' },
  { key: 'thisFiscalYear', label: 'This Fiscal Year' },
  { key: 'thisFiscalYearToDate', label: 'This Fiscal Year-to-date' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'lastWeek', label: 'Last Week' },
  { key: 'lastWeekToDate', label: 'Last Week-to-date' },
  { key: 'lastMonth', label: 'Last Month' },
  { key: 'lastMonthToDate', label: 'Last Month-to-date' },
  { key: 'lastFiscalQuarter', label: 'Last Fiscal Quarter' },
  { key: 'lastFiscalQuarterToDate', label: 'Last Fiscal Quarter-to-date' },
  { key: 'lastFiscalYear', label: 'Last Fiscal Year' },
  { key: 'lastFiscalYearToDate', label: 'Last Fiscal Year-to-date' },
  { key: 'nextWeek', label: 'Next Week' },
  { key: 'nextFourWeeks', label: 'Next 4 Weeks' },
  { key: 'nextMonth', label: 'Next Month' },
  { key: 'nextFiscalQuarter', label: 'Next Fiscal Quarter' },
  { key: 'nextFiscalYear', label: 'Next Fiscal Year' },
];

/** The extra UI-only preset shown when the user types dates by hand. */
export const CUSTOM_PRESET: DatePreset = { key: 'custom', label: 'Custom' };

/** Presets plus "Custom", for the Dates drop-down of reports. */
export const DATE_PRESETS_WITH_CUSTOM: DatePreset[] = [...DATE_PRESETS, CUSTOM_PRESET];

/** Label of a preset key ("thisMonth" → "This Month"); unknown keys return "Custom". */
export function presetLabel(key: string): string {
  return DATE_PRESETS.find((p) => p.key === key)?.label ?? 'Custom';
}

// ---------------------------------------------------------------------------
// ISO date arithmetic (UTC based, so no daylight-saving surprises)

function toUtc(iso: string): Date {
  const y = +iso.slice(0, 4);
  const m = +iso.slice(5, 7);
  const d = +iso.slice(8, 10);
  return new Date(Date.UTC(y, m - 1, d));
}

function fromUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Adds years, months and days like Go's `time.AddDate` (overflow normalizes:
 * Mar 31 minus 1 month = "Feb 31" = Mar 3).
 */
export function addDate(iso: string, years: number, months: number, days: number): string {
  const t = toUtc(iso);
  return fromUtc(new Date(Date.UTC(t.getUTCFullYear() + years, t.getUTCMonth() + months, t.getUTCDate() + days)));
}

/** Adds (or subtracts) days to an ISO date. */
export function addDays(iso: string, n: number): string {
  return addDate(iso, 0, 0, n);
}

/** Adds months, clamping the day to the end of the target month (Jan 31 + 1 → Feb 28). */
export function addMonthsClamped(iso: string, n: number): string {
  const t = toUtc(iso);
  const target = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + n, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return fromUtc(new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(t.getUTCDate(), last))));
}

/** Today's local date as ISO `YYYY-MM-DD`. */
export function todayIso(): string {
  return localIso(new Date());
}

/** Day of week, 0 = Sunday. */
export function weekday(iso: string): number {
  return toUtc(iso).getUTCDay();
}

/** Whole days from `a` to `b` (b − a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((toUtc(b).getTime() - toUtc(a).getTime()) / 86400000);
}

/** First day of the week (weeks start on Sunday, as in the backend). */
export function startOfWeek(iso: string): string {
  return addDays(iso, -weekday(iso));
}
/** Last day of the week (Saturday). */
export function endOfWeek(iso: string): string {
  return addDays(startOfWeek(iso), 6);
}
/** First day of the month. */
export function startOfMonth(iso: string): string {
  return iso.slice(0, 8) + '01';
}
/** Last day of the month. */
export function endOfMonth(iso: string): string {
  return addDate(startOfMonth(iso), 0, 1, -1);
}
/** January 1 of the date's calendar year. */
export function startOfYear(iso: string): string {
  return iso.slice(0, 4) + '-01-01';
}
/** December 31 of the date's calendar year. */
export function endOfYear(iso: string): string {
  return iso.slice(0, 4) + '-12-31';
}

/** First day of the fiscal year that contains `iso` (same as backend `FiscalYearStart`). */
export function fiscalYearStart(iso: string, fyStartMonth: number): string {
  const m = fyStartMonth >= 1 && fyStartMonth <= 12 ? fyStartMonth : 1;
  let y = +iso.slice(0, 4);
  if (+iso.slice(5, 7) < m) y--;
  return `${y}-${m < 10 ? '0' + m : m}-01`;
}

/**
 * Resolves a preset to a from/to range exactly like the backend `ResolvePreset`.
 * "all" returns from = "". Unknown keys (and "custom") behave like "thisMonthToDate".
 */
export function resolvePreset(key: string, today: string = todayIso(), fyStartMonth = 1): { from: string; to: string } {
  const t = today;
  const wd = weekday(t);
  const weekStart = addDays(t, -wd);
  const monthStart = startOfMonth(t);
  const fyStart = fiscalYearStart(t, fyStartMonth);
  const fyMonth = +fyStart.slice(5, 7);
  const monthsIntoFY = (+t.slice(5, 7) - fyMonth + 12) % 12;
  const qStart = addDate(fyStart, 0, Math.floor(monthsIntoFY / 3) * 3, 0);
  const r = (from: string, to: string) => ({ from, to });
  switch (key) {
    case 'all':
      return r('', t);
    case 'today':
      return r(t, t);
    case 'yesterday': {
      const y = addDays(t, -1);
      return r(y, y);
    }
    case 'thisWeek':
      return r(weekStart, addDays(weekStart, 6));
    case 'thisWeekToDate':
      return r(weekStart, t);
    case 'thisMonth':
      return r(monthStart, addDate(monthStart, 0, 1, -1));
    case 'thisFiscalQuarter':
      return r(qStart, addDate(qStart, 0, 3, -1));
    case 'thisFiscalQuarterToDate':
      return r(qStart, t);
    case 'thisFiscalYear':
      return r(fyStart, addDate(fyStart, 1, 0, -1));
    case 'thisFiscalYearToDate':
      return r(fyStart, t);
    case 'lastWeek': {
      const s = addDays(weekStart, -7);
      return r(s, addDays(s, 6));
    }
    case 'lastWeekToDate': {
      const s = addDays(weekStart, -7);
      return r(s, addDays(t, -7));
    }
    case 'lastMonth': {
      const s = addDate(monthStart, 0, -1, 0);
      return r(s, addDays(monthStart, -1));
    }
    case 'lastMonthToDate': {
      const s = addDate(monthStart, 0, -1, 0);
      let e = addDate(t, 0, -1, 0);
      if (e.slice(5, 7) !== s.slice(5, 7)) e = addDays(monthStart, -1);
      return r(s, e);
    }
    case 'lastFiscalQuarter': {
      const s = addDate(qStart, 0, -3, 0);
      return r(s, addDays(qStart, -1));
    }
    case 'lastFiscalQuarterToDate': {
      const s = addDate(qStart, 0, -3, 0);
      return r(s, addDate(t, 0, -3, 0));
    }
    case 'lastFiscalYear': {
      const s = addDate(fyStart, -1, 0, 0);
      return r(s, addDays(fyStart, -1));
    }
    case 'lastFiscalYearToDate': {
      const s = addDate(fyStart, -1, 0, 0);
      return r(s, addDate(t, -1, 0, 0));
    }
    case 'nextWeek': {
      const s = addDays(weekStart, 7);
      return r(s, addDays(s, 6));
    }
    case 'nextFourWeeks': {
      const s = addDays(weekStart, 7);
      return r(s, addDays(s, 27));
    }
    case 'nextMonth': {
      const s = addDate(monthStart, 0, 1, 0);
      return r(s, addDate(s, 0, 1, -1));
    }
    case 'nextFiscalQuarter': {
      const s = addDate(qStart, 0, 3, 0);
      return r(s, addDate(s, 0, 3, -1));
    }
    case 'nextFiscalYear': {
      const s = addDate(fyStart, 1, 0, 0);
      return r(s, addDate(s, 1, 0, -1));
    }
    default:
      return r(monthStart, t);
  }
}

/** Finds the preset whose range equals from/to (for showing the preset name), or "custom". */
export function matchPreset(from: string, to: string, today: string = todayIso(), fyStartMonth = 1): string {
  for (const p of DATE_PRESETS) {
    const r = resolvePreset(p.key, today, fyStartMonth);
    if (r.from === from && r.to === to) return p.key;
  }
  return 'custom';
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Month names, January first. */
export const MONTH_NAMES: readonly string[] = MONTHS;

/** "2026-10-17" → "October 17, 2026". */
export function longDate(iso: string): string {
  if (!iso || iso.length < 10) return iso ?? '';
  return `${MONTHS[+iso.slice(5, 7) - 1]} ${+iso.slice(8, 10)}, ${iso.slice(0, 4)}`;
}

/** Same wording as the backend `DateRangeLabel` ("January 1 through October 17, 2026"). */
export function dateRangeLabel(from: string, to: string): string {
  if (!from) {
    if (!to || to >= '9999-12-31') return 'All Transactions';
    return 'All Transactions through ' + longDate(to);
  }
  if (from === to) return longDate(to);
  if (from.slice(0, 4) === to.slice(0, 4)) {
    return `${MONTHS[+from.slice(5, 7) - 1]} ${+from.slice(8, 10)} through ${longDate(to)}`;
  }
  return `${longDate(from)} through ${longDate(to)}`;
}

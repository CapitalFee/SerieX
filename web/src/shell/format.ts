// Small formatting helpers used by the shell (kept local so the shell does not
// depend on the UI components).
const money = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** 1234.5 -> "1,234.50"; negatives keep the minus sign. */
export function shellMoney(n: number | null | undefined): string {
  const v = Number(n ?? 0);
  return money.format(Math.abs(v) < 0.005 ? 0 : v);
}

/** "2026-10-05" -> "10/05/2026" ('' for empty / invalid). */
export function shellDate(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
  return m ? `${m[2]}/${m[3]}/${m[1]}` : '';
}

/** Initials of a user name for the avatar ("Admin" -> "AD", "Rick Smith" -> "RS"). */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

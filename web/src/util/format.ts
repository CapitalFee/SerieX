// Number, money and date formatting/parsing shared by every screen.
//
// Money is shown as "1,234.56" with a leading minus sign for negatives.
// Dates are ISO "YYYY-MM-DD" internally and "MM/DD/YYYY" on screen.
// Money/number inputs accept arithmetic ("100*3+5"), like a calculator.

/**
 * Rounds a dollar amount to cents, half away from zero.
 * Mirrors the server's `store.Cents` (adds a 1e-7 nudge before rounding) so that the
 * client and the server always agree on rounding.
 */
export function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  let v = n * 100;
  v = v >= 0 ? v + 1e-7 : v - 1e-7;
  const c = v >= 0 ? Math.floor(v + 0.5) : -Math.floor(-v + 0.5);
  return c / 100 || 0;
}

/** Rounds to a number of decimals (half away from zero). */
export function roundTo(n: number, decimals: number): number {
  if (!Number.isFinite(n)) return 0;
  const f = Math.pow(10, decimals);
  let v = n * f;
  v = v >= 0 ? v + 1e-7 : v - 1e-7;
  const r = v >= 0 ? Math.floor(v + 0.5) : -Math.floor(-v + 0.5);
  return r / f || 0;
}

const moneyFmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qtyFmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 5 });

/** Options of {@link fmtMoney}. */
export interface FmtMoneyOptions {
  /** Return "" for zero (many reports and grids leave zero amounts blank). */
  blankZero?: boolean;
  /** Show negatives as (1,234.56) instead of -1,234.56. */
  parens?: boolean;
  /** Prefix a dollar sign ("$1,234.56"). */
  dollarSign?: boolean;
}

/**
 * Formats a dollar amount: `1234.5` → `"1,234.50"`, `-3` → `"-3.00"`.
 * `null`/`undefined`/`NaN` → `""`.
 */
export function fmtMoney(n: number | null | undefined, opts: FmtMoneyOptions = {}): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '';
  const v = round2(n);
  if (v === 0 && opts.blankZero) return '';
  const body = (opts.dollarSign ? '$' : '') + moneyFmt.format(Math.abs(v));
  if (v < 0) return opts.parens ? `(${body})` : `-${body}`;
  return body;
}

/** Formats a quantity or rate with up to 5 decimals and thousands separators ("1,250", "2.5"). */
export function fmtQty(n: number | null | undefined, opts: { blankZero?: boolean } = {}): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '';
  if (n === 0 && opts.blankZero) return '';
  return qtyFmt.format(roundTo(n, 5));
}

/**
 * Formats a percentage. Without `decimals` trailing zeros are trimmed but one decimal is kept
 * (`7` → `"7.0%"`, `8.25` → `"8.25%"`), as tax rates are usually written.
 */
export function fmtPercent(n: number | null | undefined, decimals?: number): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '';
  if (decimals !== undefined) return `${n.toFixed(decimals)}%`;
  let s = roundTo(n, 4).toFixed(4).replace(/0+$/, '');
  if (s.endsWith('.')) s += '0';
  return `${s}%`;
}

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})/;

/** ISO `YYYY-MM-DD` → `MM/DD/YYYY` (empty or invalid input returns it unchanged / ""). */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const m = ISO_RE.exec(iso);
  if (!m) return iso;
  return `${m[2]}/${m[3]}/${m[1]}`;
}

/** Number of days in a month (month 1-12). */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

/** Builds an ISO date from parts; returns null when the parts are not a real date. */
export function isoFromParts(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (year < 1900 || year > 2999 || month < 1 || month > 12 || day < 1) return null;
  if (day > daysInMonth(year, month)) return null;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function expandYear(y: string, refYear: number): number {
  const n = parseInt(y, 10);
  if (y.length <= 2) {
    // two-digit years: 00-79 → 2000s, 80-99 → 1900s
    return n < 80 ? 2000 + n : 1900 + n;
  }
  if (y.length === 3) return refYear;
  return n;
}

/**
 * Parses what the user typed in a date field. Accepts `1/5`, `1/5/26`, `01/05/2026`, `1.5.2026`,
 * `1-5-2026`, `010526`, `01052026`, a bare day `15` (day of the reference month) and ISO dates.
 * `ref` (ISO) supplies the missing year/month (default: today). Returns ISO or null when invalid/empty.
 */
export function parseDate(text: string | null | undefined, ref?: string): string | null {
  const s = (text ?? '').trim();
  if (!s) return null;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (iso) return isoFromParts(+iso[1], +iso[2], +iso[3]);
  const refIso = ref && ISO_RE.test(ref) ? ref : localIso(new Date());
  const ry = +refIso.slice(0, 4);
  const rm = +refIso.slice(5, 7);
  if (/^\d+$/.test(s)) {
    if (s.length <= 2) return isoFromParts(ry, rm, +s);
    if (s.length === 4) return isoFromParts(ry, +s.slice(0, 2), +s.slice(2, 4));
    if (s.length === 6) return isoFromParts(expandYear(s.slice(4), ry), +s.slice(0, 2), +s.slice(2, 4));
    if (s.length === 8) return isoFromParts(+s.slice(4), +s.slice(0, 2), +s.slice(2, 4));
    return null;
  }
  const parts = s.split(/[/.\-\s]+/).filter(Boolean);
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => !/^\d+$/.test(p))) return null;
  const month = +parts[0];
  const day = +parts[1];
  const year = parts.length === 3 ? expandYear(parts[2], ry) : ry;
  return isoFromParts(year, month, day);
}

/** Local calendar date of a JS Date as ISO (no timezone shift). */
export function localIso(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// ---------------------------------------------------------------------------
// Arithmetic ("100*3+5") used by money and number fields

/**
 * Evaluates a simple arithmetic expression with + - * / and parentheses.
 * Commas, spaces and `$` are ignored. Returns null for invalid input or division by zero.
 */
export function evalArithmetic(text: string): number | null {
  const src = text.replace(/[,\s$]/g, '');
  if (!src) return null;
  let i = 0;
  const peek = () => src[i];
  const fail = () => {
    throw new Error('bad');
  };
  function number(): number {
    const m = /^(\d+\.?\d*|\.\d+)/.exec(src.slice(i));
    if (!m) fail();
    i += m![0].length;
    return parseFloat(m![0]);
  }
  function factor(): number {
    const c = peek();
    if (c === '-') {
      i++;
      return -factor();
    }
    if (c === '+') {
      i++;
      return factor();
    }
    if (c === '(') {
      i++;
      const v = expr();
      if (peek() !== ')') fail();
      i++;
      return v;
    }
    return number();
  }
  function term(): number {
    let v = factor();
    for (;;) {
      const c = peek();
      if (c === '*') {
        i++;
        v *= factor();
      } else if (c === '/') {
        i++;
        const d = factor();
        if (d === 0) fail();
        v /= d;
      } else return v;
    }
  }
  function expr(): number {
    let v = term();
    for (;;) {
      const c = peek();
      if (c === '+') {
        i++;
        v += term();
      } else if (c === '-') {
        i++;
        v -= term();
      } else return v;
    }
  }
  try {
    const v = expr();
    if (i !== src.length || !Number.isFinite(v)) return null;
    return v;
  } catch {
    return null;
  }
}

/** True when the text contains an arithmetic operator after its first character ("100*3"). */
export function hasArithmetic(text: string): boolean {
  return /[-+*/()]/.test(text.replace(/[,\s$]/g, '').slice(1));
}

/** Parses a money input (arithmetic allowed) and rounds it to cents. Empty/invalid → null. */
export function parseMoney(text: string | null | undefined): number | null {
  const v = evalArithmetic(text ?? '');
  return v === null ? null : round2(v);
}

/** Parses a quantity/rate input (arithmetic allowed), rounded to `decimals` (default 5). */
export function parseNumber(text: string | null | undefined, decimals = 5): number | null {
  const v = evalArithmetic((text ?? '').replace(/%$/, ''));
  return v === null ? null : roundTo(v, decimals);
}

/** Amount of a line: qty × rate rounded to cents, or the rate when qty is empty. */
export function lineAmount(qty: number | null | undefined, rate: number | null | undefined): number {
  if (rate === null || rate === undefined) return 0;
  if (qty === null || qty === undefined) return round2(rate);
  return round2(qty * rate);
}

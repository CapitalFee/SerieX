// Report display logic shared by the screen, print and CSV export: display options (number
// format, header/footer, hidden columns) stored as "ui.*" report parameters, row structure
// (collapsible sections), visible rows, column widths, drill-down helpers.
import type { ReportColumn, ReportDrill, ReportResult, ReportRow, Txn } from '@/api/types';
import { ApiError, api } from '@/api/client';
import { queryClient } from '@/api/hooks';
import { toast } from '@/components';
import { escHtml } from '@/util/print';
import { fmtDate } from '@/util/format';
import { openTxn, openWindow } from '@/windows/windowStore';

// ---------------------------------------------------------------------------
// Display options

/** How negative numbers are written. */
export type NegStyle = 'minus' | 'parens' | 'trailing';

/** Header parts that can be turned off. */
export type HeaderPart = 'company' | 'title' | 'subtitle' | 'date' | 'time' | 'basis';

/** Everything the Customize panel changes that the server does not need to know. */
export interface DisplayOptions {
  /** Columns hidden on screen (reports without server side `cols`). */
  hidden: string[];
  neg: NegStyle;
  red: boolean;
  /** Show all numbers divided by 1000. */
  thousands: boolean;
  noCents: boolean;
  /** "Except zero amounts": zero amounts are left blank. */
  blankZero: boolean;
  /** Hide data rows whose amounts are all zero. */
  hideZeroRows: boolean;
  /** Header parts turned off. */
  hdrOff: HeaderPart[];
  /** Custom title / subtitle ("" = the report's own). */
  title: string;
  subtitle: string;
  /** Extra footer line. */
  footer: string;
  /** Sort of flat reports: "col" ascending, "-col" descending, "" = report order. */
  sort: string;
  /** Open with every section collapsed. */
  collapseAll: boolean;
  /** "Hide header" is on. */
  noHeader: boolean;
}

export const DEFAULT_DISPLAY: DisplayOptions = {
  hidden: [],
  neg: 'minus',
  red: false,
  thousands: false,
  noCents: false,
  blankZero: false,
  hideZeroRows: false,
  hdrOff: [],
  title: '',
  subtitle: '',
  footer: '',
  sort: '',
  collapseAll: false,
  noHeader: false,
};

const UI = 'ui.';
const list = (s: string | undefined) =>
  s
    ? s
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
    : [];

/** Splits window params into server params and display options ("ui.*" keys). */
export function splitParams(params: Record<string, string> | undefined): { rp: Record<string, string>; display: DisplayOptions } {
  const rp: Record<string, string> = {};
  const u: Record<string, string> = {};
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v === undefined || v === null) continue;
    if (k.startsWith(UI)) u[k.slice(UI.length)] = String(v);
    else rp[k] = String(v);
  }
  const neg = u.neg === 'parens' || u.neg === 'trailing' ? u.neg : 'minus';
  return {
    rp,
    display: {
      hidden: list(u.hide),
      neg,
      red: u.red === '1',
      thousands: u.k === '1',
      noCents: u.nc === '1',
      blankZero: u.bz === '1',
      hideZeroRows: u.hz === '1',
      hdrOff: list(u.hdr) as HeaderPart[],
      title: u.title ?? '',
      subtitle: u.subtitle ?? '',
      footer: u.footer ?? '',
      sort: u.sort ?? '',
      collapseAll: u.collapse === '1',
      noHeader: u.nohead === '1',
    },
  };
}

/** Display options as "ui.*" params (only the ones that differ from the defaults). */
export function displayToParams(d: DisplayOptions): Record<string, string> {
  const o: Record<string, string> = {};
  if (d.hidden.length) o['ui.hide'] = d.hidden.join(',');
  if (d.neg !== 'minus') o['ui.neg'] = d.neg;
  if (d.red) o['ui.red'] = '1';
  if (d.thousands) o['ui.k'] = '1';
  if (d.noCents) o['ui.nc'] = '1';
  if (d.blankZero) o['ui.bz'] = '1';
  if (d.hideZeroRows) o['ui.hz'] = '1';
  if (d.hdrOff.length) o['ui.hdr'] = d.hdrOff.join(',');
  if (d.title.trim()) o['ui.title'] = d.title.trim();
  if (d.subtitle.trim()) o['ui.subtitle'] = d.subtitle.trim();
  if (d.footer.trim()) o['ui.footer'] = d.footer.trim();
  if (d.sort) o['ui.sort'] = d.sort;
  if (d.collapseAll) o['ui.collapse'] = '1';
  if (d.noHeader) o['ui.nohead'] = '1';
  return o;
}

/** Number of display changes from the defaults (badge on the Customize button). */
export function displayChangeCount(d: DisplayOptions): number {
  return Object.keys(displayToParams({ ...d, sort: '', collapseAll: false, noHeader: false })).length;
}

// ---------------------------------------------------------------------------
// Cell formatting

const nf = [0, 1, 2, 3, 4].map((n) => new Intl.NumberFormat('en-US', { minimumFractionDigits: n, maximumFractionDigits: n }));
const qtyFmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 4 });
/** Stored rates keep the decimals they were entered with (6.25%, 1.5%, 8.0%). */
const rateFmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 4 });

const NUMERIC = new Set<string>(['money', 'number', 'percent', 'rate']);

/** True for money / number / percent columns. */
export const isNumericCol = (c: ReportColumn) => NUMERIC.has(c.type);

/**
 * True for percent columns that hold a stored rate (sales tax rate, terms discount %), which show
 * every decimal they have (up to 4). Computed ratios (% Change, % of Sales, % of Budget) keep one
 * decimal. A server column of type "rate" is a rate too.
 */
export function isRateCol(c: ReportColumn): boolean {
  if ((c.type as string) === 'rate') return true;
  if (c.type !== 'percent') return false;
  return /rate/i.test(c.key) || /\brate\b/i.test(c.label) || /^disc/i.test(c.key) || /^discount\b/i.test(c.label);
}

function signed(body: string, negative: boolean, neg: NegStyle): string {
  if (!negative) return body;
  if (neg === 'parens') return `(${body})`;
  if (neg === 'trailing') return `${body}-`;
  return `-${body}`;
}

/** Formatted text of a cell and whether it is a negative number. */
export function formatCell(v: unknown, col: ReportColumn, d: DisplayOptions): { text: string; negative: boolean } {
  if (v === null || v === undefined || v === '') return { text: '', negative: false };
  if (typeof v !== 'number') {
    const s = String(v);
    return { text: col.type === 'date' ? fmtDate(s) : s, negative: false };
  }
  if (!Number.isFinite(v)) return { text: '', negative: false };
  if (isRateCol(col)) {
    const x = Number(v.toFixed(4));
    if (x === 0 && d.blankZero) return { text: '', negative: false };
    return { text: signed(rateFmt.format(Math.abs(x)), x < 0, d.neg) + '%', negative: x < 0 };
  }
  switch (col.type) {
    case 'money': {
      let x = d.thousands ? v / 1000 : v;
      const dec = d.noCents ? 0 : 2;
      x = Number(x.toFixed(dec));
      if (x === 0) return { text: d.blankZero ? '' : nf[dec].format(0), negative: false };
      return { text: signed(nf[dec].format(Math.abs(x)), x < 0, d.neg), negative: x < 0 };
    }
    case 'percent': {
      const x = Number(v.toFixed(1));
      if (x === 0 && d.blankZero) return { text: '', negative: false };
      return { text: signed(nf[1].format(Math.abs(x)), x < 0, d.neg) + '%', negative: x < 0 };
    }
    case 'number': {
      if (v === 0 && d.blankZero) return { text: '', negative: false };
      return { text: signed(qtyFmt.format(Math.abs(v)), v < 0, d.neg), negative: v < 0 };
    }
    case 'date':
      return { text: String(v), negative: false };
    default:
      return { text: String(v), negative: false };
  }
}

/** Raw value for CSV export (numbers unformatted, dates MM/DD/YYYY). */
export function csvValue(v: unknown, col: ReportColumn, d: DisplayOptions): string | number {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') {
    if (col.type === 'money') {
      const x = d.thousands ? v / 1000 : v;
      return Number(x.toFixed(d.noCents ? 0 : 2));
    }
    if (isRateCol(col)) return `${Number(v.toFixed(4))}%`;
    if (col.type === 'percent') return `${Number(v.toFixed(1))}%`;
    return v;
  }
  return col.type === 'date' ? fmtDate(String(v)) : String(v);
}

// ---------------------------------------------------------------------------
// Column headers (budget reports group Actual / Budget / $ Over / % of Budget under a period)

const SUB_LABEL: Record<string, string> = { a: 'Actual', b: 'Budget', o: '$ Over Budget', pct: '% of Budget' };

/** A header cell spanning several columns. */
export interface HeaderGroup {
  label: string;
  keys: string[];
}

/** Two-level header for budget comparison columns (keys a_/b_/o_/pct_ + period), else null. */
export function headerGroups(cols: ReportColumn[]): { groups: HeaderGroup[]; sub: Record<string, string> } | null {
  const rest = cols.filter((c) => c.key !== 'label');
  if (rest.length < 3) return null;
  const re = /^(a|b|o|pct)_(.+)$/;
  if (!rest.every((c) => re.test(c.key))) return null;
  const groups: HeaderGroup[] = [];
  const sub: Record<string, string> = {};
  for (const c of rest) {
    const [, pre, suffix] = re.exec(c.key)!;
    const last = groups[groups.length - 1];
    const label = pre === 'a' ? c.label : '';
    if (last && (last as HeaderGroup & { suffix?: string }).suffix === suffix) {
      last.keys.push(c.key);
      if (label) last.label = label;
    } else {
      const g: HeaderGroup & { suffix?: string } = { label, keys: [c.key], suffix };
      groups.push(g);
    }
    sub[c.key] = SUB_LABEL[pre] ?? c.label;
  }
  return { groups, sub };
}

// ---------------------------------------------------------------------------
// Row structure

/** Section structure of a report: which sections can collapse and where they end. */
export interface Structure {
  /** For section rows: index of the first row after the section content (its closing row or the next row). */
  end: Int32Array;
  /** Closing "Total …" row of a section, or -1. */
  closer: Int32Array;
  /** 1 when the closing row is folded into the section row while collapsed. */
  absorb: Uint8Array;
  /** 1 for sections without nested sections ("Collapse all" collapses these). */
  leaf: Uint8Array;
  collapsible: Uint8Array;
  /** Rows are only data rows (and trailing totals): the report can be sorted by a column. */
  flat: boolean;
  hasCollapsible: boolean;
}

/** Finds each section's extent (a section ends at the first later row with the same or a lower level). */
export function analyze(rowsIn: ReportRow[] | null | undefined): Structure {
  const rows = rowsIn ?? [];
  const n = rows.length;
  const end = new Int32Array(n).fill(-1);
  const closer = new Int32Array(n).fill(-1);
  const absorb = new Uint8Array(n);
  const leaf = new Uint8Array(n);
  const collapsible = new Uint8Array(n);
  const stack: number[] = [];
  const nested = new Uint8Array(n);
  for (let j = 0; j < n; j++) {
    const lv = rows[j].level ?? 0;
    while (stack.length && (rows[stack[stack.length - 1]].level ?? 0) >= lv) end[stack.pop()!] = j;
    if (rows[j].kind === 'section') {
      if (stack.length) nested[stack[stack.length - 1]] = 1;
      stack.push(j);
    }
  }
  while (stack.length) end[stack.pop()!] = n;
  let hasCollapsible = false;
  let flat = true;
  let seenTotal = false;
  for (let i = 0; i < n; i++) {
    const r = rows[i];
    if (r.kind === 'section' || r.kind === 'subtotal') flat = false;
    if (r.kind === 'total' || r.kind === 'grandtotal') seenTotal = true;
    else if (r.kind === 'data' && seenTotal) flat = false;
    if (r.kind !== 'section') continue;
    const e = end[i];
    if (e < n && (rows[e].level ?? 0) === (r.level ?? 0) && (rows[e].kind === 'subtotal' || rows[e].kind === 'total' || rows[e].kind === 'grandtotal')) {
      closer[i] = e;
      absorb[i] = rows[e].kind === 'subtotal' ? 1 : 0;
    }
    if (e - i > 1) {
      collapsible[i] = 1;
      hasCollapsible = true;
    }
    leaf[i] = nested[i] ? 0 : 1;
  }
  return { end, closer, absorb, leaf, collapsible, flat, hasCollapsible };
}

/** One row as shown (a collapsed section shows its closing row's amounts). */
export interface VisibleRow {
  /** Index in the result rows. */
  i: number;
  row: ReportRow;
  /** Cells to show. */
  cells: Record<string, string | number | null>;
  /** Row whose drills apply to the amounts (the closing row of a collapsed section). */
  drillRow: ReportRow;
  collapsible: boolean;
  collapsed: boolean;
}

function allZero(r: ReportRow, numericKeys: string[]): boolean {
  for (const k of numericKeys) {
    const v = r.cells[k];
    if (typeof v === 'number' && Math.abs(v) >= 0.005) return false;
    if (typeof v === 'string' && v !== '') return false;
  }
  return true;
}

function compareVals(a: unknown, b: unknown): number {
  const ea = a === null || a === undefined || a === '';
  const eb = b === null || b === undefined || b === '';
  if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

/** Rows to show after collapsing, hiding zero rows and sorting. */
export function visibleRows(rowsIn: ReportRow[] | null | undefined, st: Structure, collapsed: Set<number>, d: DisplayOptions, numericKeys: string[]): VisibleRow[] {
  const rows = rowsIn ?? [];
  const out: VisibleRow[] = [];
  const n = rows.length;
  let i = 0;
  while (i < n) {
    const r = rows[i];
    if (d.hideZeroRows && r.kind === 'data' && numericKeys.length && allZero(r, numericKeys)) {
      i++;
      continue;
    }
    if (r.kind === 'section' && st.collapsible[i] && collapsed.has(i)) {
      const c = st.closer[i];
      if (st.absorb[i] && c >= 0) {
        const cr = rows[c];
        out.push({ i, row: r, cells: { ...cr.cells, label: r.cells.label }, drillRow: cr, collapsible: true, collapsed: true });
        i = c + 1;
      } else {
        out.push({ i, row: r, cells: r.cells, drillRow: r, collapsible: true, collapsed: true });
        i = st.end[i];
      }
      continue;
    }
    out.push({ i, row: r, cells: r.cells, drillRow: r, collapsible: r.kind === 'section' && !!st.collapsible[i], collapsed: false });
    i++;
  }
  if (st.flat && d.sort) {
    const desc = d.sort.startsWith('-');
    const key = desc ? d.sort.slice(1) : d.sort;
    const data = out.filter((v) => v.row.kind === 'data');
    const rest = out.filter((v) => v.row.kind !== 'data');
    data.sort((a, b) => {
      const c = compareVals(a.cells[key], b.cells[key]);
      return (desc ? -c : c) || a.i - b.i;
    });
    return [...data, ...rest];
  }
  return out;
}

/** Sections collapsed by "Collapse all" (the innermost ones, like a Collapse button). */
export function collapseAllSet(st: Structure): Set<number> {
  const s = new Set<number>();
  for (let i = 0; i < st.collapsible.length; i++) if (st.collapsible[i] && st.leaf[i]) s.add(i);
  return s;
}

/**
 * True when a result has nothing to show: no transaction or detail rows, and every amount of the
 * remaining rows (the zero totals the server always adds, empty headings) is zero. Rows with any
 * other text (a contact, a phone number) count as content.
 */
export function isEmptyResult(rows: ReportRow[] | null | undefined): boolean {
  if (!rows?.length) return true;
  for (const r of rows) {
    if (r.kind === 'data') return false;
    if (r.kind === 'blank') continue;
    for (const [k, v] of Object.entries(r.cells ?? {})) {
      if (k === 'label' || v === null || v === undefined || v === '') continue;
      if (typeof v === 'number') {
        if (Math.abs(v) >= 0.005) return false;
      } else return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Column widths

export const REPORT_FONT = '12px "Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, Arial, sans-serif';
export const REPORT_FONT_BOLD = '600 12px "Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, Arial, sans-serif';
export const INDENT = 18;
const CELL_PAD = 12;

let ctx: CanvasRenderingContext2D | null = null;
function measurer(): CanvasRenderingContext2D | null {
  if (!ctx && typeof document !== 'undefined') ctx = document.createElement('canvas').getContext('2d');
  return ctx;
}

/** Width of a text in the report font. */
export function textWidth(s: string, bold = false): number {
  const c = measurer();
  if (!c) return s.length * 7;
  c.font = bold ? REPORT_FONT_BOLD : REPORT_FONT;
  return c.measureText(s).width;
}

let numEl: HTMLSpanElement | null = null;
const numCache = new Map<string, number>();
/**
 * Width of a number as shown, plus 2 px: report cells show equal width (tabular) digits, which a
 * canvas cannot measure (its digits are a little narrower), so each shape of number
 * ("-000,000.00", "(0,000.00)") is measured once in a hidden element with the report font.
 */
function numberWidth(s: string, bold = false): number {
  const shape = s.replace(/[0-9]/g, '0');
  const k = (bold ? 'b' : 'r') + shape;
  let v = numCache.get(k);
  if (v !== undefined) return v;
  v = textWidth(shape, bold);
  if (typeof document !== 'undefined' && document.body) {
    try {
      if (!numEl || !numEl.isConnected) {
        numEl = document.createElement('span');
        numEl.setAttribute('aria-hidden', 'true');
        document.body.appendChild(numEl);
      }
      // the font shorthand resets font-variant-numeric, so it is set first
      numEl.style.cssText = 'position:absolute;left:-9999px;top:-9999px;visibility:hidden;white-space:pre;pointer-events:none';
      numEl.style.font = bold ? REPORT_FONT_BOLD : REPORT_FONT;
      numEl.style.fontVariantNumeric = 'tabular-nums';
      numEl.textContent = shape;
      const dw = numEl.getBoundingClientRect().width;
      if (dw > v) v = dw;
    } catch {
      /* the canvas width is used */
    }
  }
  v += 2;
  if (numCache.size > 5000) numCache.clear();
  numCache.set(k, v);
  return v;
}

/** Width of a cell text: report cells show equal width digits (see reports.css), so digits measure as "0". */
function cellTextWidth(s: string, bold: boolean, cache: Map<string, number>): number {
  const k = (bold ? 'b' : 'r') + s;
  let v = cache.get(k);
  if (v === undefined) {
    v = textWidth(s.replace(/[0-9]/g, '0'), bold);
    cache.set(k, v);
  }
  return v;
}

// ---- wrapped text cells: free text (names, memos, accounts) narrower than its text wraps onto
// a few lines instead of being cut, and the row grows to fit

/** Height of each extra line of a wrapped report row in px. */
export const WRAP_LINE_H = 15;
/** Most lines a wrapped cell shows; longer text ends with "…" and shows in full on hover. */
export const WRAP_MAX_LINES = 8;
/** Horizontal padding of a report cell (6 px each side, see reports.css) plus a pixel of slack. */
const WRAP_PAD = 13;

const DIGIT = /[0-9]/;

/**
 * The pieces a text may break between: after a space, and after ":" "/" "-" inside a word (account
 * paths such as "Job Expenses:Subcontractors", codes such as "CLS-261005"), but not between two
 * digits, so dates and times in a memo stay whole. Dates, times, phone numbers and numbers
 * ("10/19/2026 17:00:00", "(555) 010-3101") break only at their spaces. The screen shows the same
 * break points.
 */
export function wrapPieces(s: string): string[] {
  const out: string[] = [];
  const spacesOnly = FIXED_VALUE.test(s);
  let start = 0;
  for (let i = 0; i < s.length - 1; i++) {
    const ch = s[i];
    const mark = (ch === ':' || ch === '/' || ch === '-') && s[i + 1] !== ' ' && !(i > 0 && DIGIT.test(s[i - 1]) && DIGIT.test(s[i + 1]));
    if (ch === ' ' || (!spacesOnly && mark)) {
      out.push(s.slice(start, i + 1));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

let wrapCache = new Map<string, number>();
/** Width of a report cell text (equal width digits), remembered for the texts measured before. */
export function cellWidth(s: string, bold = false): number {
  if (wrapCache.size > 60000) wrapCache = new Map();
  return cellTextWidth(s, bold, wrapCache);
}
const wrapWidth = cellWidth;

/** Width of the widest piece of a text that cannot be broken (see {@link wrapPieces}). */
function widestPiece(s: string, bold: boolean): number {
  let m = 0;
  for (const p of wrapPieces(s)) m = Math.max(m, wrapWidth(p.trimEnd(), bold));
  return m;
}

/** Lines a text takes in a report cell of this width when it wraps (1 when it fits on one line). */
export function wrapLineCount(text: string, width: number, bold = false): number {
  const room = width - WRAP_PAD;
  if (!text || room <= 4 || wrapWidth(text, bold) <= room) return 1;
  let lines = 1;
  let cur = 0;
  for (const p of wrapPieces(text)) {
    const pw = wrapWidth(p, bold);
    const pt = p.endsWith(' ') ? wrapWidth(p.trimEnd(), bold) : pw;
    if (cur > 0 && cur + pt > room) {
      lines++;
      cur = 0;
    }
    if (cur === 0 && pt > room) {
      // a word longer than the cell breaks anywhere
      const k = Math.ceil(pt / room);
      lines += k - 1;
      cur = pt - (k - 1) * room + (pw - pt);
      continue;
    }
    cur += pw;
  }
  return lines;
}

const MAX_SAMPLE = 2500;

/** Fixed-format text columns (by key or header): dates with a time, phone numbers, terms, codes. Cut, they are useless. */
const FIXED_COL = /phone|fax|mobile|\btel\b|terms|^type$|^num$|^ref|^po$|p\.\s?o\.\s?#|^state$|status|entered|modified|time|^via$|zip|^clr|^code$|taxcode|tax code/i;
/** Fixed-format values: dates (with a time), phone numbers, numbers and codes made of digits. */
const FIXED_VALUE = /^(\d{1,2}\/\d{1,2}\/\d{2,4}(\s+\d{1,2}:\d{2}(:\d{2})?(\s?[ap]m)?)?|[\d\s.,:/()+#-]+)$/i;

/** Column sizes measured from a report result (see {@link measureColumnSizes}). */
export interface ColumnSizes {
  /** Comfortable width: the header (on up to two lines) and every value on one line, within sensible limits. */
  natural: Record<string, number>;
  /**
   * Narrowest width that still shows everything: amounts and dates with the header wrapped onto up
   * to three lines; short and fixed-format text (dates with times, phone numbers, terms) in full.
   */
  compact: Record<string, number>;
  /** Text columns with free text (memos, names, accounts) that may be shortened when the report is too wide. */
  long: Record<string, boolean>;
  /**
   * Narrowest width of each text column when its text wraps onto several lines: its widest word
   * (or account name part, or date and time of a date with a time) still fits, so wrapping never
   * cuts a word. Free text never goes below 80 px; text up to 80 px wide is never broken.
   */
  wrapMin?: Record<string, number>;
  /**
   * Text columns whose text may wrap onto several lines when they are narrowed: the free text and
   * the fixed-format text ("Statement Charge", "Due on receipt", "10/19/2026 17:00:00").
   */
  wrap?: Record<string, boolean>;
  /**
   * Fixed-format text columns: width that keeps nine values in ten on one line (only their longest
   * values wrap when the column is narrowed to it).
   */
  typical?: Record<string, number>;
  /** Fixed-format columns made mostly of dates with times, phone numbers or numbers: narrowed last. */
  fixedValues?: Record<string, boolean>;
  /** Narrowest width that still shows the whole header of each column (on up to three lines). */
  headMin?: Record<string, number>;
}

/** Width of a header wrapped onto at most `lines` lines (greedy line breaks at spaces, bold header font). */
function wrappedHeaderWidth(label: string, lines: number): number {
  const words = label.split(/\s+/).filter(Boolean);
  if (!words.length) return 0;
  const ws = words.map((x) => textWidth(x, true));
  const space = textWidth(' ', true);
  const fits = (max: number) => {
    let n = 1;
    let cur = 0;
    for (const x of ws) {
      if (!cur) cur = x;
      else if (cur + space + x <= max) cur += space + x;
      else {
        n++;
        cur = x;
      }
    }
    return n <= lines;
  };
  let lo = Math.max(...ws);
  if (fits(lo)) return lo;
  let hi = textWidth(label, true);
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** Numeric columns whose widest value is the one with the most digits: amounts and computed percents (fixed decimals). */
const byExtremes = (c: ReportColumn) => c.type === 'money' || (c.type === 'percent' && !isRateCol(c));

/**
 * Sizes of every column: the natural width (wide enough for the header and the values, the text
 * sampled for very long reports, within sensible limits), the narrowest width that still shows
 * everything, and which text columns hold free text that may be shortened. Amounts are never
 * sampled: the widest formatted amount of every row (with its minus sign or parentheses) sizes
 * its column, so an amount is never cut. Labels of rows whose next cells are empty (section
 * headers, detail report totals) may spill into those empty cells, so they do not widen the column.
 */
export function measureColumnSizes(res: ReportResult, cols: ReportColumn[], d: DisplayOptions): ColumnSizes {
  const rows = res.rows ?? [];
  // long reports: every total row and every amount, plus a sample of the text of the transaction rows
  const step = rows.length > MAX_SAMPLE ? Math.ceil(rows.length / MAX_SAMPLE) : 1;
  const w: Record<string, number> = {};
  const compact: Record<string, number> = {};
  const long: Record<string, boolean> = {};
  const wrapMin: Record<string, number> = {};
  const wrap: Record<string, boolean> = {};
  const typical: Record<string, number> = {};
  const fixedValues: Record<string, boolean> = {};
  const headMin: Record<string, number> = {};
  /** Width of every text value of each text column (for the typical width of fixed-format columns). */
  const textW: Record<string, number[]> = {};
  /** Widest text or date value (each one measured), and the widest number (quantities, rates, text in a numeric column). */
  const valW: Record<string, number> = {};
  const numW: Record<string, number> = {};
  /**
   * Amounts and computed percents: the highest and the lowest value in bold rows (totals, sections)
   * and in regular (transaction) rows. Formatted, the one with the most digits is the widest, the
   * lowest one with its minus sign or parentheses.
   */
  const hiB: Record<string, number> = {};
  const loB: Record<string, number> = {};
  const hiR: Record<string, number> = {};
  const loR: Record<string, number> = {};
  const cache = new Map<string, number>();
  const seen: Record<string, number> = {};
  const fixedHits: Record<string, number> = {};
  /** Widest piece that cannot be broken of the text values (for wrapping, see {@link wrapPieces}). */
  const pieceW: Record<string, number> = {};
  for (const c of cols) {
    // headers may wrap onto two lines when they are long; short ones stay on one line
    const words = (c.label || '').split(/[\s/]+/);
    const full = textWidth(c.label || '', true);
    // descriptive headers ("Open Balance") may wrap; dates and periods ("Jan 1 - Oct 17, 26") stay on one line
    const wraps = words.length > 1 && c.label.length > 10 && (!/\d/.test(c.label) || c.label.length > 22);
    const head = Math.max(wraps ? full * 0.56 : full, ...words.map((x) => textWidth(x, true)));
    w[c.key] = head * 1.05 + CELL_PAD + 6;
    valW[c.key] = 0;
    numW[c.key] = 0;
    hiB[c.key] = -Infinity;
    loB[c.key] = Infinity;
    hiR[c.key] = -Infinity;
    loR[c.key] = Infinity;
    seen[c.key] = 0;
    fixedHits[c.key] = 0;
  }
  const labelCol = cols.find((c) => c.key === 'label');
  const numCols = cols.filter((c) => c !== labelCol && c.type !== 'text' && c.type !== 'date');
  const extremes = numCols.map(byExtremes);
  // labels that spill over the empty cells after them: [text width, index of the first non-empty column]
  const spills: [number, number][] = [];
  for (let f = 0; f < rows.length; f++) {
    const r = rows[f];
    const cells = r.cells ?? {};
    const bold = r.kind !== 'data';
    // amounts: every row (a sample could miss the widest one)
    for (let ni = 0; ni < numCols.length; ni++) {
      const c = numCols[ni];
      const v = cells[c.key];
      if (v === null || v === undefined || v === '') continue;
      if (extremes[ni] && typeof v === 'number') {
        if (!Number.isFinite(v)) continue;
        if (bold) {
          if (v > hiB[c.key]) hiB[c.key] = v;
          if (v < loB[c.key]) loB[c.key] = v;
        } else {
          if (v > hiR[c.key]) hiR[c.key] = v;
          if (v < loR[c.key]) loR[c.key] = v;
        }
        continue;
      }
      const t = formatCell(v, c, d).text;
      if (t) {
        const nw = numberWidth(t, bold);
        if (nw > numW[c.key]) numW[c.key] = nw;
      }
    }
    if (step > 1 && r.kind === 'data' && f % step !== 0) continue;
    for (let ci = 0; ci < cols.length; ci++) {
      const c = cols[ci];
      if (c !== labelCol && c.type !== 'text' && c.type !== 'date') continue;
      const v = cells[c.key];
      if (v === null || v === undefined || v === '') continue;
      if (c === labelCol) {
        const tw = cellTextWidth(String(v), bold, cache) + (r.level ?? 0) * INDENT + (r.kind === 'section' ? 16 : 0) + CELL_PAD + 4;
        // a label followed by empty cells spills over them, so it sizes the column only partly
        let k = ci + 1;
        while (k < cols.length && (cells[cols[k].key] === null || cells[cols[k].key] === undefined || cells[cols[k].key] === '')) k++;
        if (k > ci + 1) spills.push([tw, k]);
        else if (tw > w[c.key]) w[c.key] = tw;
        continue;
      }
      const t = formatCell(v, c, d).text;
      const tw = cellTextWidth(t, bold, cache) + CELL_PAD + 2;
      if (tw > valW[c.key]) valW[c.key] = tw;
      if (c.type === 'text') {
        seen[c.key]++;
        (textW[c.key] ??= []).push(tw);
        if (FIXED_VALUE.test(t)) fixedHits[c.key]++;
        // only text wider than a narrow column can wrap; shorter text needs no piece widths
        if (tw > 80) pieceW[c.key] = Math.max(pieceW[c.key] ?? 0, widestPiece(t, bold) + CELL_PAD + 2);
        else pieceW[c.key] = Math.max(pieceW[c.key] ?? 0, tw);
      }
    }
  }
  for (let ni = 0; ni < numCols.length; ni++) {
    if (!extremes[ni]) continue;
    const c = numCols[ni];
    const ext = (v: number, b: boolean) => {
      if (!Number.isFinite(v)) return;
      const t = formatCell(v, c, d).text;
      if (t) numW[c.key] = Math.max(numW[c.key], numberWidth(t, b));
    };
    ext(hiB[c.key], true);
    ext(loB[c.key], true);
    ext(hiR[c.key], false);
    ext(loR[c.key], false);
  }
  for (const c of cols) {
    const vw = Math.max(valW[c.key], numW[c.key] ? numW[c.key] + CELL_PAD + 2 : 0);
    if (vw > w[c.key]) w[c.key] = vw;
    let min = 34;
    let max = 250;
    if (c.key === 'label') {
      min = res.columns.length > 2 && !c.label ? 28 : 120;
      max = 420;
    } else if (c.type === 'money') {
      min = 74;
      max = 160;
    } else if (c.type === 'date') {
      min = 78;
      max = 110;
    } else if (isNumericCol(c)) {
      min = 52;
      max = 130;
    } else if (/memo|desc|bill|address/i.test(c.key)) max = 230;
    // a long header may be capped, the widest amount never is
    if (isNumericCol(c)) max = Math.max(max, Math.ceil(vw));
    w[c.key] = Math.round(Math.max(min, Math.min(max, w[c.key])));
    // the narrowest width that still shows the whole header (on up to three lines) and every value
    const head3 = c.label ? wrappedHeaderWidth(c.label, 3) + CELL_PAD + 4 : 0;
    headMin[c.key] = Math.ceil(head3);
    const floor = c.type === 'money' ? 52 : 34;
    compact[c.key] = c.key === 'label' ? w[c.key] : Math.round(Math.min(w[c.key], Math.max(floor, vw, head3)));
    long[c.key] =
      c.type === 'text' && c.key !== 'label' && !FIXED_COL.test(c.key) && !FIXED_COL.test(c.label) && !(seen[c.key] > 0 && fixedHits[c.key] >= seen[c.key] * 0.8);
    // wrapping free text: never narrower than its widest word, its header (on up to three lines) or 80 px
    if (long[c.key]) {
      wrapMin[c.key] = Math.round(Math.min(w[c.key], Math.max(80, pieceW[c.key] ?? 0, head3)));
      wrap[c.key] = true;
    } else if (c.type === 'text' && c.key !== 'label') {
      // fixed-format text (types, terms, numbers, dates with times, phone numbers) also wraps, but
      // only when the report cannot fit otherwise: first just its few longest values (typical
      // width), then down to its widest word; text up to 80 px wide never breaks
      wrap[c.key] = true;
      wrapMin[c.key] = Math.round(Math.min(w[c.key], Math.max(34, pieceW[c.key] ?? 0, head3)));
      const tws = textW[c.key] ?? [];
      tws.sort((a, b) => a - b);
      const p90 = tws.length ? tws[Math.max(0, Math.ceil(tws.length * 0.9) - 1)] : 0;
      typical[c.key] = Math.round(Math.min(w[c.key], Math.max(wrapMin[c.key], p90, head3)));
      fixedValues[c.key] = seen[c.key] > 0 && fixedHits[c.key] >= seen[c.key] * 0.8;
    }
  }
  // detail reports: the empty-headed label column only needs room for the indentation of totals
  if (labelCol && !labelCol.label && cols.length > 3) {
    let maxLevel = 0;
    for (let f = 0; f < rows.length; f += step) maxLevel = Math.max(maxLevel, rows[f].level ?? 0);
    w.label = Math.max(w.label, Math.min(120, (maxLevel + 1) * INDENT + 16));
  }
  // spilling labels: the label column grows by what the empty cells after it cannot hold
  if (labelCol) {
    const li = cols.indexOf(labelCol);
    let need = w.label;
    for (const [tw, k] of spills) {
      let room = 0;
      for (let j = li + 1; j < k; j++) room += w[cols[j].key];
      need = Math.max(need, tw - room);
    }
    w.label = Math.round(Math.min(420, Math.max(w.label, need)));
    compact.label = w.label;
  }
  return { natural: w, compact, long, wrapMin, wrap, typical, fixedValues, headMin };
}

/** Natural width of every column (see {@link measureColumnSizes}). */
export function measureColumns(res: ReportResult, cols: ReportColumn[], d: DisplayOptions): Record<string, number> {
  return measureColumnSizes(res, cols, d).natural;
}

/** Narrowest width of free text (memos, names, accounts) when the report cannot fit otherwise. */
const HARD_MIN_FREE = 64;
/** Narrowest width of types, terms and other fixed-format words when the report cannot fit otherwise. */
const HARD_MIN_FIXED = 56;
/** Narrowest width of numbers, codes and dates with times when the report cannot fit otherwise. */
const HARD_MIN_VALUES = 48;

/** Options of {@link fitColumns}. */
export interface FitOptions {
  /** Narrowest readable widths, the free-text and the wrapping columns, from {@link measureColumnSizes}. */
  sizes?: Pick<ColumnSizes, 'compact' | 'long' | 'wrapMin' | 'wrap' | 'typical' | 'fixedValues' | 'headMin'>;
  /** Squeeze harder: the Customize panel takes part of the window and the amounts must stay in view. */
  tight?: boolean;
  /** How far past `avail` the columns may still go without the report scrolling sideways (default 0). */
  slack?: number;
}

/**
 * Narrows columns so a wide report fits the window; columns the
 * user resized keep their width. `avail` is the room for the columns. In order: amounts and dates
 * wrap their headers onto up to three lines; free text (memos, names, accounts) is narrowed to a
 * readable width and then down to its widest word, its text wrapping onto several lines (see
 * {@link wrapLineCount}); then fixed-format text (types, terms, numbers, dates with times, phone
 * numbers) wraps too: first only its few longest values, then types and terms down to their widest
 * word, and last dates with times and phone numbers at their spaces; if that is still not enough,
 * text goes below its widest word (long words break inside, the full text on hover). All of this
 * only when it lets the report fit. Row labels keep their width (they are what the report is
 * about) and amounts are never narrowed below their widest value. Past that the report scrolls
 * sideways.
 */
export function fitColumns(cols: ReportColumn[], natural: Record<string, number>, user: Record<string, number>, avail: number, opts: FitOptions = {}): Record<string, number> {
  const w: Record<string, number> = {};
  for (const c of cols) w[c.key] = user[c.key] ?? natural[c.key] ?? 80;
  const total = cols.reduce((s, c) => s + w[c.key], 0);
  if (!avail || total <= avail) return w;
  const nat = (c: ReportColumn) => natural[c.key] ?? 80;
  const compact = opts.sizes?.compact;
  const long = opts.sizes?.long;
  // Water filling: the chosen columns wider than a common cap are cut to it, never below their floor.
  const fill = (pick: (c: ReportColumn) => boolean, floor: (c: ReportColumn) => number) => {
    const flex = cols.filter((c) => user[c.key] === undefined && pick(c) && w[c.key] > floor(c));
    if (!flex.length) return cols.reduce((s, c) => s + w[c.key], 0) <= avail + 1;
    const fixedW = cols.reduce((s, c) => s + (flex.includes(c) ? 0 : w[c.key]), 0);
    const widthAt = (cap: number) => flex.reduce((s, c) => s + Math.max(floor(c), Math.min(w[c.key], cap)), 0);
    let lo = 0;
    let hi = Math.max(...flex.map((c) => w[c.key]));
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      if (fixedW + widthAt(mid) > avail) hi = mid;
      else lo = mid;
    }
    for (const c of flex) w[c.key] = Math.round(Math.max(floor(c), Math.min(w[c.key], lo)));
    return cols.reduce((s, c) => s + w[c.key], 0) <= avail + 1;
  };
  // 1) amounts and dates give room first: their headers wrap onto up to three lines
  if (compact && fill((c) => c.type !== 'text', (c) => Math.min(w[c.key], compact[c.key] ?? nat(c)))) return w;
  // 2) free text is shortened to a readable width (row labels keep up to 210 px)
  const labelFloor = Math.min(natural.label ?? 120, 210);
  const freeText = (c: ReportColumn) => c.type === 'text' && (c.key === 'label' || (long ? !!long[c.key] : true));
  if (fill(freeText, (c) => (c.key === 'label' ? labelFloor : Math.min(nat(c), 132)))) return w;
  if (fill(freeText, (c) => (c.key === 'label' ? labelFloor : Math.min(nat(c), 112)))) return w;
  // 2b) free text wraps onto several lines (the row grows), down to its widest word
  const wrapMin = opts.sizes?.wrapMin;
  if (wrapMin && long) {
    const wraps = (c: ReportColumn) => c.type === 'text' && c.key !== 'label' && !!long[c.key];
    if (fill(wraps, (c) => Math.min(nat(c), wrapMin[c.key] ?? 80))) return w;
  }
  // 2c) fixed-format text wraps (the rows grow) when that lets the report fit: first just its few
  //     longest values ("CLS-261005" among check numbers), then types and terms ("Statement Charge",
  //     "Due on receipt") down to their widest word, and last dates with times and phone numbers
  //     ("10/19/2026 17:00:00") at their spaces
  const wrapFixed = opts.sizes?.wrap;
  if (wrapMin && wrapFixed) {
    const before = { ...w };
    const typical = opts.sizes?.typical ?? {};
    const values = opts.sizes?.fixedValues ?? {};
    const fixed = (c: ReportColumn) => c.type === 'text' && c.key !== 'label' && !!wrapFixed[c.key] && !long?.[c.key];
    const atLeast = (c: ReportColumn, px: number | undefined) => Math.min(nat(c), Math.max(px ?? nat(c), wrapMin[c.key] ?? 34));
    if (fill(fixed, (c) => atLeast(c, typical[c.key]))) return w;
    if (fill((c) => fixed(c) && !values[c.key], (c) => atLeast(c, wrapMin[c.key]))) return w;
    if (fill(fixed, (c) => atLeast(c, wrapMin[c.key]))) return w;
    // 2d) still too wide: rather than scroll sideways, text goes below its widest word, the widest
    //     columns first (free text, types and terms), last dates with times and numbers. A word
    //     longer than its cell breaks inside it (cut with "…" past the last line) and the full
    //     text shows on hover; headers stay whole and amounts are never narrowed
    const headMin = opts.sizes?.headMin ?? {};
    const hard = (c: ReportColumn, px: number) => Math.min(nat(c), Math.max(px, headMin[c.key] ?? 0));
    const anyText = (c: ReportColumn) => c.type === 'text' && c.key !== 'label' && (!!long?.[c.key] || fixed(c));
    if (fill((c) => anyText(c) && !values[c.key], (c) => hard(c, long?.[c.key] ? HARD_MIN_FREE : HARD_MIN_FIXED))) return w;
    if (fill(anyText, (c) => hard(c, values[c.key] ? HARD_MIN_VALUES : long?.[c.key] ? HARD_MIN_FREE : HARD_MIN_FIXED))) return w;
    // still too wide to show without scrolling sideways: taller rows would not spare the scrolling,
    // so this text keeps its width (one line)
    if (cols.reduce((s, c) => s + w[c.key], 0) > avail + (opts.slack ?? 0) + 1) Object.assign(w, before);
    else return w;
  }
  // 3) only while the Customize panel takes part of the window: every text column gives up room
  //    so the amounts it changes stay in view
  if (opts.tight && fill((c) => c.type === 'text', (c) => Math.min(nat(c), c.key === 'label' ? Math.min(labelFloor, 150) : 80))) return w;
  // past that the report scrolls sideways instead of cutting columns to a few letters
  return w;
}

// ---------------------------------------------------------------------------
// Drill-down

/** Drill-down target of an amount cell (the column's own, else the row's). */
export function cellDrill(row: ReportRow, colKey: string): ReportDrill | undefined {
  return row.cellDrills?.[colKey] ?? row.drill;
}

/** Opens the report a drill-down points to. */
export function openDrill(drill: ReportDrill): void {
  openWindow('report', { key: drill.report, params: drill.params });
}

/** Opens the form of a transaction by id (the type comes from the server). */
export async function openTxnById(id: number): Promise<void> {
  try {
    const t = await queryClient.fetchQuery({
      queryKey: ['txn', id],
      queryFn: ({ signal }) => api.get<Txn>(`/txns/${id}`, { signal, noPrompt: true }),
      staleTime: 10_000,
    });
    openTxn(t.type, t.id);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) toast('This transaction no longer exists. It was deleted.', { kind: 'info' });
    else toast(e instanceof Error ? e.message : 'The transaction could not be opened.', { kind: 'error' });
  }
}

// ---------------------------------------------------------------------------
// Print and CSV

/** Header lines of a report as shown (respecting the header options). */
export interface HeaderText {
  company: string;
  title: string;
  subtitle: string;
  basis: string;
  prepared: Date;
}

/** The header text with the custom title/subtitle applied. */
export function headerText(res: ReportResult, d: DisplayOptions, fallbackTitle: string): HeaderText {
  return {
    company: res.companyName,
    title: d.title.trim() || res.title || fallbackTitle,
    subtitle: d.subtitle.trim() || res.dateRangeLabel,
    basis: res.basis,
    prepared: res.generatedAt ? new Date(res.generatedAt) : new Date(),
  };
}

const on = (d: DisplayOptions, p: HeaderPart) => !d.hdrOff.includes(p);

/** Printable HTML of the report (the rows as shown). */
export function reportPrintHtml(
  h: HeaderText,
  cols: ReportColumn[],
  widths: Record<string, number>,
  rows: VisibleRow[],
  d: DisplayOptions,
  /** Text columns whose text wraps onto several lines (as on screen) instead of being cut. */
  wrap?: Record<string, boolean>,
): { html: string; css: string } {
  const total = cols.reduce((s, c) => s + (widths[c.key] ?? 80), 0) || 1;
  const groups = headerGroups(cols);
  const landscape = total > 700 || cols.length > 9;
  // printable width at 96 px per inch (Letter, 0.45 in margins); narrow reports keep their own width
  const pageW = landscape ? 950 : 715;
  const fits = total <= pageW;
  const colW = (k: string) => (fits ? `${widths[k] ?? 80}px` : `${(((widths[k] ?? 80) / total) * 100).toFixed(2)}%`);
  const colgroup = `<colgroup>${cols.map((c) => `<col style="width:${colW(c.key)}">`).join('')}</colgroup>`;
  const tableStyle = fits ? ` style="width:${total}px;margin:0 auto"` : '';
  let head = '';
  if (groups) {
    head += `<tr class="grp"><th></th>${groups.groups.map((g) => `<th colspan="${g.keys.length}" class="c">${escHtml(g.label)}</th>`).join('')}</tr>`;
  }
  head += `<tr>${cols
    .map((c) => `<th class="${isNumericCol(c) ? 'num' : ''}">${escHtml(groups && c.key !== 'label' ? (groups.sub[c.key] ?? c.label) : c.label)}</th>`)
    .join('')}</tr>`;
  const body = rows
    .map((v) => {
      const r = v.row;
      const cls = `k-${v.collapsed && v.drillRow !== r ? v.drillRow.kind : r.kind}`;
      const tds = cols
        .map((c) => {
          const raw = v.cells[c.key];
          if (c.key === 'label') {
            const pad = (r.level ?? 0) * INDENT;
            return `<td class="lbl" style="padding-left:${pad + 4}px">${escHtml(raw === null || raw === undefined ? '' : String(raw))}</td>`;
          }
          const f = formatCell(raw, c, d);
          const num = isNumericCol(c);
          const amt = num && f.text !== '' ? ' amt' : '';
          const wr = !num && !!wrap?.[c.key];
          // wrapped text may also break after ":" "/" "-" (account paths, codes), as on screen
          const text = wr ? wrapPieces(f.text).map(escHtml).join('<wbr>') : escHtml(f.text);
          return `<td class="${num ? 'num' : ''}${amt}${wr ? ' wrap' : ''}${f.negative && d.red ? ' neg' : ''}">${text}</td>`;
        })
        .join('');
      return `<tr class="${cls}">${tds}</tr>`;
    })
    .join('');
  const left = [
    on(d, 'date') ? h.prepared.toLocaleDateString('en-US') : '',
    on(d, 'time') ? h.prepared.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '',
    on(d, 'basis') ? h.basis : '',
  ]
    .filter(Boolean)
    .map((s) => `<div>${escHtml(s)}</div>`)
    .join('');
  const header =
    `<div class="hdr"><div class="hdr-left">${left}</div>` +
    (on(d, 'company') ? `<div class="co">${escHtml(h.company)}</div>` : '') +
    (on(d, 'title') ? `<div class="ti">${escHtml(h.title)}</div>` : '') +
    (on(d, 'subtitle') && h.subtitle ? `<div class="st">${escHtml(h.subtitle)}</div>` : '') +
    `</div>`;
  const footer = d.footer.trim() ? `<div class="ftr">${escHtml(d.footer.trim())}</div>` : '';
  const html = `${header}<table${tableStyle}>${colgroup}<thead>${head}</thead><tbody>${body}</tbody></table>${footer}`;
  const css = `
    @page { size: ${landscape ? 'landscape' : 'portrait'}; margin: 0.45in; }
    body { font-size: 10px; }
    .hdr { position: relative; text-align: center; margin-bottom: 10px; min-height: 44px; }
    .hdr-left { position: absolute; left: 0; top: 0; text-align: left; font-size: 9px; font-weight: bold; line-height: 13px; }
    .co { font-size: 13px; font-weight: bold; }
    .ti { font-size: 16px; font-weight: bold; margin-top: 2px; }
    .st { font-size: 11px; font-weight: bold; margin-top: 2px; }
    table { table-layout: fixed; }
    th { font-size: 10px; white-space: normal; vertical-align: bottom; border-bottom: 1px solid #000; }
    th.c { text-align: center; border-bottom: 1px solid #000; }
    tr.grp th { border-bottom: 1px solid #000; }
    td { padding: 1px 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; vertical-align: top; }
    td.lbl { overflow: visible; }
    td.wrap { white-space: normal; overflow-wrap: anywhere; }
    tr.k-section td, tr.k-subtotal td, tr.k-total td, tr.k-grandtotal td { font-weight: bold; }
    tr.k-subtotal td.amt, tr.k-total td.amt { border-top: 1px solid #000; }
    tr.k-grandtotal td.amt { border-top: 1px solid #000; border-bottom: 3px double #000; }
    tr.k-blank td { height: 10px; }
    td.neg { color: #c00; }
    .ftr { margin-top: 12px; text-align: center; font-size: 10px; }
  `;
  return { html, css };
}

/** CSV rows of the report (header lines, column headers, rows as shown). */
export function reportCsvRows(h: HeaderText, cols: ReportColumn[], rows: VisibleRow[], d: DisplayOptions): (string | number)[][] {
  const out: (string | number)[][] = [];
  if (on(d, 'company')) out.push([h.company]);
  if (on(d, 'title')) out.push([h.title]);
  if (on(d, 'subtitle') && h.subtitle) out.push([h.subtitle]);
  if (on(d, 'basis') && h.basis) out.push([h.basis]);
  if (out.length) out.push([]);
  const groups = headerGroups(cols);
  if (groups) out.push(['', ...groups.groups.flatMap((g) => g.keys.map((_, i) => (i === 0 ? g.label : '')))]);
  out.push(cols.map((c) => (groups && c.key !== 'label' ? (groups.sub[c.key] ?? c.label) : c.label)));
  for (const v of rows) {
    out.push(
      cols.map((c) => {
        const raw = v.cells[c.key];
        if (c.key === 'label') return raw === null || raw === undefined || raw === '' ? '' : '  '.repeat(v.row.level ?? 0) + String(raw);
        return csvValue(raw, c, d);
      }),
    );
  }
  if (d.footer.trim()) out.push([], [d.footer.trim()]);
  return out;
}

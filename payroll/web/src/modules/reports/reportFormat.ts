// Report display logic shared by the screen, print and CSV export (ported from the SerieX Books
// report viewer): display options (number format, header/footer, hidden columns) stored as "ui.*"
// report parameters, row structure (collapsible sections), visible rows, column widths and the
// drill-down helpers (row.target opens the payroll record, row.drill opens another report).
import type { ReportColumn, ReportDrill, ReportResult, ReportRow, ReportTarget } from '@/api/types';
import { escHtml } from '@/util/print';
import { fmtDate } from '@/util/format';
import { openRecord, openWindow } from '@/windows/windowStore';

// ---------------------------------------------------------------------------
// Display options

/** How negative numbers are written. */
export type NegStyle = 'minus' | 'parens' | 'trailing';

/** Header parts that can be turned off. */
export type HeaderPart = 'company' | 'title' | 'subtitle' | 'date' | 'time' | 'basis';

/** Everything the Customize panel changes that the server does not need to know. */
export interface DisplayOptions {
  /** Columns hidden on screen. */
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

const NUMERIC = new Set(['money', 'number', 'percent', 'hours']);

/** True for money / number / percent / hours columns. */
export const isNumericCol = (c: ReportColumn) => NUMERIC.has(c.type);

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
  switch (col.type) {
    case 'money': {
      let x = d.thousands ? v / 1000 : v;
      const dec = d.noCents ? 0 : 2;
      x = Number(x.toFixed(dec));
      if (x === 0) return { text: d.blankZero ? '' : nf[dec].format(0), negative: false };
      return { text: signed(nf[dec].format(Math.abs(x)), x < 0, d.neg), negative: x < 0 };
    }
    case 'percent': {
      const x = Number(v.toFixed(2));
      if (x === 0 && d.blankZero) return { text: '', negative: false };
      return { text: signed(qtyFmt.format(Math.abs(x)), x < 0, d.neg) + '%', negative: x < 0 };
    }
    case 'hours': {
      const x = Number(v.toFixed(2));
      if (x === 0 && d.blankZero) return { text: '', negative: false };
      return { text: signed(nf[2].format(Math.abs(x)), x < 0, d.neg), negative: x < 0 };
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
    if (col.type === 'percent') return `${Number(v.toFixed(2))}%`;
    return v;
  }
  return col.type === 'date' ? fmtDate(String(v)) : String(v);
}

// ---------------------------------------------------------------------------
// Column headers: Payroll Summary groups "<Employee> Hours / Rate / Amount" under the employee
// name.

const SUFFIXES: Record<string, string> = { hours: 'Hours', rate: 'Rate', amount: 'Amount' };

/** A header cell spanning several columns. */
export interface HeaderGroup {
  label: string;
  keys: string[];
}

/** Two-level header for "<prefix>_hours / _rate / _amount" column sets, else null. */
export function headerGroups(cols: ReportColumn[]): { groups: HeaderGroup[]; sub: Record<string, string> } | null {
  const rest = cols.filter((c) => c.key !== 'label');
  if (rest.length < 2) return null;
  const re = /^(.+)_(hours|rate|amount)$/;
  if (!rest.every((c) => re.test(c.key))) return null;
  const groups: (HeaderGroup & { prefix: string })[] = [];
  const sub: Record<string, string> = {};
  for (const c of rest) {
    const [, prefix, kind] = re.exec(c.key)!;
    const word = SUFFIXES[kind];
    const label = c.label.endsWith(' ' + word) ? c.label.slice(0, -word.length - 1) : c.label;
    const last = groups[groups.length - 1];
    if (last && last.prefix === prefix) last.keys.push(c.key);
    else groups.push({ label, keys: [c.key], prefix });
    sub[c.key] = word;
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
export function analyze(rows: ReportRow[]): Structure {
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
export function visibleRows(rows: ReportRow[], st: Structure, collapsed: Set<number>, d: DisplayOptions, numericKeys: string[]): VisibleRow[] {
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

/** Sections collapsed by "Collapse all" (the innermost ones). */
export function collapseAllSet(st: Structure): Set<number> {
  const s = new Set<number>();
  for (let i = 0; i < st.collapsible.length; i++) if (st.collapsible[i] && st.leaf[i]) s.add(i);
  return s;
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

/** Width of a number as shown with tabular (equal width) digits. */
function numberWidth(s: string, bold = false): number {
  return textWidth(s.replace(/[0-9]/g, '0'), bold) + 2;
}

const MAX_SAMPLE = 2500;

/**
 * Natural width of every column: wide enough for the header and the values (sampled for very
 * long reports), within sensible limits. Labels of rows whose next cells are empty (section
 * headers, detail report totals) may spill into those empty cells, so they do not widen the column.
 */
export function measureColumns(res: ReportResult, cols: ReportColumn[], d: DisplayOptions): Record<string, number> {
  const rows = res.rows;
  const step = rows.length > MAX_SAMPLE ? Math.ceil(rows.length / MAX_SAMPLE) : 1;
  const groups = headerGroups(cols);
  const w: Record<string, number> = {};
  const longest: Record<string, string> = {};
  for (const c of cols) {
    const label = groups && c.key !== 'label' ? (groups.sub[c.key] ?? c.label) : c.label || '';
    const words = label.split(/[\s/]+/);
    const full = textWidth(label, true);
    const wraps = words.length > 1 && label.length > 10 && (!/\d/.test(label) || label.length > 22);
    const head = Math.max(wraps ? full * 0.56 : full, ...words.map((x) => textWidth(x, true)));
    w[c.key] = head * 1.05 + CELL_PAD + 6;
    longest[c.key] = '';
  }
  const labelCol = cols.find((c) => c.key === 'label');
  const spills: [number, number][] = [];
  for (let f = 0; f < rows.length; f++) {
    const r = rows[f];
    if (step > 1 && r.kind === 'data' && f % step !== 0) continue;
    for (let ci = 0; ci < cols.length; ci++) {
      const c = cols[ci];
      const v = r.cells[c.key];
      if (v === null || v === undefined || v === '') continue;
      if (c === labelCol) {
        const bold = r.kind !== 'data';
        const tw = textWidth(String(v), bold) + (r.level ?? 0) * INDENT + (r.kind === 'section' ? 16 : 0) + CELL_PAD + 4;
        let k = ci + 1;
        while (k < cols.length && (r.cells[cols[k].key] === null || r.cells[cols[k].key] === undefined || r.cells[cols[k].key] === '')) k++;
        if (k > ci + 1) spills.push([tw, k]);
        else if (tw > w[c.key]) w[c.key] = tw;
        continue;
      }
      const t = formatCell(v, c, d).text;
      if (t.length > longest[c.key].length) longest[c.key] = t;
      if (c.type === 'text' && t.length > 12) {
        const tw = textWidth(t) + CELL_PAD;
        if (tw > w[c.key]) w[c.key] = tw;
      }
    }
  }
  for (const c of cols) {
    const lw = (c.type === 'text' || c.type === 'date' ? textWidth(longest[c.key], true) : numberWidth(longest[c.key], true)) + CELL_PAD + 4;
    if (lw > w[c.key]) w[c.key] = lw;
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
    } else if (c.type === 'number' || c.type === 'percent' || c.type === 'hours') {
      min = 52;
      max = 130;
    } else if (/memo|desc|address|summary|problem/i.test(c.key)) max = 230;
    w[c.key] = Math.round(Math.max(min, Math.min(max, w[c.key])));
  }
  // grouped headers (employee name over Hours / Rate / Amount): the group must fit its name
  if (groups) {
    for (const g of groups.groups) {
      const need = textWidth(g.label, true) + CELL_PAD;
      const have = g.keys.reduce((s, k) => s + (w[k] ?? 0), 0);
      if (need > have && g.keys.length) {
        const extra = Math.ceil((need - have) / g.keys.length);
        for (const k of g.keys) w[k] = (w[k] ?? 0) + extra;
      }
    }
  }
  if (labelCol && !labelCol.label && cols.length > 3) {
    let maxLevel = 0;
    for (let f = 0; f < rows.length; f += step) maxLevel = Math.max(maxLevel, rows[f].level ?? 0);
    w.label = Math.max(w.label, Math.min(120, (maxLevel + 1) * INDENT + 16));
  }
  if (labelCol) {
    const li = cols.indexOf(labelCol);
    let need = w.label;
    for (const [tw, k] of spills) {
      let room = 0;
      for (let j = li + 1; j < k; j++) room += w[cols[j].key];
      need = Math.max(need, tw - room);
    }
    w.label = Math.round(Math.min(420, Math.max(w.label, need)));
  }
  return w;
}

/**
 * Shrinks text columns (not the amounts) so a wide report fits the window; columns the user
 * resized keep their width. `avail` is the room for the columns.
 */
export function fitColumns(cols: ReportColumn[], natural: Record<string, number>, user: Record<string, number>, avail: number): Record<string, number> {
  const w: Record<string, number> = {};
  for (const c of cols) w[c.key] = user[c.key] ?? natural[c.key] ?? 80;
  const total = cols.reduce((s, c) => s + w[c.key], 0);
  if (!avail || total <= avail) return w;
  const flexible = (c: ReportColumn) => c.type === 'text' && user[c.key] === undefined;
  const fill = (floor: (c: ReportColumn) => number) => {
    const flex = cols.filter((c) => flexible(c) && w[c.key] > floor(c));
    if (!flex.length) return false;
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
  const labelFloor = Math.min(natural.label ?? 120, 210);
  if (fill((c) => Math.min(natural[c.key] ?? 80, c.key === 'label' ? labelFloor : 132))) return w;
  // 2) still too wide: cut every text column further only when that makes the report fit;
  //    otherwise keep readable values (social security numbers, statuses) and scroll sideways
  const before = { ...w };
  if (fill((c) => (c.key === 'label' ? labelFloor : c.key === 'type' ? 92 : 72))) return w;
  return before;
}

// ---------------------------------------------------------------------------
// Drill-down

/** Drill-down report of an amount cell (the row's drill). */
export function cellDrill(row: ReportRow): ReportDrill | undefined {
  return row.drill;
}

/** Opens the report a drill-down points to. */
export function openDrill(drill: ReportDrill): void {
  openWindow('report', { key: drill.report, params: drill.params });
}

/** Opens the payroll record behind a report row (paycheck, tax payment, adjustment, employee, item). */
export function openTarget(t: ReportTarget): void {
  openRecord(t.kind, t.id);
}

/** Tooltip of a row that opens a record. */
export function targetTitle(t: ReportTarget): string {
  switch (t.kind) {
    case 'paycheck':
      return 'Open the paycheck';
    case 'liability_payment':
      return 'Open the tax payment';
    case 'adjustment':
      return 'Open the tax balance adjustment';
    case 'employee':
      return 'Open the employee';
    case 'item':
      return 'Open the payroll item';
    default:
      return 'Open';
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
export function reportPrintHtml(h: HeaderText, cols: ReportColumn[], widths: Record<string, number>, rows: VisibleRow[], d: DisplayOptions): { html: string; css: string } {
  const total = cols.reduce((s, c) => s + (widths[c.key] ?? 80), 0) || 1;
  const groups = headerGroups(cols);
  const landscape = total > 700 || cols.length > 9;
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
          return `<td class="${num ? 'num' : ''}${amt}${f.negative && d.red ? ' neg' : ''}">${escHtml(f.text)}</td>`;
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
    td { padding: 1px 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    td.lbl { overflow: visible; }
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

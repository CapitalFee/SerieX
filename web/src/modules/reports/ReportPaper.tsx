// The report "paper": header block, sticky column header and the rows (virtual scrolling so
// 10,000+ rows stay fast). Single click on an amount = drill down; double click / Enter on a row
// opens its transaction or drill; ▸/▾ collapses sections; arrow keys move the selection.
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight } from 'lucide-react';
import type { ReportColumn } from '@/api/types';
import {
  INDENT,
  WRAP_LINE_H,
  WRAP_MAX_LINES,
  cellDrill,
  cellWidth,
  formatCell,
  headerGroups,
  isNumericCol,
  openDrill,
  openTxnById,
  wrapLineCount,
  wrapPieces,
  type DisplayOptions,
  type HeaderText,
  type VisibleRow,
} from './reportFormat';

/** Height of one report row in px. */
export const ROW_H = 22;
const OVERSCAN = 12;
/** Horizontal padding of the paper (room for the ▸ toggles of level 0 sections). */
const PAD_X = 20;
/** Width the paper adds to its columns: the padding and the border on both sides. */
export const PAPER_SIDES = PAD_X * 2 + 2;

let scrollbarW: number | null = null;
/** Width of a vertical scroll bar in this browser (the app styles them; 0 when they overlay the content). */
export function scrollbarWidth(): number {
  if (scrollbarW !== null) return scrollbarW;
  if (typeof document === 'undefined' || !document.body) return 0;
  const el = document.createElement('div');
  el.style.cssText = 'position:absolute;top:-9999px;left:-9999px;width:100px;height:100px;overflow:scroll;visibility:hidden';
  document.body.appendChild(el);
  scrollbarW = Math.max(0, el.offsetWidth - el.clientWidth);
  el.remove();
  return scrollbarW;
}

/** Props of {@link ReportPaper}. */
export interface ReportPaperProps {
  header: HeaderText;
  /** Show the header block (company, title, dates). */
  showHeader: boolean;
  cols: ReportColumn[];
  widths: Record<string, number>;
  onResize: (key: string, width: number) => void;
  rows: VisibleRow[];
  display: DisplayOptions;
  onToggle: (i: number) => void;
  /** The report can be sorted by clicking column headers. */
  sortable: boolean;
  onSort: (sort: string) => void;
  /** Content shown instead of the rows (a message, a prompt for a required choice). */
  placeholder?: ReactNode;
  /** Changes when a new result arrives (resets the selection). */
  resultId: string;
  /** Focus the report when its first rows arrive (arrow keys work at once). */
  autoFocus?: boolean;
  /**
   * Keep the right end (the amounts) in view: while true, a report wider than its room is scrolled
   * to its right end; when it turns false the earlier position comes back (Customize panel).
   */
  showEnd?: boolean;
  /**
   * Text columns whose text wraps onto several lines when it is wider than the column: free text
   * (names, memos, accounts) and fixed-format text narrowed to fit the window (types, terms,
   * numbers, dates with times). The row grows to fit (up to WRAP_MAX_LINES lines, the full text on hover).
   */
  wrap?: Record<string, boolean>;
}

const on = (d: DisplayOptions, p: string) => !d.hdrOff.includes(p as never);

/** One formatted cell. */
interface Fmt {
  text: string;
  negative: boolean;
}

/** A wrapped text with the extra break points of {@link wrapPieces} ("Job Expenses:" / "Subcontractors"). */
function withBreaks(text: string): ReactNode {
  const pieces = wrapPieces(text);
  if (pieces.length < 2) return text;
  return pieces.map((p, i) => (
    <Fragment key={i}>
      {i > 0 && !pieces[i - 1].endsWith(' ') ? <wbr /> : null}
      {p}
    </Fragment>
  ));
}

/** Index of the row at height y of the body (rows start at `tops`, ascending). */
function rowAtY(tops: Float64Array, n: number, y: number): number {
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tops[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function ReportPaper(props: ReportPaperProps) {
  const { header, showHeader, cols, widths, onResize, rows, display: d, onToggle, sortable, onSort, placeholder, resultId, autoFocus, showEnd, wrap } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, left: 0, height: 600, width: 1000, bodyTop: 0 });
  const [sel, setSel] = useState(-1);
  const frame = useRef(0);

  const groups = useMemo(() => headerGroups(cols), [cols]);
  const innerW = cols.reduce((s, c) => s + (widths[c.key] ?? 80), 0);
  const paperW = Math.max(innerW + PAD_X * 2, 620);
  // header, messages and footer stay centered in the visible part of a report wider than the window
  const visW = Math.max(360, Math.min(paperW, view.width) - PAD_X * 2 - 2);
  const stick = { width: visW, left: PAD_X } as const;
  // reports with row labels (accounts, customers, items) keep them in view while scrolling sideways;
  // detail reports, whose label column only holds group names, scroll as a whole
  const rowLabels = useMemo(() => {
    const lc = cols[0];
    if (!lc || lc.key !== 'label') return false;
    if (lc.label) return true;
    let data = 0;
    let labeled = 0;
    for (const v of rows) {
      if (v.row.kind !== 'data') continue;
      data++;
      if (v.cells.label !== null && v.cells.label !== undefined && v.cells.label !== '') labeled++;
    }
    return data > 0 && labeled * 2 >= data;
  }, [cols, rows]);
  const stickLabels = rowLabels && !placeholder && paperW > view.width + 1;
  /** How far the amounts have scrolled under a sticky label (its text may not spill over them). */
  const under = stickLabels ? view.left : 0;

  const measure = useCallback(() => {
    const sc = scrollRef.current;
    const body = bodyRef.current;
    if (!sc) return;
    let bodyTop = 0;
    if (body) {
      const a = body.getBoundingClientRect();
      const b = sc.getBoundingClientRect();
      bodyTop = a.top - b.top + sc.scrollTop;
    }
    setView((v) =>
      v.top === sc.scrollTop && v.left === sc.scrollLeft && v.height === sc.clientHeight && v.width === sc.clientWidth && v.bodyTop === bodyTop
        ? v
        : { top: sc.scrollTop, left: sc.scrollLeft, height: sc.clientHeight, width: sc.clientWidth, bodyTop },
    );
  }, []);

  useLayoutEffect(() => {
    measure();
  }, [measure, showHeader, rows.length, header.title, header.subtitle, cols.length, placeholder]);

  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(sc);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame.current);
    };
  }, [measure]);

  useEffect(() => setSel(-1), [resultId]);

  // Customize panel open: the amounts it changes are scrolled into view (and back afterwards)
  const savedLeft = useRef<number | null>(null);
  useLayoutEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    if (showEnd) {
      const end = sc.scrollWidth - sc.clientWidth;
      if (end <= 0) return;
      if (savedLeft.current === null) savedLeft.current = sc.scrollLeft;
      sc.scrollLeft = end;
    } else if (savedLeft.current !== null) {
      sc.scrollLeft = savedLeft.current;
      savedLeft.current = null;
    }
  }, [showEnd, innerW, rows.length]);

  // first rows: put the keyboard focus on the report unless the user is already in a field
  const focused = useRef(false);
  useEffect(() => {
    if (!autoFocus || focused.current || !rows.length) return;
    focused.current = true;
    const sc = scrollRef.current;
    const a = document.activeElement as HTMLElement | null;
    const win = sc?.closest('[data-window-id]');
    if (sc && (!a || a === document.body || a === win || (win && !win.contains(a)))) sc.focus({ preventScroll: true });
  }, [autoFocus, rows.length]);

  const onScroll = () => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(measure);
  };

  // rows whose free text wraps are taller: their lines and where each row starts (null when every
  // row is one line high)
  const layout = useMemo(() => {
    const wk = wrap ? cols.filter((c) => c.key !== 'label' && wrap[c.key] && !isNumericCol(c)) : [];
    if (!wk.length || placeholder) return null;
    const n = rows.length;
    const lines = new Uint8Array(n);
    const tops = new Float64Array(n + 1);
    let y = 0;
    let any = false;
    for (let i = 0; i < n; i++) {
      const v = rows[i];
      const bold = v.collapsed || v.row.kind !== 'data';
      let k = 1;
      for (const c of wk) {
        const val = v.cells[c.key];
        if (val === null || val === undefined || val === '') continue;
        k = Math.max(k, wrapLineCount(formatCell(val, c, d).text, widths[c.key] ?? 80, bold));
      }
      k = Math.min(k, WRAP_MAX_LINES);
      if (k > 1) any = true;
      lines[i] = k;
      tops[i] = y;
      y += ROW_H + (k - 1) * WRAP_LINE_H;
    }
    tops[n] = y;
    return any ? { lines, tops } : null;
  }, [rows, cols, widths, wrap, d, placeholder]);
  const rowTop = (i: number) => (layout ? layout.tops[i] : i * ROW_H);
  const rowH = (i: number) => (layout ? layout.tops[i + 1] - layout.tops[i] : ROW_H);
  const bodyH = layout ? layout.tops[rows.length] : rows.length * ROW_H;
  const rowAt = (y: number) => (layout ? rowAtY(layout.tops, rows.length, y) : Math.floor(y / ROW_H));

  const first = Math.max(0, rowAt(view.top - view.bodyTop) - OVERSCAN);
  const last = Math.min(rows.length, rowAt(view.top - view.bodyTop + view.height) + 1 + OVERSCAN);

  const ensureVisible = (idx: number) => {
    const sc = scrollRef.current;
    if (!sc || idx < 0) return;
    const y = view.bodyTop + rowTop(idx);
    const h = rowH(idx);
    const headH = (sc.querySelector('.rpt-colhead') as HTMLElement | null)?.offsetHeight ?? 24;
    if (y - headH < sc.scrollTop) sc.scrollTop = y - headH;
    else if (y + h > sc.scrollTop + sc.clientHeight) sc.scrollTop = y + h - sc.clientHeight;
  };

  // the opened form or report takes the keyboard (its shortcuts must not land in this report)
  const release = () => scrollRef.current?.blur();
  const zoomTxn = (id: number) => {
    release();
    void openTxnById(id);
  };
  const zoomReport = (drill: NonNullable<VisibleRow['row']['drill']>) => {
    release();
    openDrill(drill);
  };

  const activate = (v: VisibleRow) => {
    if (v.row.txnId) zoomTxn(v.row.txnId);
    else if (v.drillRow.drill) zoomReport(v.drillRow.drill);
    else if (v.collapsible) onToggle(v.i);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey || !rows.length) return;
    const page = Math.max(1, Math.floor(view.height / ROW_H) - 2);
    let n = sel;
    switch (e.key) {
      case 'ArrowDown':
        n = Math.min(rows.length - 1, sel + 1);
        break;
      case 'ArrowUp':
        n = Math.max(0, sel < 0 ? 0 : sel - 1);
        break;
      case 'PageDown':
        n = Math.min(rows.length - 1, Math.max(0, sel) + page);
        break;
      case 'PageUp':
        n = Math.max(0, sel - page);
        break;
      case 'Home':
        n = 0;
        break;
      case 'End':
        n = rows.length - 1;
        break;
      case 'Enter':
        if (sel >= 0 && rows[sel]) activate(rows[sel]);
        e.preventDefault();
        return;
      case 'ArrowLeft':
      case 'ArrowRight': {
        const v = rows[sel];
        if (v?.collapsible && v.collapsed === (e.key === 'ArrowRight')) onToggle(v.i);
        e.preventDefault();
        return;
      }
      default:
        return;
    }
    e.preventDefault();
    setSel(n);
    ensureVisible(n);
  };

  // ---- column resize
  const startResize = (e: React.MouseEvent, key: string) => {
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const w0 = widths[key] ?? 80;
    const move = (ev: MouseEvent) => onResize(key, Math.max(24, Math.round(w0 + ev.clientX - x0)));
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.style.cursor = '';
    };
    document.body.style.cursor = 'col-resize';
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const sortKey = d.sort.replace(/^-/, '');
  const sortDesc = d.sort.startsWith('-');
  const clickHeader = (c: ReportColumn) => {
    if (!sortable) return;
    if (sortKey !== c.key) onSort(c.key);
    else if (!sortDesc) onSort('-' + c.key);
    else onSort('');
  };

  const prepared = header.prepared;
  const leftInfo = [
    on(d, 'time') ? prepared.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '',
    on(d, 'date') ? prepared.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' }) : '',
    on(d, 'basis') ? header.basis : '',
  ].filter(Boolean);

  const renderRow = (v: VisibleRow, idx: number) => {
    const r = v.row;
    const kind = v.collapsed ? 'collapsed' : r.kind;
    const bold = v.collapsed || r.kind !== 'data';
    const fm: Fmt[] = cols.map((c) => (c.key === 'label' ? { text: v.cells.label == null ? '' : String(v.cells.label), negative: false } : formatCell(v.cells[c.key], c, d)));
    const lines = layout ? layout.lines[idx] : 1;
    return (
      <div
        key={v.i}
        className={`rpt-row k-${kind}` + (idx === sel ? ' rpt-sel' : '') + (r.txnId || v.drillRow.drill ? ' rpt-act' : '') + (lines > 1 ? ' rpt-tall' : '')}
        style={{ top: rowTop(idx), height: rowH(idx) }}
        role="row"
        aria-rowindex={idx + 1}
        onMouseDown={() => setSel(idx)}
        onDoubleClick={() => activate(v)}
      >
        {cols.map((c, ci) => {
          const w = widths[c.key] ?? 80;
          const f = fm[ci];
          if (c.key === 'label') {
            let spill = 0;
            for (let k = ci + 1; k < cols.length && fm[k].text === ''; k++) spill += widths[cols[k].key] ?? 80;
            spill = Math.max(0, spill - under);
            const lvl = r.level ?? 0;
            const room = Math.max(10, w + spill - lvl * INDENT - 6);
            return (
              <div key={c.key} className="rpt-c rpt-lbl" style={stickLabels ? { width: w, left: PAD_X } : { width: w }} role="cell">
                {v.collapsible && (
                  <button
                    type="button"
                    tabIndex={-1}
                    className="rpt-tog"
                    style={{ left: lvl * INDENT - 15 }}
                    aria-label={v.collapsed ? 'Expand' : 'Collapse'}
                    title={v.collapsed ? 'Expand' : 'Collapse'}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSel(idx);
                      onToggle(v.i);
                    }}
                  >
                    {v.collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                  </button>
                )}
                <span
                  className="rpt-lbl-in"
                  style={{ marginLeft: lvl * INDENT, maxWidth: room }}
                  title={f.text && (f.text.length > 30 || cellWidth(f.text, bold) > room) ? f.text : undefined}
                >
                  {f.text}
                </span>
              </div>
            );
          }
          const num = isNumericCol(c);
          const wraps = lines > 1 && !num && !!wrap?.[c.key] && !!f.text;
          const drill = num && f.text ? (r.txnId ? null : cellDrill(v.drillRow, c.key)) : null;
          const txnLink = num && f.text && r.txnId;
          const cls = 'rpt-c' + (num ? ' rpt-num' : '') + (num && f.text ? ' rpt-amt' : '') + (f.negative && d.red ? ' rpt-neg' : '') + (drill || txnLink ? ' rpt-drill' : '');
          return (
            <div
              key={c.key}
              className={cls}
              style={{ width: w }}
              role="cell"
              title={
                drill || txnLink
                  ? txnLink
                    ? 'Open the transaction'
                    : 'Drill down: show the transactions behind this amount'
                  : !num && f.text && (f.text.length > 12 || cellWidth(f.text, bold) > w - 12)
                    ? f.text
                    : undefined
              }
              onClick={
                drill
                  ? (e) => {
                      e.stopPropagation();
                      zoomReport(drill);
                    }
                  : txnLink
                    ? (e) => {
                        e.stopPropagation();
                        zoomTxn(r.txnId!);
                      }
                    : undefined
              }
            >
              {wraps ? (
                <span className="rpt-ct rpt-wrap" style={{ WebkitLineClamp: lines }}>
                  {withBreaks(f.text)}
                </span>
              ) : (
                <span className="rpt-ct">{f.text}</span>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  const visible: ReactNode[] = [];
  for (let idx = first; idx < last; idx++) visible.push(renderRow(rows[idx], idx));

  return (
    <div ref={scrollRef} className={'rpt-scroll' + (stickLabels ? ' rpt-stick' : '')} tabIndex={0} onScroll={onScroll} onKeyDown={onKeyDown} aria-label="Report" role="table">
      <div className="rpt-paper" style={{ width: paperW, paddingLeft: PAD_X, paddingRight: PAD_X }}>
        {showHeader && (
          <div className="rpt-head" style={stick}>
            <div className="rpt-head-left">
              {leftInfo.map((s, i) => (
                <div key={i}>{s}</div>
              ))}
            </div>
            <div className="rpt-head-center">
              {on(d, 'company') && <div className="rpt-co">{header.company}</div>}
              {on(d, 'title') && <div className="rpt-ti">{header.title}</div>}
              {on(d, 'subtitle') && header.subtitle && <div className="rpt-st">{header.subtitle}</div>}
            </div>
            <div className="rpt-head-right" />
          </div>
        )}
        <div className="rpt-colhead" style={{ width: innerW }} role="rowgroup">
          {groups && (
            <div className="rpt-hrow rpt-hgroups" role="row">
              {cols.map((c) => (c.key === 'label' ? <div key={c.key} className="rpt-h rpt-h-lbl" style={{ width: widths[c.key], left: stickLabels ? PAD_X : undefined }} /> : null))}
              {groups.groups.map((g, gi) => {
                const keys = g.keys.filter((k) => cols.some((c) => c.key === k));
                if (!keys.length) return null;
                const w = keys.reduce((s, k) => s + (widths[k] ?? 80), 0);
                return (
                  <div key={gi} className="rpt-h rpt-hgroup" style={{ width: w }}>
                    <span>{g.label}</span>
                  </div>
                );
              })}
            </div>
          )}
          <div className="rpt-hrow" role="row">
            {cols.map((c) => {
              const label = groups && c.key !== 'label' ? (groups.sub[c.key] ?? c.label) : c.label;
              const sorted = sortable && sortKey === c.key;
              return (
                <div
                  key={c.key}
                  className={'rpt-h' + (isNumericCol(c) ? ' rpt-num' : '') + (sortable ? ' rpt-sortable' : '') + (c.key === 'label' ? ' rpt-h-lbl' : '')}
                  style={c.key === 'label' && stickLabels ? { width: widths[c.key], left: PAD_X } : { width: widths[c.key] }}
                  role="columnheader"
                  aria-sort={sorted ? (sortDesc ? 'descending' : 'ascending') : undefined}
                  title={sortable ? `Sort by ${label || 'this column'}` : undefined}
                  onClick={() => clickHeader(c)}
                >
                  <span className="rpt-h-text">{label}</span>
                  {sorted && (sortDesc ? <ArrowDown size={11} className="rpt-sortic" /> : <ArrowUp size={11} className="rpt-sortic" />)}
                  <span className="rpt-resize" onMouseDown={(e) => startResize(e, c.key)} onClick={(e) => e.stopPropagation()} title="Drag to resize the column" />
                </div>
              );
            })}
          </div>
        </div>
        {placeholder ? (
          <div className="rpt-placeholder" style={stick}>
            {placeholder}
          </div>
        ) : (
          <div ref={bodyRef} className="rpt-body" style={{ height: bodyH, width: innerW }} role="rowgroup">
            {visible}
          </div>
        )}
        {!placeholder && d.footer.trim() && (
          <div className="rpt-footer" style={stick}>
            {d.footer.trim()}
          </div>
        )}
      </div>
    </div>
  );
}

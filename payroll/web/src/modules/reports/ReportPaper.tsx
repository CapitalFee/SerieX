// The report "paper" (ported from the SerieX Books report viewer): header block, sticky column
// header and the rows (virtual scrolling so 10,000+ rows stay fast). Single click on an amount =
// drill down; double click / Enter on a row opens its payroll record (row.target) or its drill
// report; ▸/▾ collapses sections; arrow keys move the selection.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight } from 'lucide-react';
import type { ReportColumn } from '@/api/types';
import type { ReportDrill, ReportTarget } from '@/api/types';
import { INDENT, cellDrill, formatCell, headerGroups, isNumericCol, openDrill, openTarget, targetTitle, type DisplayOptions, type HeaderText, type VisibleRow } from './reportFormat';

/** Height of one report row in px. */
export const ROW_H = 22;
const OVERSCAN = 12;
/** Horizontal padding of the paper (room for the ▸ toggles of level 0 sections). */
const PAD_X = 20;

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
}

const on = (d: DisplayOptions, p: string) => !d.hdrOff.includes(p as never);

/** One formatted cell. */
interface Fmt {
  text: string;
  negative: boolean;
}

export function ReportPaper(props: ReportPaperProps) {
  const { header, showHeader, cols, widths, onResize, rows, display: d, onToggle, sortable, onSort, placeholder, resultId, autoFocus } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 600, width: 1000, bodyTop: 0 });
  const [sel, setSel] = useState(-1);
  const frame = useRef(0);

  const groups = useMemo(() => headerGroups(cols), [cols]);
  const innerW = cols.reduce((s, c) => s + (widths[c.key] ?? 80), 0);
  const paperW = Math.max(innerW + PAD_X * 2, 620);
  // header, messages and footer stay centered in the visible part of a report wider than the window
  const visW = Math.max(360, Math.min(paperW, view.width) - PAD_X * 2 - 2);
  const stick = { width: visW, left: PAD_X } as const;

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
      v.top === sc.scrollTop && v.height === sc.clientHeight && v.width === sc.clientWidth && v.bodyTop === bodyTop
        ? v
        : { top: sc.scrollTop, height: sc.clientHeight, width: sc.clientWidth, bodyTop },
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

  const first = Math.max(0, Math.floor((view.top - view.bodyTop) / ROW_H) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((view.top - view.bodyTop + view.height) / ROW_H) + OVERSCAN);

  const ensureVisible = (idx: number) => {
    const sc = scrollRef.current;
    if (!sc || idx < 0) return;
    const y = view.bodyTop + idx * ROW_H;
    const headH = (sc.querySelector('.rpt-colhead') as HTMLElement | null)?.offsetHeight ?? 24;
    if (y - headH < sc.scrollTop) sc.scrollTop = y - headH;
    else if (y + ROW_H > sc.scrollTop + sc.clientHeight) sc.scrollTop = y + ROW_H - sc.clientHeight;
  };

  // the opened form or report takes the keyboard (its shortcuts must not land in this report)
  const release = () => scrollRef.current?.blur();
  const zoomTarget = (t: ReportTarget) => {
    release();
    openTarget(t);
  };
  const zoomReport = (drill: ReportDrill) => {
    release();
    openDrill(drill);
  };

  const activate = (v: VisibleRow) => {
    if (v.row.target) zoomTarget(v.row.target);
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
    const fm: Fmt[] = cols.map((c) => (c.key === 'label' ? { text: v.cells.label == null ? '' : String(v.cells.label), negative: false } : formatCell(v.cells[c.key], c, d)));
    return (
      <div
        key={v.i}
        className={`rpt-row k-${kind}` + (idx === sel ? ' rpt-sel' : '') + (r.target || v.drillRow.drill ? ' rpt-act' : '')}
        style={{ top: idx * ROW_H, height: ROW_H }}
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
            const lvl = r.level ?? 0;
            return (
              <div key={c.key} className="rpt-c rpt-lbl" style={{ width: w }} role="cell">
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
                  style={{ marginLeft: lvl * INDENT, maxWidth: Math.max(10, w + spill - lvl * INDENT - 6) }}
                  title={f.text.length > 30 ? f.text : undefined}
                >
                  {f.text}
                </span>
              </div>
            );
          }
          const num = isNumericCol(c);
          // an amount drills down to the report behind it (item totals → Payroll Item Detail);
          // amounts of a transaction row open the paycheck / tax payment / adjustment
          const drill = num && f.text ? cellDrill(v.drillRow) : undefined;
          const txnLink = num && f.text && !drill ? r.target : undefined;
          const cls = 'rpt-c' + (num ? ' rpt-num' : '') + (num && f.text ? ' rpt-amt' : '') + (f.negative && d.red ? ' rpt-neg' : '') + (drill || txnLink ? ' rpt-drill' : '');
          return (
            <div
              key={c.key}
              className={cls}
              style={{ width: w }}
              role="cell"
              title={
                drill || txnLink ? (txnLink ? targetTitle(txnLink) : 'Drill down: show the transactions behind this amount') : !num && f.text.length > 12 ? f.text : undefined
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
                        zoomTarget(txnLink);
                      }
                    : undefined
              }
            >
              <span className="rpt-ct">{f.text}</span>
            </div>
          );
        })}
      </div>
    );
  };

  const visible: ReactNode[] = [];
  for (let idx = first; idx < last; idx++) visible.push(renderRow(rows[idx], idx));

  return (
    <div ref={scrollRef} className="rpt-scroll" tabIndex={0} onScroll={onScroll} onKeyDown={onKeyDown} aria-label="Report" role="table">
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
              {cols.map((c) => (c.key === 'label' ? <div key={c.key} className="rpt-h" style={{ width: widths[c.key] }} /> : null))}
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
                  className={'rpt-h' + (isNumericCol(c) ? ' rpt-num' : '') + (sortable ? ' rpt-sortable' : '')}
                  style={{ width: widths[c.key] }}
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
          <div ref={bodyRef} className="rpt-body" style={{ height: rows.length * ROW_H, width: innerW }} role="rowgroup">
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

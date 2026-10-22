// Read-only list used by lists, centers and selection dialogs (Chart of Accounts, Item List,
// Customer Center...). Sortable and resizable columns, keyboard navigation with type-ahead,
// right-click menus, hierarchical indentation, gray italic inactive rows, and virtual scrolling
// (only the visible rows are rendered, so 5,000+ rows stay fast).
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { fmtDate, fmtMoney, fmtQty } from '@/util/format';
import { showContextMenu, type MenuItem } from './menu';
import { Spinner } from './layout';

/** Column definition of {@link ListView}. */
export interface ListColumn<T> {
  key: string;
  /** Header text (shown uppercase). */
  label: ReactNode;
  /** Width in px (default 120). */
  width?: number;
  /** Takes the remaining width (at least `width`). */
  grow?: boolean;
  align?: 'left' | 'right' | 'center';
  /** Formats the value: money (1,234.56, right), number, date (MM/DD/YYYY) or text. */
  type?: 'text' | 'money' | 'number' | 'date';
  /** Custom cell content. */
  render?: (row: T) => ReactNode;
  /** Value used for sorting and type-ahead (default row[key]). */
  sortValue?: (row: T) => string | number | null | undefined;
  /** Allow sorting by clicking the header (default true). */
  sortable?: boolean;
  title?: string;
}

/** Sort state of {@link ListView}. */
export interface ListSort {
  key: string;
  dir: 1 | -1;
}

/** Props of {@link ListView}. */
export interface ListViewProps<T> {
  columns: ListColumn<T>[];
  rows: readonly T[];
  /** Row key (default `row.id`). */
  getKey?: (row: T) => string | number;
  selectedKey?: string | number | null;
  onSelect?: (key: string | number, row: T) => void;
  /** Double click or Enter. */
  onActivate?: (row: T) => void;
  /** Right-click menu (row is null when clicking the empty area). */
  contextMenu?: (row: T | null) => MenuItem[];
  /** Indentation level (subaccounts, jobs); ignored while sorted by a column. */
  getLevel?: (row: T) => number;
  /** Column that gets the indentation (default the first one). */
  indentKey?: string;
  /** Inactive rows are drawn gray italic. */
  isInactive?: (row: T) => boolean;
  /** Adds the leading "X" column marking inactive rows (when the list includes inactive ones). */
  showInactiveColumn?: boolean;
  rowClassName?: (row: T) => string | undefined;
  /** Row height in px (default 26). */
  rowHeight?: number;
  /** Initial sort (default none = given order / hierarchy). */
  defaultSort?: ListSort | null;
  /** Controlled sort. */
  sort?: ListSort | null;
  onSortChange?: (s: ListSort | null) => void;
  /** Remember column widths under this key. */
  persistKey?: string;
  emptyText?: ReactNode;
  loading?: boolean;
  autoFocus?: boolean;
  className?: string;
  style?: CSSProperties;
  'aria-label'?: string;
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
}

function loadWidths(key?: string): Record<string, number> {
  if (!key) return {};
  try {
    return JSON.parse(localStorage.getItem('sx.lv.' + key) ?? '{}') ?? {};
  } catch {
    return {};
  }
}

const defaultKey = (r: unknown) => (r as { id: string | number }).id;

function cellValue<T>(row: T, c: ListColumn<T>): unknown {
  return c.sortValue ? c.sortValue(row) : (row as Record<string, unknown>)[c.key];
}

/**
 * Hover on a cell whose text is cut with an ellipsis: the whole text becomes its tooltip (set
 * when it is cut, removed when it fits again). A title the cell content sets itself is kept.
 */
function showCutText(e: React.MouseEvent<HTMLDivElement>) {
  const t = e.target as HTMLElement;
  const cell = t.closest<HTMLElement>('.sx-lv-cell');
  if (!cell || !e.currentTarget.contains(cell)) return;
  for (let el: HTMLElement | null = t; el && el !== cell; el = el.parentElement) if (el.title && !el.dataset.sxTip) return;
  const cut = (el: HTMLElement) => el.scrollWidth > el.clientWidth + 1;
  const isCut = cut(cell) || Array.from(cell.querySelectorAll<HTMLElement>('*')).slice(0, 30).some(cut);
  const text = (cell.innerText || '').replace(/\s+/g, ' ').trim();
  if (isCut && text) {
    if (cell.title !== text) {
      cell.title = text;
      cell.dataset.sxTip = '1';
    }
  } else if (cell.dataset.sxTip) {
    cell.removeAttribute('title');
    delete cell.dataset.sxTip;
  }
}

function formatCell<T>(row: T, c: ListColumn<T>): ReactNode {
  if (c.render) return c.render(row);
  const v = (row as Record<string, unknown>)[c.key];
  if (v === null || v === undefined) return '';
  switch (c.type) {
    case 'money':
      return fmtMoney(v as number);
    case 'number':
      return fmtQty(v as number);
    case 'date':
      return fmtDate(v as string);
    default:
      return String(v);
  }
}

/** Virtualized, sortable, keyboard-friendly read-only list. */
export function ListView<T>(props: ListViewProps<T>) {
  const {
    columns,
    rows,
    getKey = defaultKey as (r: T) => string | number,
    selectedKey,
    onSelect,
    onActivate,
    contextMenu,
    getLevel,
    indentKey,
    isInactive,
    showInactiveColumn,
    rowClassName,
    rowHeight = 26,
    defaultSort = null,
    persistKey,
    emptyText,
    loading,
    autoFocus,
    className,
    style,
    onKeyDown,
  } = props;
  const [sortState, setSortState] = useState<ListSort | null>(defaultSort);
  const sort = props.sort !== undefined ? props.sort : sortState;
  const setSort = (s: ListSort | null) => {
    if (props.sort === undefined) setSortState(s);
    props.onSortChange?.(s);
  };
  const [widths, setWidths] = useState<Record<string, number>>(() => loadWidths(persistKey));
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(400);
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const typeBuf = useRef({ text: '', at: 0 });

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return rows;
    const arr = rows.slice();
    arr.sort((a, b) => {
      const va = cellValue(a, col);
      const vb = cellValue(b, col);
      if (va === vb) return 0;
      if (va === null || va === undefined || va === '') return 1;
      if (vb === null || vb === undefined || vb === '') return -1;
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * sort.dir;
      return String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: 'base' }) * sort.dir;
    });
    return arr;
  }, [rows, sort, columns]);

  const selIndex = useMemo(() => (selectedKey === null || selectedKey === undefined ? -1 : sorted.findIndex((r) => getKey(r) === selectedKey)), [sorted, selectedKey, getKey]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    setViewH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (autoFocus) rootRef.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  const headH = Math.max(rowHeight, 30);
  const ensureVisible = (i: number) => {
    const el = scrollRef.current;
    if (!el || i < 0) return;
    const top = i * rowHeight;
    const bodyH = el.clientHeight - headH;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + rowHeight > el.scrollTop + bodyH) el.scrollTop = top + rowHeight - bodyH;
  };
  const pendingScroll = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (pendingScroll.current !== null) {
      ensureVisible(pendingScroll.current);
      pendingScroll.current = null;
    }
  });

  const select = (i: number, scroll = true) => {
    if (i < 0 || i >= sorted.length) return;
    const r = sorted[i];
    onSelect?.(getKey(r), r);
    if (scroll) pendingScroll.current = i;
  };

  const pageRows = Math.max(1, Math.floor((viewH - headH) / rowHeight) - 1);

  const handleKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    const k = e.key;
    const cur = selIndex;
    let target: number | null = null;
    if (k === 'ArrowDown') target = cur < 0 ? 0 : Math.min(sorted.length - 1, cur + 1);
    else if (k === 'ArrowUp') target = cur < 0 ? 0 : Math.max(0, cur - 1);
    else if (k === 'PageDown') target = Math.min(sorted.length - 1, Math.max(0, cur) + pageRows);
    else if (k === 'PageUp') target = Math.max(0, cur - pageRows);
    else if (k === 'Home') target = 0;
    else if (k === 'End') target = sorted.length - 1;
    else if (k === 'Enter') {
      if (cur >= 0 && onActivate) {
        e.preventDefault();
        onActivate(sorted[cur]);
      }
      return;
    } else if ((k === 'F10' && e.shiftKey) || k === 'ContextMenu') {
      if (contextMenu) {
        const items = contextMenu(cur >= 0 ? sorted[cur] : null);
        const el = scrollRef.current?.querySelector(`[data-row="${cur}"]`) ?? rootRef.current;
        const r = el!.getBoundingClientRect();
        if (items.length) showContextMenu({ x: r.left + 20, y: r.top + rowHeight }, items);
        e.preventDefault();
      }
      return;
    } else if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && k !== ' ') {
      // type-ahead on the first (or indent) column
      const now = Date.now();
      const buf = now - typeBuf.current.at > 900 ? k.toLowerCase() : typeBuf.current.text + k.toLowerCase();
      typeBuf.current = { text: buf, at: now };
      const col = columns.find((c) => c.key === (sort?.key ?? indentKey)) ?? columns[0];
      const text = (r: T) => String(cellValue(r, col) ?? '').toLowerCase();
      const start = buf.length === 1 ? cur + 1 : Math.max(0, cur);
      for (let n = 0; n < sorted.length; n++) {
        const i = (start + n) % sorted.length;
        if (text(sorted[i]).startsWith(buf)) {
          target = i;
          break;
        }
      }
      if (target === null) return;
    } else return;
    e.preventDefault();
    if (target !== null && target >= 0) select(target);
  };

  const startResize = (e: React.MouseEvent, key: string, startW: number) => {
    e.preventDefault();
    e.stopPropagation();
    const sx = e.clientX;
    let latest = startW;
    const move = (ev: MouseEvent) => {
      latest = Math.max(24, startW + ev.clientX - sx);
      setWidths((w) => ({ ...w, [key]: latest }));
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.style.cursor = '';
      if (persistKey) {
        try {
          localStorage.setItem('sx.lv.' + persistKey, JSON.stringify({ ...loadWidths(persistKey), [key]: latest }));
        } catch {
          /* ignore */
        }
      }
    };
    document.body.style.cursor = 'col-resize';
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const w = (c: ListColumn<T>) => widths[c.key] ?? c.width ?? 120;
  const xW = showInactiveColumn ? 20 : 0;
  const totalW = columns.reduce((s, c) => s + w(c), 0) + xW;
  const indentCol = indentKey ?? columns[0]?.key;
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - 5);
  const last = Math.min(sorted.length, first + Math.ceil(viewH / rowHeight) + 10);

  const cellStyle = (c: ListColumn<T>): CSSProperties => ({
    flex: c.grow ? `1 0 ${w(c)}px` : `0 0 ${w(c)}px`,
    width: w(c),
    textAlign: c.align ?? (c.type === 'money' || c.type === 'number' ? 'right' : 'left'),
  });

  return (
    <div
      ref={rootRef}
      className={'sx-lv' + (className ? ' ' + className : '')}
      style={style}
      role="grid"
      aria-label={props['aria-label']}
      aria-rowcount={sorted.length + 1}
      aria-activedescendant={selIndex >= 0 ? `sx-lv-r${selIndex}` : undefined}
      tabIndex={0}
      onKeyDown={handleKey}
      onContextMenu={(e) => {
        if (!contextMenu) return;
        if ((e.target as HTMLElement).closest('[data-row]')) return;
        const items = contextMenu(null);
        if (items.length) showContextMenu(e, items);
        else e.preventDefault();
      }}
    >
      <div ref={scrollRef} className="sx-lv-scroll" onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
        <div className="sx-lv-inner" style={{ width: totalW, minWidth: "100%" }}>
          <div className="sx-lv-head" role="row" style={{ height: headH }}>
            {showInactiveColumn && (
              <div className="sx-lv-hcell sx-lv-x" style={{ flex: `0 0 ${xW}px` }} role="columnheader" title="Inactive">
                <span className="sx-lv-xmark">✕</span>
              </div>
            )}
            {columns.map((c) => {
              const sortable = c.sortable !== false;
              const isSorted = sort?.key === c.key;
              return (
                <div
                  key={c.key}
                  role="columnheader"
                  aria-sort={isSorted ? (sort!.dir === 1 ? 'ascending' : 'descending') : undefined}
                  title={c.title}
                  className={'sx-lv-hcell' + (sortable ? ' sx-sortable' : '') + (isSorted ? ' sx-sorted' : '')}
                  style={cellStyle(c)}
                  onClick={() => {
                    if (!sortable) return;
                    if (!isSorted) setSort({ key: c.key, dir: 1 });
                    else if (sort!.dir === 1) setSort({ key: c.key, dir: -1 });
                    else setSort(null);
                  }}
                >
                  <span className="sx-lv-hlabel">{c.label}</span>
                  {isSorted && <span className="sx-lv-sort">{sort!.dir === 1 ? '▲' : '▼'}</span>}
                  <span className="sx-col-resize" onMouseDown={(e) => startResize(e, c.key, w(c))} onClick={(e) => e.stopPropagation()} aria-hidden="true" />
                </div>
              );
            })}
          </div>
          <div className="sx-lv-body" style={{ height: sorted.length * rowHeight }} onMouseOver={showCutText}>
            {sorted.slice(first, last).map((r, n) => {
              const i = first + n;
              const inactive = isInactive?.(r);
              const level = !sort && getLevel ? getLevel(r) : 0;
              return (
                <div
                  key={String(getKey(r))}
                  id={`sx-lv-r${i}`}
                  data-row={i}
                  role="row"
                  aria-selected={i === selIndex}
                  className={'sx-lv-row' + (i === selIndex ? ' sx-sel' : '') + (i % 2 ? ' sx-odd' : '') + (inactive ? ' sx-inactive' : '') + (rowClassName ? ' ' + (rowClassName(r) ?? '') : '')}
                  style={{ top: i * rowHeight, height: rowHeight }}
                  onMouseDown={(e) => {
                    if (e.button === 0 || e.button === 2) select(i, false);
                  }}
                  onDoubleClick={() => onActivate?.(r)}
                  onContextMenu={(e) => {
                    if (!contextMenu) return;
                    const items = contextMenu(r);
                    if (items.length) showContextMenu(e, items);
                    else e.preventDefault();
                  }}
                >
                  {showInactiveColumn && (
                    <div className="sx-lv-cell sx-lv-x" style={{ flex: `0 0 ${xW}px` }}>
                      {inactive ? <span className="sx-lv-xmark">✕</span> : null}
                    </div>
                  )}
                  {columns.map((c) => (
                    <div key={c.key} role="gridcell" className="sx-lv-cell" style={{ ...cellStyle(c), paddingLeft: c.key === indentCol && level ? 4 + level * 16 : undefined }}>
                      {formatCell(r, c)}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
          {!loading && sorted.length === 0 && emptyText ? <div className="sx-lv-empty">{emptyText}</div> : null}
        </div>
      </div>
      {loading && <Spinner center />}
    </div>
  );
}

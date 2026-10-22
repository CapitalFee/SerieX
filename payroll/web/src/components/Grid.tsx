// Editable spreadsheet grid used by every record form (paycheck lines, liability lines, adjustments...).
//
// - One cell at a time shows its editor (built-in 'text' | 'money' | 'qty' | 'date' | 'checkbox',
//   or a custom editor such as <AccountPicker inGrid .../>). Editors commit on blur.
// - Keys: Tab / Shift+Tab next/previous editable cell (leaving the grid after the last one),
//   Enter next cell (or the cell below with enterMoves="down"), Up/Down previous/next line,
//   Ctrl+Insert insert a line above, Ctrl+Delete delete the line. Right click: Insert/Delete Line.
// - There is always one empty line at the end (`newRow()`); typing in it appends a real row.
// - Columns can be resized by dragging the header edge (remembered with `persistKey`).
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MutableRefObject,
  type ReactNode,
} from 'react';
import { fmtDate, fmtMoney, fmtQty } from '@/util/format';
import { DateField } from './DateField';
import { focusOutside } from './focus';
import { MoneyField, NumberField, TextField } from './inputs';
import { showContextMenu, type MenuItem } from './menu';

/** The grid cell an editor is rendered in (see {@link useGridCell}). */
export interface GridCellInfo {
  rowIndex: number;
  columnKey: string;
  /**
   * Starts editing this cell again (focuses its editor). Used e.g. by pickers after "Add with
   * details…": the dialog takes the focus away (the editor closes), and when the new record is
   * created it is put in the cell and the cell becomes active again.
   */
  activate(): void;
}

/** Provided by Grid around every cell editor. */
export const GridCellContext = createContext<GridCellInfo | null>(null);

/** The grid cell the calling component is the editor of, or null outside a Grid editor. */
export function useGridCell(): GridCellInfo | null {
  return useContext(GridCellContext);
}

/** Built-in cell editors. */
export type GridEditorKind = 'text' | 'money' | 'qty' | 'date' | 'checkbox';

/** Props given to a custom cell editor. Render a control with `autoFocus` and `inGrid`. */
export interface GridEditorProps<R> {
  row: R;
  rowIndex: number;
  /** Current cell value (column.get(row) or row[key]). */
  value: any;
  column: GridColumn<R>;
  /** True on the trailing empty line. */
  isNew: boolean;
  /** Sets this cell's value (applies column.set and the grid's onRowChange). */
  onChange(value: any): void;
  /** Changes several fields of the row at once (e.g. item → description, rate, amount). */
  onRowChange(patch: Partial<R>): void;
  /** Moves to the next editable cell (like Tab). */
  moveNext(): void;
}

/** Column definition of {@link Grid}. */
export interface GridColumn<R> {
  /** Field name in the row (also the default getter/setter). */
  key: string;
  /** Header text (shown uppercase). */
  label: ReactNode;
  /** Width in px (default 100). */
  width?: number;
  /** This column takes the remaining width (default: the last column). */
  grow?: boolean;
  align?: 'left' | 'right' | 'center';
  /** Cell editor; omit for a read-only column. */
  editor?: GridEditorKind | ((p: GridEditorProps<R>) => ReactNode);
  /** Display of an inactive cell (default: formatted value by editor kind). */
  render?: (row: R, rowIndex: number) => ReactNode;
  /** Value getter (default row[key]). */
  get?: (row: R) => any;
  /** Value setter (default {...row, [key]: value}). */
  set?: (row: R, value: any) => R;
  /** Read-only column, or read-only for some rows. */
  readOnly?: boolean | ((row: R, rowIndex: number) => boolean);
  /** Money/qty: show blank for 0. */
  blankZero?: boolean;
  /** Money/qty: an empty cell means null (default: money 0, qty null). */
  nullable?: boolean;
  /** Not shown (e.g. CLASS without class tracking). */
  hidden?: boolean;
  /** Tooltip of the header. */
  title?: string;
}

/** Imperative handle of a Grid (pass `apiRef`). */
export interface GridApi {
  /** Starts editing a cell (column key). */
  activate(rowIndex: number, key?: string): void;
  insertLine(rowIndex: number): void;
  deleteLine(rowIndex: number): void;
  /** Index of the current line (the highlighted one) or null. */
  currentRow(): number | null;
}

/** Props of {@link Grid}. */
export interface GridProps<R> {
  columns: GridColumn<R>[];
  rows: R[];
  /** Called with the new rows after every edit, insert or delete. */
  onChange(rows: R[]): void;
  /** Creates an empty row (the trailing new line and inserted lines). */
  newRow(): R;
  /**
   * Derives fields after a cell edit (e.g. qty or rate → amount). Receives the row with the new
   * value, the row before, the edited column key ('*' for multi-field patches) and the index.
   */
  onRowChange?(next: R, prev: R, key: string, index: number): R;
  /** Keep a trailing empty line for adding rows (default true). */
  allowAdd?: boolean;
  /** Allow Insert Line / Delete Line (default true). */
  allowInsertDelete?: boolean;
  readOnly?: boolean;
  /** Minimum number of visible lines (empty lines are drawn to fill; default 8). */
  minRows?: number;
  /** Content below the grid (totals...). */
  footer?: ReactNode;
  /** Extra context menu entries for a row (Insert/Delete Line are added automatically). */
  contextMenu?(row: R | null, index: number): MenuItem[];
  rowClassName?(row: R, index: number): string | undefined;
  /** Remember column widths in localStorage under this key. */
  persistKey?: string;
  /** Enter moves to the next cell ("next", default, like Tab) or to the cell below ("down"). */
  enterMoves?: 'next' | 'down';
  onActiveRowChange?(index: number | null): void;
  apiRef?: MutableRefObject<GridApi | null>;
  className?: string;
  style?: CSSProperties;
  'aria-label'?: string;
}

const ROW_H = 26;

function loadWidths(key?: string): Record<string, number> {
  if (!key) return {};
  try {
    return JSON.parse(localStorage.getItem('sxp.grid.' + key) ?? '{}') ?? {};
  } catch {
    return {};
  }
}

/** Editable desktop-style lines grid. */
export function Grid<R>(props: GridProps<R>) {
  const {
    rows,
    onChange,
    newRow,
    onRowChange,
    readOnly,
    minRows = 8,
    footer,
    contextMenu,
    rowClassName,
    persistKey,
    enterMoves = 'next',
    onActiveRowChange,
    apiRef,
    className,
    style,
  } = props;
  const cols = useMemo(() => props.columns.filter((c) => !c.hidden), [props.columns]);
  const colsRef = useRef(cols);
  colsRef.current = cols;
  const allowAdd = props.allowAdd !== false && !readOnly;
  const allowInsDel = props.allowInsertDelete !== false && !readOnly;
  const [widths, setWidths] = useState<Record<string, number>>(() => loadWidths(persistKey));
  const [active, setActiveState] = useState<{ r: number; c: number } | null>(null);
  const [curRow, setCurRow] = useState<number | null>(null);
  const [fit, setFit] = useState(minRows);
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const phantomRef = useRef<R | null>(null);
  if (phantomRef.current === null) phantomRef.current = newRow();
  const activeRef = useRef(active);
  activeRef.current = active;
  const skipRootActivate = useRef(false);

  const total = () => rowsRef.current.length + (allowAdd ? 1 : 0);
  const rowAt = (i: number): R => (i < rowsRef.current.length ? rowsRef.current[i] : phantomRef.current!);
  const growKey = cols.find((c) => c.grow)?.key ?? cols[cols.length - 1]?.key;

  const editable = (ci: number, ri: number): boolean => {
    const c = cols[ci];
    if (!c || readOnly || !c.editor) return false;
    if (ri >= total()) return false;
    const ro = typeof c.readOnly === 'function' ? c.readOnly(rowAt(ri), ri) : c.readOnly;
    return !ro;
  };
  const firstEditable = (ri: number): number => {
    for (let i = 0; i < cols.length; i++) if (editable(i, ri)) return i;
    return -1;
  };

  const setActive = (a: { r: number; c: number } | null) => {
    activeRef.current = a;
    setActiveState(a);
    if (a) {
      setCurRow(a.r);
      onActiveRowChange?.(a.r);
    }
  };

  // ---- data updates (compose through rowsRef so several updates in one event add up)
  const commitRows = (next: R[]) => {
    rowsRef.current = next;
    onChange(next);
  };
  const applyRow = (ri: number, make: (prev: R) => R, key: string) => {
    const cur = rowsRef.current;
    const isNew = ri >= cur.length;
    if (isNew && !allowAdd) return;
    const prev = isNew ? phantomRef.current! : cur[ri];
    let next = make(prev);
    if (onRowChange) next = onRowChange(next, prev, key, ri);
    const arr = cur.slice();
    if (isNew) {
      arr.push(next);
      phantomRef.current = newRow();
    } else arr[ri] = next;
    commitRows(arr);
  };
  const setCell = (ri: number, col: GridColumn<R>, value: unknown) =>
    applyRow(ri, (prev) => (col.set ? col.set(prev, value) : ({ ...prev, [col.key]: value } as R)), col.key);
  const patchRow = (ri: number, patch: Partial<R>) => applyRow(ri, (prev) => ({ ...prev, ...patch }), '*');

  // ---- focus / activation
  const blurEditor = () => {
    const ae = document.activeElement as HTMLElement | null;
    if (ae && ae !== rootRef.current && rootRef.current?.contains(ae)) ae.blur();
  };
  const activate = (r: number, c: number) => {
    blurEditor();
    setActive({ r, c });
  };
  const exit = (backward: boolean) => {
    blurEditor();
    setActive(null);
    if (!focusOutside(rootRef.current!, backward)) rootRef.current?.focus();
  };
  const next = (r: number, c: number, dir: 1 | -1): { r: number; c: number } | null => {
    let ri = r;
    let ci = c;
    const max = total() * Math.max(cols.length, 1) + 2;
    for (let g = 0; g < max; g++) {
      ci += dir;
      if (ci >= cols.length) {
        ci = 0;
        ri++;
      } else if (ci < 0) {
        ci = cols.length - 1;
        ri--;
      }
      if (ri < 0 || ri >= total()) return null;
      if (editable(ci, ri)) return { r: ri, c: ci };
    }
    return null;
  };
  const vertical = (r: number, c: number, dir: 1 | -1) => {
    const ri = r + dir;
    if (ri < 0 || ri >= total()) return;
    if (editable(c, ri)) activate(ri, c);
    else {
      const f = firstEditable(ri);
      if (f >= 0) activate(ri, f);
    }
  };
  const moveNext = () => {
    const a = activeRef.current;
    if (!a) return;
    const n = next(a.r, a.c, 1);
    if (n) activate(n.r, n.c);
    else exit(false);
  };

  const insertLine = (ri: number) => {
    if (!allowInsDel || ri >= rowsRef.current.length) return;
    blurEditor();
    const arr = rowsRef.current.slice();
    arr.splice(ri, 0, newRow());
    commitRows(arr);
    const f = firstEditable(ri);
    setActive(f >= 0 ? { r: ri, c: f } : null);
  };
  const deleteLine = (ri: number) => {
    if (!allowInsDel) return;
    blurEditor();
    if (ri >= rowsRef.current.length) {
      phantomRef.current = newRow();
      setActive(activeRef.current ? { ...activeRef.current } : null);
      return;
    }
    const arr = rowsRef.current.slice();
    arr.splice(ri, 1);
    commitRows(arr);
    const a = activeRef.current;
    if (a) {
      const r = Math.min(ri, arr.length + (allowAdd ? 0 : -1));
      setActive(r >= 0 ? { r, c: a.c } : null);
    } else setCurRow(Math.min(ri, Math.max(0, arr.length - 1)));
  };

  if (apiRef) {
    apiRef.current = {
      activate: (r, key) => {
        const c = key ? cols.findIndex((x) => x.key === key) : firstEditable(r);
        if (c >= 0) activate(r, c);
      },
      insertLine,
      deleteLine,
      currentRow: () => activeRef.current?.r ?? curRow,
    };
  }

  // focus the editor of the active cell when it did not focus itself
  useLayoutEffect(() => {
    if (!active) return;
    const td = rootRef.current?.querySelector<HTMLElement>(`[data-cell="${active.r}:${active.c}"]`);
    if (!td) return;
    if (!td.contains(document.activeElement)) {
      const f = td.querySelector<HTMLElement>('input:not([type=hidden]), select, textarea, button:not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])');
      f?.focus({ preventScroll: true });
    }
    td.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active]);

  // visible rows that fit in the scroll area (to draw grid lines down to the bottom)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const head = el.querySelector('thead')?.getBoundingClientRect().height ?? ROW_H;
      const rh = el.querySelector('tbody tr')?.getBoundingClientRect().height || ROW_H;
      setFit(Math.max(minRows, Math.floor((el.clientHeight - head) / rh + 0.01)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [minRows]);

  // clamp the active cell when rows disappear (e.g. parent cleared the lines)
  useEffect(() => {
    if (active && active.r >= total()) setActive(null);
    if (curRow !== null && curRow >= total()) setCurRow(null);
  });

  // ---- column resize
  const widthOf = (c: GridColumn<R>) => widths[c.key] ?? c.width ?? 100;
  const startResize = (e: React.MouseEvent, key: string, startW: number) => {
    e.preventDefault();
    e.stopPropagation();
    const sx = e.clientX;
    let latest = startW;
    const move = (ev: MouseEvent) => {
      latest = Math.max(30, startW + ev.clientX - sx);
      setWidths((w) => ({ ...w, [key]: latest }));
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.style.cursor = '';
      if (persistKey) {
        try {
          const saved = loadWidths(persistKey);
          localStorage.setItem('sxp.grid.' + persistKey, JSON.stringify({ ...saved, [key]: latest }));
        } catch {
          /* ignore */
        }
      }
    };
    document.body.style.cursor = 'col-resize';
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  // ---- keyboard (events bubble from the editors)
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing) return;
    const a = activeRef.current;
    const k = e.key;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && (k === 'Insert' || k === 'Delete')) {
      const r = a?.r ?? curRow;
      if (r === null || r === undefined) return;
      e.preventDefault();
      e.stopPropagation();
      if (k === 'Insert') insertLine(r);
      else deleteLine(r);
      return;
    }
    if (e.altKey || ctrl) return;
    if (!a) {
      if (e.target !== rootRef.current || readOnly) return;
      const r = curRow ?? 0;
      if (k === 'ArrowDown' || k === 'ArrowUp') {
        const n = Math.max(0, Math.min(total() - 1, r + (k === 'ArrowDown' ? 1 : -1)));
        setCurRow(n);
        e.preventDefault();
      } else if (k === 'Enter' || k === 'F2') {
        const f = firstEditable(r);
        if (f >= 0) activate(r, f);
        e.preventDefault();
      }
      return;
    }
    if (k === 'Tab') {
      e.preventDefault();
      const n = next(a.r, a.c, e.shiftKey ? -1 : 1);
      if (n) activate(n.r, n.c);
      else exit(e.shiftKey);
    } else if (k === 'Enter') {
      e.preventDefault();
      if (enterMoves === 'down') vertical(a.r, a.c, 1);
      else {
        const n = next(a.r, a.c, 1);
        if (n) activate(n.r, n.c);
      }
    } else if (k === 'ArrowDown' || k === 'ArrowUp') {
      if ((e.target as HTMLElement).tagName === 'SELECT' || (e.target as HTMLElement).tagName === 'TEXTAREA') return;
      e.preventDefault();
      vertical(a.r, a.c, k === 'ArrowDown' ? 1 : -1);
    }
  };

  const menuFor = (ri: number): MenuItem[] => {
    const isReal = ri < rowsRef.current.length;
    const extra = contextMenu?.(isReal ? rowsRef.current[ri] : null, ri) ?? [];
    const base: MenuItem[] = allowInsDel
      ? [
          { label: 'Insert Line', shortcut: 'Ctrl+Ins', disabled: !isReal, onClick: () => insertLine(ri) },
          { label: 'Delete Line', shortcut: 'Ctrl+Del', disabled: !isReal, onClick: () => deleteLine(ri) },
        ]
      : [];
    return extra.length && base.length ? [...base, { separator: true }, ...extra] : [...base, ...extra];
  };

  // ---- cell rendering
  const display = (row: R, ri: number, col: GridColumn<R>): ReactNode => {
    if (col.render) return col.render(row, ri);
    const v = col.get ? col.get(row) : (row as Record<string, unknown>)[col.key];
    switch (col.editor) {
      case 'money':
        return v === null || v === undefined ? '' : fmtMoney(v as number, { blankZero: col.blankZero });
      case 'qty':
        return v === null || v === undefined ? '' : fmtQty(v as number, { blankZero: col.blankZero });
      case 'date':
        return fmtDate(v as string);
      default:
        return v === null || v === undefined ? '' : String(v);
    }
  };

  // re-activates a cell by column key later (the column index may change meanwhile)
  const activateLater = (ri: number, key: string) => {
    if (!rootRef.current || !rootRef.current.isConnected) return;
    const c = colsRef.current.findIndex((x) => x.key === key);
    if (c >= 0 && ri < total() && editable(c, ri)) activate(ri, c);
  };

  const editorFor = (row: R, ri: number, col: GridColumn<R>, isNew: boolean): ReactNode => (
    <GridCellContext.Provider value={{ rowIndex: ri, columnKey: col.key, activate: () => activateLater(ri, col.key) }}>{editorNode(row, ri, col, isNew)}</GridCellContext.Provider>
  );

  const editorNode = (row: R, ri: number, col: GridColumn<R>, isNew: boolean): ReactNode => {
    const value = col.get ? col.get(row) : (row as Record<string, unknown>)[col.key];
    const onCellChange = (v: unknown) => setCell(ri, col, v);
    const ed = col.editor!;
    const label = typeof col.label === 'string' ? col.label : col.key;
    if (typeof ed === 'function') {
      return ed({ row, rowIndex: ri, value, column: col, isNew, onChange: onCellChange, onRowChange: (p) => patchRow(ri, p), moveNext });
    }
    switch (ed) {
      case 'money':
        return (
          <MoneyField inGrid autoFocus aria-label={label} value={value as number | null} nullable={col.nullable} blankZero={col.blankZero} onChange={onCellChange} />
        );
      case 'qty':
        return <NumberField inGrid autoFocus aria-label={label} value={value as number | null} nullable={col.nullable ?? true} blankZero={col.blankZero} onChange={onCellChange} />;
      case 'date':
        return <DateField inGrid autoFocus aria-label={label} value={value as string} onChange={onCellChange} />;
      case 'checkbox':
        return (
          <input
            type="checkbox"
            className="sx-grid-check"
            autoFocus
            aria-label={label}
            checked={!!value}
            onChange={(e) => onCellChange(e.target.checked)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
          />
        );
      default:
        return <TextField inGrid autoFocus aria-label={label} value={(value as string) ?? ''} onChange={(t) => onCellChange(t)} />;
    }
  };

  const onCellMouseDown = (e: React.MouseEvent<HTMLTableCellElement>, ri: number, ci: number) => {
    if (!e.currentTarget.contains(e.target as Node)) return; // events from portals (drop-down lists)
    if (e.button !== 0) return;
    const a = activeRef.current;
    if (a && a.r === ri && a.c === ci) return; // already editing: let the control handle the click
    const col = cols[ci];
    if (editable(ci, ri)) {
      e.preventDefault();
      activate(ri, ci);
      if (col.editor === 'checkbox') {
        const v = col.get ? col.get(rowAt(ri)) : (rowAt(ri) as Record<string, unknown>)[col.key];
        setCell(ri, col, !v);
      }
    } else {
      e.preventDefault();
      blurEditor();
      setActive(null);
      setCurRow(ri);
      onActiveRowChange?.(ri);
      skipRootActivate.current = true;
      rootRef.current?.focus({ preventScroll: true });
      skipRootActivate.current = false;
    }
  };

  const onRowContext = (e: React.MouseEvent, ri: number) => {
    if (!(e.currentTarget as HTMLElement).contains(e.target as Node)) return;
    e.preventDefault();
    const items = menuFor(ri);
    if (!items.length) return;
    const a = activeRef.current;
    if (!a || a.r !== ri) {
      blurEditor();
      setActive(null);
      setCurRow(ri);
      onActiveRowChange?.(ri);
    }
    showContextMenu(e, items);
  };

  const totalRows = rows.length + (allowAdd ? 1 : 0);
  const fillers = Math.max(0, Math.max(minRows, fit) - totalRows);
  const fixedWidth = cols.reduce((s, c) => s + (c.key === growKey ? 80 : widthOf(c)), 0);

  const renderRow = (row: R, ri: number, isNew: boolean) => (
    <tr
      key={ri /* the trailing new line keeps its key when it becomes a real row, so its editor stays mounted */}
      aria-rowindex={ri + 2}
      className={'sx-grid-row' + (curRow === ri ? ' sx-cur' : '') + (isNew ? ' sx-new' : '') + (!isNew && rowClassName ? ' ' + (rowClassName(row, ri) ?? '') : '')}
      onContextMenu={(e) => onRowContext(e, ri)}
    >
      {cols.map((col, ci) => {
        const isAct = !!active && active.r === ri && active.c === ci && editable(ci, ri);
        const isCheck = col.editor === 'checkbox';
        return (
          <td
            key={col.key}
            data-cell={`${ri}:${ci}`}
            role="gridcell"
            className={
              'sx-grid-cell' +
              (isAct ? ' sx-active' : '') +
              (col.align ? ` sx-align-${col.align}` : isCheck ? ' sx-align-center' : '') +
              (!editable(ci, ri) ? ' sx-ro' : '')
            }
            onMouseDown={(e) => onCellMouseDown(e, ri, ci)}
          >
            {isAct ? (
              editorFor(row, ri, col, isNew)
            ) : isCheck && !isNew ? (
              <input type="checkbox" className="sx-grid-check sx-static" tabIndex={-1} readOnly checked={!!(col.get ? col.get(row) : (row as Record<string, unknown>)[col.key])} aria-label={String(col.label)} />
            ) : isNew ? null : (
              <div className="sx-grid-text">{display(row, ri, col)}</div>
            )}
          </td>
        );
      })}
    </tr>
  );

  return (
    <div
      ref={rootRef}
      className={'sx-grid' + (readOnly ? ' sx-readonly' : '') + (className ? ' ' + className : '')}
      style={style}
      role="grid"
      aria-label={props['aria-label']}
      aria-rowcount={totalRows + 1}
      tabIndex={active ? -1 : 0}
      onKeyDown={onKeyDown}
      onFocus={(e) => {
        if (e.target !== rootRef.current || skipRootActivate.current || readOnly || activeRef.current) return;
        const r = Math.min(curRow ?? 0, total() - 1);
        if (r < 0) return;
        const f = firstEditable(r);
        if (f >= 0) setActive({ r, c: f });
      }}
      onBlur={(e) => {
        const rt = e.relatedTarget as Node | null;
        if (rt && rootRef.current?.contains(rt)) return;
        setTimeout(() => {
          const ae = document.activeElement as HTMLElement | null;
          if (!rootRef.current || rootRef.current.contains(ae)) return;
          if (ae && ae.closest('.sx-dlg-layer, .sx-popup')) return; // a message box or drop-down from a cell
          if (activeRef.current) setActive(null);
        }, 0);
      }}
    >
      <div ref={scrollRef} className="sx-grid-scroll">
        <table className="sx-grid-table" style={{ minWidth: fixedWidth }}>
          <colgroup>
            {cols.map((c) => (
              <col key={c.key} style={c.key === growKey ? undefined : { width: widthOf(c) }} />
            ))}
          </colgroup>
          <thead>
            <tr aria-rowindex={1}>
              {cols.map((c) => (
                <th key={c.key} role="columnheader" title={c.title} className={c.align ? `sx-align-${c.align}` : c.editor === 'checkbox' ? 'sx-align-center' : undefined}>
                  <span className="sx-grid-th">{c.label}</span>
                  {c.key !== growKey && <span className="sx-col-resize" onMouseDown={(e) => startResize(e, c.key, widthOf(c))} aria-hidden="true" />}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {/* one flat list, so the new line keeps its key (and editor) when it becomes a real row */}
            {[...rows.map((r, i) => renderRow(r, i, false)), ...(allowAdd ? [renderRow(phantomRef.current!, rows.length, true)] : [])]}
            {Array.from({ length: fillers }, (_, i) => (
              <tr
                key={'f' + i}
                className="sx-grid-row sx-filler"
                aria-hidden="true"
                onMouseDown={(e) => {
                  if (!allowAdd || e.button !== 0) return;
                  e.preventDefault();
                  const f = firstEditable(rows.length);
                  if (f >= 0) activate(rows.length, f);
                }}
              >
                {cols.map((c) => (
                  <td key={c.key} className="sx-grid-cell" />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {footer && <div className="sx-grid-footer">{footer}</div>}
    </div>
  );
}

/** Helper hook: stable `newRow` factory for grids (avoids re-creating the trailing line). */
export function useNewRow<R>(factory: () => R): () => R {
  const ref = useRef(factory);
  ref.current = factory;
  return useCallback(() => ref.current(), []);
}

// Selection table with a check box per row (Payments to Deposit, Select Checks to Print,
// Reconcile). Clicking a row (or Space) toggles its check box; Up/Down move the highlight;
// Enter / double-click run onActivate; headers sort. Sticky header, plain-English empty text.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { showContextMenu, type MenuItem } from '@/components';
import { fmtDate, fmtMoney } from '@/util/format';

export interface CheckColumn<T> {
  key: string;
  label: ReactNode;
  /** Width in px (default 110); with `grow` the smallest width. */
  width?: number;
  /** Takes the remaining width; a number is its share of it when several columns grow (true = 1). */
  grow?: boolean | number;
  align?: 'left' | 'right' | 'center';
  type?: 'text' | 'money' | 'date';
  render?: (row: T) => ReactNode;
  sortValue?: (row: T) => string | number | null | undefined;
  title?: string;
}

export interface CheckTableProps<T> {
  rows: readonly T[];
  getKey: (row: T) => number;
  columns: CheckColumn<T>[];
  checked: ReadonlySet<number>;
  onToggle: (key: number, row: T) => void;
  /** Header check box: check / uncheck every row shown. */
  onToggleAll?: (check: boolean) => void;
  onActivate?: (row: T) => void;
  contextMenu?: (row: T) => MenuItem[];
  rowClassName?: (row: T) => string | undefined;
  emptyText?: ReactNode;
  /** Label of the check column header for screen readers. */
  checkLabel?: string;
  className?: string;
  autoFocus?: boolean;
  /** Called with the highlighted row (for "Edit transaction" buttons). */
  onHighlight?: (row: T | null) => void;
  'aria-label'?: string;
}

/**
 * Hover on a cell whose text is cut with an ellipsis: the whole text becomes its tooltip (removed
 * again when it fits). A title the cell has itself (header help) is kept.
 */
function showCutText(e: React.MouseEvent<HTMLElement>) {
  const cell = (e.target as HTMLElement).closest<HTMLElement>('.bk-ct-cell, .bk-ct-hcell');
  if (!cell || !e.currentTarget.contains(cell) || (cell.title && !cell.dataset.sxTip)) return;
  const text = (cell.innerText || '').replace(/\s+/g, ' ').trim();
  if (text && cell.scrollWidth > cell.clientWidth + 1) {
    cell.title = text;
    cell.dataset.sxTip = '1';
  } else if (cell.dataset.sxTip) {
    cell.removeAttribute('title');
    delete cell.dataset.sxTip;
  }
}

function cellOf<T>(row: T, c: CheckColumn<T>): ReactNode {
  if (c.render) return c.render(row);
  const v = (row as Record<string, unknown>)[c.key];
  if (v === null || v === undefined) return '';
  if (c.type === 'money') return fmtMoney(v as number);
  if (c.type === 'date') return fmtDate(v as string);
  return String(v);
}

export function CheckTable<T>(props: CheckTableProps<T>) {
  const { rows, getKey, columns, checked, onToggle, onToggleAll, onActivate, contextMenu, rowClassName, emptyText, checkLabel = 'Select', className, autoFocus, onHighlight } = props;
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const [hi, setHi] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return rows;
    const val = (r: T) => (col.sortValue ? col.sortValue(r) : (r as Record<string, unknown>)[col.key]) as string | number | null | undefined;
    return rows.slice().sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      if (va === vb) return 0;
      if (va === null || va === undefined || va === '') return 1;
      if (vb === null || vb === undefined || vb === '') return -1;
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * sort.dir;
      return String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: 'base' }) * sort.dir;
    });
  }, [rows, sort, columns]);

  const hiIndex = hi === null ? -1 : sorted.findIndex((r) => getKey(r) === hi);
  useEffect(() => {
    onHighlight?.(hiIndex >= 0 ? sorted[hiIndex] : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hiIndex, sorted]);
  useEffect(() => {
    if (autoFocus) rootRef.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  const scrollTo = (i: number) => {
    const el = rootRef.current?.querySelector<HTMLElement>(`[data-ri="${i}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  };
  const move = (i: number) => {
    if (!sorted.length) return;
    const n = Math.max(0, Math.min(sorted.length - 1, i));
    setHi(getKey(sorted[n]));
    requestAnimationFrame(() => scrollTo(n));
  };

  const allChecked = sorted.length > 0 && sorted.every((r) => checked.has(getKey(r)));
  const someChecked = sorted.some((r) => checked.has(getKey(r)));
  const minW = 36 + columns.reduce((n, c) => n + (c.width ?? (c.grow ? 120 : 110)), 0);
  const template = ['36px', ...columns.map((c) => (c.grow ? `minmax(${c.width ?? 120}px, ${c.grow === true ? 1 : c.grow}fr)` : `${c.width ?? 110}px`))].join(' ');

  return (
    <div
      ref={rootRef}
      className={'bk-ct' + (className ? ' ' + className : '')}
      role="grid"
      aria-label={props['aria-label']}
      aria-multiselectable="true"
      tabIndex={0}
      onMouseOver={showCutText}
      onFocus={(e) => {
        if (e.target === e.currentTarget && hiIndex < 0 && sorted.length) setHi(getKey(sorted[0]));
      }}
      onKeyDown={(e) => {
        if (e.altKey || e.ctrlKey || e.metaKey) return;
        const k = e.key;
        if (k === 'ArrowDown') move(hiIndex + 1);
        else if (k === 'ArrowUp') move(hiIndex < 0 ? 0 : hiIndex - 1);
        else if (k === 'Home') move(0);
        else if (k === 'End') move(sorted.length - 1);
        else if (k === 'PageDown') move(hiIndex + 10);
        else if (k === 'PageUp') move(hiIndex - 10);
        else if (k === ' ') {
          const i = hiIndex >= 0 ? hiIndex : 0;
          if (!sorted.length) return;
          if (hiIndex < 0) move(0);
          onToggle(getKey(sorted[i]), sorted[i]);
        } else if (k === 'Enter') {
          if (hiIndex < 0 || !onActivate) return;
          onActivate(sorted[hiIndex]);
        } else return;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <div className="bk-ct-head" style={{ gridTemplateColumns: template, minWidth: minW }} role="row">
        <div className="bk-ct-hcell bk-ct-check" role="columnheader">
          {onToggleAll && (
            <input
              type="checkbox"
              tabIndex={-1}
              aria-label="Select all"
              checked={allChecked}
              ref={(el) => {
                if (el) el.indeterminate = !allChecked && someChecked;
              }}
              onChange={() => onToggleAll(!allChecked)}
            />
          )}
        </div>
        {columns.map((c) => {
          const on = sort?.key === c.key;
          return (
            <div
              key={c.key}
              role="columnheader"
              title={c.title}
              aria-sort={on ? (sort!.dir === 1 ? 'ascending' : 'descending') : undefined}
              className={'bk-ct-hcell' + (on ? ' bk-sorted' : '')}
              style={{ textAlign: c.align ?? (c.type === 'money' ? 'right' : 'left') }}
              onClick={() => setSort(!on ? { key: c.key, dir: 1 } : sort!.dir === 1 ? { key: c.key, dir: -1 } : null)}
            >
              {c.label}
              {on && <span className="bk-ct-sort">{sort!.dir === 1 ? ' ▲' : ' ▼'}</span>}
            </div>
          );
        })}
      </div>
      <div className="bk-ct-body" style={{ minWidth: minW }}>
        {sorted.map((r, i) => {
          const key = getKey(r);
          const on = checked.has(key);
          return (
            <div
              key={key}
              data-ri={i}
              role="row"
              aria-selected={on}
              className={'bk-ct-row' + (on ? ' bk-on' : '') + (i === hiIndex ? ' bk-hi' : '') + (rowClassName ? ' ' + (rowClassName(r) ?? '') : '')}
              style={{ gridTemplateColumns: template }}
              onMouseDown={(e) => {
                if (e.button !== 0) return;
                setHi(key);
              }}
              onClick={(e) => {
                if (e.detail > 1) return;
                onToggle(key, r);
              }}
              onDoubleClick={() => onActivate?.(r)}
              onContextMenu={(e) => {
                if (!contextMenu) return;
                setHi(key);
                const items = contextMenu(r);
                if (items.length) showContextMenu(e, items);
              }}
            >
              <div className="bk-ct-cell bk-ct-check">
                <input type="checkbox" tabIndex={-1} checked={on} readOnly aria-label={checkLabel} />
              </div>
              {columns.map((c) => (
                <div key={c.key} className="bk-ct-cell" role="gridcell" style={{ textAlign: c.align ?? (c.type === 'money' ? 'right' : 'left') }}>
                  {cellOf(r, c)}
                </div>
              ))}
            </div>
          );
        })}
        {!sorted.length && emptyText ? <div className="bk-ct-empty">{emptyText}</div> : null}
      </div>
    </div>
  );
}

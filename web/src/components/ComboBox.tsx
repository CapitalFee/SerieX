// Drop-down field with auto-complete, quick create and recent entries.
//
// Typing completes the first entry whose label starts with the typed text and selects the rest
// (auto-complete); the list opens and shows the entries containing the text. Typing a subaccount name
// ("Tel") or a colon path ("Util:Tel") highlights "Utilities:Telephone". Deleting the completion
// means "exactly what I typed" (then Tab reports "not in the list" through onNotFound).
//
// Action rows at the top of the list:
//   "+ Add new"                 (onAddNew, when the field is empty) – opens the full dialog
//   "+ Add "<typed>""           (onQuickAdd, when the typed text matches no entry) – highlighted
//                               when nothing else matches, so Tab/Enter starts the quick create
//   "Add "<typed>" with details…" (onAddWithDetails)
// With `recentKeys`, an empty field lists the recently used entries first under "Recent".
//
// Keys: Up/Down move in the open list (outside grids they also open it), Alt+Down/F4 toggle,
// PageUp/PageDown page, Enter picks, Tab picks and moves on, Escape closes/reverts.
// Inactive entries are hidden unless selected or typed: then they are listed "(inactive)" and
// picking one asks onPickInactive. `getMatchText` / `getCode` let a name or number match an entry
// whose label has a prefix (accounts with numbers). Inline errors come from a FormErrorsProvider (`name`).
import {
  forwardRef,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react';
import { ChevronDown, Plus } from 'lucide-react';
import { Popup } from './Popup';
import { useControlError } from './inputs';

/** Key of a combo entry (usually the record id). */
export type ComboKey = string | number;

/** Extra right-hand column of the drop-down list (e.g. account type, balance, price). */
export interface ComboColumn<T> {
  /** Width in px. */
  width: number;
  align?: 'left' | 'right' | 'center';
  render: (item: T) => ReactNode;
  className?: string;
  /** Small header shown above the column when the list has headers (e.g. "Balance"). */
  label?: string;
}

/** Props of {@link ComboBox}. */
export interface ComboBoxProps<T> {
  /** Entries in display (tree) order. */
  items: readonly T[];
  /** Key of the selected entry (null/undefined = none). */
  value: ComboKey | null | undefined;
  /** Called when the user picks an entry or clears the field (key null). */
  onChange: (key: ComboKey | null, item: T | null) => void;
  getKey: (item: T) => ComboKey;
  /** Text shown in the field and used by auto-complete (e.g. full name "Utilities:Telephone"). */
  getLabel: (item: T) => string;
  /** Text shown in the list when not filtering (e.g. the leaf name, indented by level). Default getLabel. */
  getListLabel?: (item: T) => ReactNode;
  /** Indentation level in the list (subaccounts, jobs). */
  getLevel?: (item: T) => number;
  /** Extra text the typed text may match (e.g. account number, description). */
  getSearchText?: (item: T) => string;
  /**
   * Name used by auto-complete and "is it in the list" when the label has a prefix the user does not
   * type (e.g. accounts with numbers: label "68600 · Utilities", match text "Utilities").
   * Default getLabel.
   */
  getMatchText?: (item: T) => string;
  /** Short code that also selects the entry when typed in full (e.g. the account number). */
  getCode?: (item: T) => string;
  /**
   * Inactive entries are hidden unless selected (shown gray italic then); typing their name lists
   * them marked "(inactive)" (see onPickInactive).
   */
  isInactive?: (item: T) => boolean;
  /**
   * Called when the user picks an inactive entry; resolve true to select it (e.g. after making it
   * active again, or to use it once). Default: inactive entries are selected without asking.
   */
  onPickInactive?: (item: T) => Promise<boolean>;
  /** Entries shown but not selectable. */
  isDisabled?: (item: T) => boolean;
  /** Extra columns at the right of the list. */
  columns?: ComboColumn<T>[];
  /** Shows "+ Add new" as the first row (empty field); called with the typed text. */
  onAddNew?: (typed: string) => void;
  /** Text of the Add New row (default "Add new"). */
  addNewLabel?: string;
  /**
   * Quick create: shows '+ Add "<typed>"' when the typed text matches no entry.
   * Receives the typed text and the field's wrapper element (anchor for a popover).
   */
  onQuickAdd?: (typed: string, anchor: HTMLElement | null) => void;
  /** Text of the quick create row (default `Add "<typed>"`). */
  quickAddLabel?: (typed: string) => string;
  /** Shows 'Add "<typed>" with details…' under the quick create row (opens the full dialog). */
  onAddWithDetails?: (typed: string) => void;
  /** Called when the user leaves the field with text that matches no entry (the field reverts). */
  onNotFound?: (typed: string) => void;
  /** Keys of recently used entries, listed first under "Recent" when the field is empty. */
  recentKeys?: readonly ComboKey[];
  /** Text to show when `value` is set but not (yet) in `items` (e.g. txn.nameFull while loading). */
  fallbackLabel?: string;
  placeholder?: string;
  disabled?: boolean;
  readOnly?: boolean;
  autoFocus?: boolean;
  id?: string;
  /** Field name: also the key of its inline error in a FormErrorsProvider. */
  name?: string;
  title?: string;
  className?: string;
  style?: CSSProperties;
  /** Field width (px or CSS); default fills the container. */
  width?: number | string;
  /** Minimum width of the drop-down list in px (it may be wider than the field). */
  listWidth?: number;
  /** Visible rows of the list (default 12). */
  maxRows?: number;
  /** Borderless style for grid cells; Up/Down on a closed list are left to the grid. */
  inGrid?: boolean;
  tabIndex?: number;
  /** Red border (errors from a FormErrorsProvider set it automatically). */
  invalid?: boolean;
  /** Keep the red border of an inline error but not its message. */
  hideErrorMessage?: boolean;
  'aria-label'?: string;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onFocus?: (e: React.FocusEvent<HTMLInputElement>) => void;
  onBlur?: (e: React.FocusEvent<HTMLInputElement>) => void;
}

const ROW_H = 26;

type Row<T> =
  | { t: 'item'; item: T; recent?: boolean }
  | { t: 'add' }
  | { t: 'quick' }
  | { t: 'details' }
  | { t: 'header'; label: string };

function segPrefix(label: string, q: string): boolean {
  if (!q.includes(':')) return false;
  const ls = label.toLowerCase().split(':');
  const qs = q.split(':');
  if (qs.length > ls.length) return false;
  return qs.every((s, i) => ls[i].startsWith(s.trim()));
}

function ComboBoxInner<T>(props: ComboBoxProps<T>, ref: Ref<HTMLInputElement>) {
  const {
    items,
    value,
    onChange,
    getKey,
    getLabel,
    getListLabel,
    getLevel,
    getSearchText,
    getMatchText,
    getCode,
    isInactive,
    onPickInactive,
    isDisabled,
    columns,
    onAddNew,
    addNewLabel = 'Add new',
    onQuickAdd,
    quickAddLabel,
    onAddWithDetails,
    onNotFound,
    recentKeys,
    fallbackLabel,
    placeholder,
    disabled,
    readOnly,
    autoFocus,
    id,
    name,
    title,
    className,
    style,
    width,
    listWidth,
    maxRows = 12,
    inGrid,
    tabIndex,
    invalid,
    hideErrorMessage,
    onKeyDown,
    onFocus,
    onBlur,
  } = props;
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useImperativeHandle(ref, () => inputRef.current!);
  const listId = useId();
  const err = useControlError(name, inGrid, hideErrorMessage);

  /** What the user typed (filter + auto-complete query); null = not typing. */
  const [query, setQueryState] = useState<string | null>(null);
  /** Text in the input while editing; null = show the selected label. */
  const [text, setTextState] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [hi, setHiState] = useState(-1);
  // refs mirror the editing state synchronously: Tab/blur/outside-click may commit twice in one event
  const queryRef = useRef<string | null>(null);
  const textRef = useRef<string | null>(null);
  const hiRef = useRef(-1);
  const setQuery = (v: string | null) => {
    queryRef.current = v;
    setQueryState(v);
  };
  const setText = (v: string | null) => {
    textRef.current = v;
    setTextState(v);
  };
  const setHi = (v: number) => {
    hiRef.current = v;
    setHiState(v);
  };
  const [scrollTop, setScrollTop] = useState(0);
  const pendingSel = useRef<[number, number] | null>(null);
  const committed = useRef<ComboKey | null | undefined>(value);
  if (text === null) committed.current = value;

  const hasValue = value !== null && value !== undefined && value !== '';
  const selected = useMemo(() => (!hasValue ? null : items.find((i) => getKey(i) === value) ?? null), [items, value, getKey, hasValue]);
  const label = selected ? getLabel(selected) : hasValue ? fallbackLabel ?? '' : '';
  const labelRef = useRef(label);
  labelRef.current = label;

  const visible = useMemo(() => (isInactive ? items.filter((i) => !isInactive(i) || getKey(i) === value) : items.slice()), [items, isInactive, value, getKey]);

  const inactiveOf = (i: T) => !!isInactive?.(i);
  const matchOf = (i: T) => (getMatchText ? getMatchText(i) : getLabel(i));
  const codeOf = (i: T) => (getCode ? getCode(i) ?? '' : '');
  /** The (lower case, trimmed) typed text names this entry exactly: its label, name or code. */
  const isExact = (i: T, lower: string) =>
    !!lower && (getLabel(i).toLowerCase() === lower || matchOf(i).toLowerCase() === lower || codeOf(i).toLowerCase() === lower);
  /** True when the typed text starts the entry's label or name (auto-complete candidates). */
  const startsWithText = (i: T, lower: string) => getLabel(i).toLowerCase().startsWith(lower) || matchOf(i).toLowerCase().startsWith(lower);

  // While typing, inactive entries whose name matches are listed too (marked "(inactive)").
  const exactMatch = (q: string) => {
    const lower = q.trim().toLowerCase();
    return !!lower && items.some((i) => isExact(i, lower));
  };

  const buildRows = (q: string | null, emptyField: boolean): Row<T>[] => {
    const s = (q ?? '').trim().toLowerCase();
    const out: Row<T>[] = [];
    if (!s) {
      if (onAddNew) out.push({ t: 'add' });
      if (emptyField && recentKeys && recentKeys.length) {
        const byKey = new Map(visible.map((i) => [getKey(i), i] as const));
        const rec = recentKeys
          .map((k) => byKey.get(k))
          .filter((i): i is T => i !== undefined && !(isInactive?.(i) ?? false))
          .slice(0, 5);
        if (rec.length) {
          out.push({ t: 'header', label: 'Recent' });
          for (const r of rec) out.push({ t: 'item', item: r, recent: true });
          out.push({ t: 'header', label: 'All' });
        }
      }
      for (const i of visible) out.push({ t: 'item', item: i });
      return out;
    }
    const noExact = !exactMatch(s);
    if (noExact && onQuickAdd) out.push({ t: 'quick' });
    if (noExact && onAddWithDetails) out.push({ t: 'details' });
    if (!onQuickAdd && !onAddWithDetails && onAddNew) out.push({ t: 'add' });
    for (const i of items) {
      const l = getLabel(i).toLowerCase();
      const m = matchOf(i).toLowerCase();
      if (
        l.includes(s) ||
        m.includes(s) ||
        segPrefix(l, s) ||
        segPrefix(m, s) ||
        codeOf(i).toLowerCase().startsWith(s) ||
        (getSearchText ? getSearchText(i).toLowerCase().includes(s) : false)
      )
        out.push({ t: 'item', item: i });
    }
    return out;
  };
  const emptyField = !hasValue && (text === null || text === '');
  const rows = useMemo(() => buildRows(query, emptyField), [query, items, visible, onAddNew, onQuickAdd, onAddWithDetails, recentKeys, emptyField]); // eslint-disable-line react-hooks/exhaustive-deps
  const filtering = !!query && query.trim() !== '';
  const typedText = (query ?? '').trim();

  useLayoutEffect(() => {
    if (pendingSel.current && inputRef.current && document.activeElement === inputRef.current) {
      const [a, b] = pendingSel.current;
      inputRef.current.setSelectionRange(a, b);
    }
    pendingSel.current = null;
  });

  // keep the highlighted row visible
  const listH = Math.min(Math.max(rows.length, 1), maxRows) * ROW_H;
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!open || !el || hi < 0) return;
    const top = hi * ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + listH) el.scrollTop = top + ROW_H - listH;
    setScrollTop(el.scrollTop);
  }, [hi, open, listH]);

  const selectable = (r: Row<T> | undefined) => !!r && r.t !== 'header' && (r.t !== 'item' || !isDisabled?.(r.item));
  const isItem = (r: Row<T> | undefined): r is { t: 'item'; item: T; recent?: boolean } => !!r && r.t === 'item';

  const reset = () => {
    setQuery(null);
    setText(null);
    setOpen(false);
    setHi(-1);
  };

  const emit = (item: T | null) => {
    const key = item ? getKey(item) : null;
    if (key !== (committed.current ?? null)) {
      committed.current = key;
      err.clear();
      onChange(key, item);
    }
  };

  /**
   * Commits the typed text (or the given row index) and leaves editing mode.
   * Returns "dialog" when Add New / quick create / not-found handling takes over.
   */
  const commit = (rowIndex?: number): 'none' | 'chosen' | 'dialog' => {
    const text = textRef.current;
    if (text === null && rowIndex === undefined) return 'none';
    const typed = (queryRef.current ?? text ?? '').trim();
    const rws = buildRows(queryRef.current, !hasValue && (text === null || text === ''));
    const hi = hiRef.current;
    let row: Row<T> | undefined;
    if (rowIndex !== undefined && rowIndex >= 0) row = rws[rowIndex];
    else {
      const v = (text ?? '').trim();
      if (v === '') {
        emit(null);
        reset();
        return 'chosen';
      }
      const lower = v.toLowerCase();
      const hiRow = hi >= 0 ? rws[hi] : undefined;
      // the text names an entry (label, name or code): the highlighted one first, then active ones
      const found =
        isItem(hiRow) && isExact(hiRow.item, lower)
          ? hiRow.item
          : items.find((i) => !inactiveOf(i) && isExact(i, lower)) ?? items.find((i) => isExact(i, lower));
      row = found !== undefined ? { t: 'item', item: found } : hiRow;
    }
    reset();
    if (row?.t === 'add') {
      onAddNew?.(typed);
      return 'dialog';
    }
    if (row?.t === 'quick') {
      onQuickAdd?.(typed, wrapRef.current);
      return 'dialog';
    }
    if (row?.t === 'details') {
      onAddWithDetails?.(typed);
      return 'dialog';
    }
    if (isItem(row) && selectable(row)) {
      const item = row.item;
      if (onPickInactive && inactiveOf(item) && getKey(item) !== (committed.current ?? null)) {
        // "X is inactive: make it active / use it once / cancel" (the box returns focus here)
        void onPickInactive(item).then(
          (ok) => {
            if (ok) emit(item);
          },
          () => undefined,
        );
        return 'dialog';
      }
      emit(item);
      return 'chosen';
    }
    if (typed && onNotFound) {
      onNotFound(typed);
      return 'dialog';
    }
    if (typed && onQuickAdd) {
      onQuickAdd(typed, wrapRef.current);
      return 'dialog';
    }
    return 'none';
  };

  const openList = () => {
    const r = buildRows(query, emptyField);
    const idx = selected ? r.findIndex((x) => isItem(x) && !x.recent && x.item === selected) : -1;
    setHi(idx);
    setOpen(true);
    // center the selection
    requestAnimationFrame(() => {
      const el = listRef.current;
      if (el && idx >= 0) {
        el.scrollTop = Math.max(0, idx * ROW_H - (maxRows * ROW_H) / 2);
        setScrollTop(el.scrollTop);
      }
    });
  };

  const move = (delta: number) => {
    if (!rows.length) return;
    const i = hiRef.current;
    const dir = delta > 0 ? 1 : -1;
    let steps = Math.abs(delta);
    let target = i;
    while (steps > 0) {
      let j = target + dir;
      while (j >= 0 && j < rows.length && !selectable(rows[j])) j += dir;
      if (j < 0 || j >= rows.length) break;
      target = j;
      steps--;
    }
    if (target === i && i === -1 && dir > 0) target = rows.findIndex((r) => selectable(r));
    if (target < 0) return;
    setHi(target);
    const r = rows[target];
    if (isItem(r)) {
      const l = getLabel(r.item);
      setText(l);
      pendingSel.current = [0, l.length];
    }
  };

  const onType = (e: React.ChangeEvent<HTMLInputElement>) => typed(e.target.value, (e.nativeEvent as InputEvent).inputType ?? '');

  /** The user changed the text to `v` (typing, deleting, pasting): filter, auto-complete, highlight. */
  const typed = (v: string, inputType: string) => {
    const isDelete = inputType.startsWith('delete');
    setQuery(v);
    if (!open && v !== '') setOpen(true);
    const q = v.toLowerCase();
    const r = buildRows(v, false);
    const quickIdx = r.findIndex((x) => x.t === 'quick');
    if (!v) {
      setText('');
      setHi(-1);
      return;
    }
    if (isDelete) {
      setText(v);
      const lower = q.trim();
      let exact = r.findIndex((x) => isItem(x) && !inactiveOf(x.item) && isExact(x.item, lower));
      if (exact < 0) exact = r.findIndex((x) => isItem(x) && isExact(x.item, lower));
      setHi(exact >= 0 ? exact : quickIdx);
      return;
    }
    // active entries first; an inactive entry only when no active one fits
    const firstItem = (test: (it: T) => boolean) => {
      const i = r.findIndex((x) => isItem(x) && selectable(x) && !inactiveOf(x.item) && test(x.item));
      return i >= 0 ? i : r.findIndex((x) => isItem(x) && selectable(x) && inactiveOf(x.item) && test(x.item));
    };
    // auto-complete: complete with the first entry whose label (or name without its number) starts with the text
    const pref = firstItem((it) => startsWithText(it, q));
    if (pref >= 0) {
      const it = (r[pref] as { item: T }).item;
      const l = getLabel(it);
      const full = l.toLowerCase().startsWith(q) ? l : matchOf(it);
      setText(full);
      pendingSel.current = [v.length, full.length];
      setHi(pref);
      return;
    }
    setText(v);
    // subaccount / leaf name / colon path prefix / code
    const leaf = firstItem((it) => {
      const m = matchOf(it).toLowerCase();
      const last = m.slice(m.lastIndexOf(':') + 1);
      return last.startsWith(q) || segPrefix(m, q) || m.split(':').some((p) => p.startsWith(q)) || segPrefix(getLabel(it).toLowerCase(), q) || codeOf(it).toLowerCase().startsWith(q);
    });
    // nothing starts with the text: the quick create row is the default choice
    setHi(leaf >= 0 ? leaf : quickIdx);
  };

  // Typing the next letter of an auto-complete completion ("Utilitie" + "s" over the selected "s")
  // leaves the text as it was, so React fires no onChange and the query would stay "Utilitie"
  // (offering 'Add "Utilitie"'). The native input event still fires: handle it here then.
  const typedRef = useRef(typed);
  typedRef.current = typed;
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const onInput = (e: Event) => {
      const shown = textRef.current ?? labelRef.current;
      if (el.value !== shown || queryRef.current === el.value) return; // React handles it (or nothing changed)
      typedRef.current(el.value, (e as InputEvent).inputType ?? '');
    };
    el.addEventListener('input', onInput);
    return () => el.removeEventListener('input', onInput);
  }, []);

  const fieldEditable = !disabled && !readOnly;
  const colWidth = (columns ?? []).reduce((s, c) => s + c.width, 0);
  const fieldW = wrapRef.current?.offsetWidth ?? 0;
  const popupWidth = Math.max(fieldW, listWidth ?? (columns?.length ? 200 + colWidth : 0), 160);
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - 3);
  const end = Math.min(rows.length, start + maxRows + 6);
  const bad = invalid || !!err.error;
  const curItem = (r: Row<T>) => isItem(r) && !r.recent && selected === r.item;

  const renderRow = (r: Row<T>, i: number) => {
    const base = 'sx-combo-row' + (i === hi ? ' sx-hi' : '');
    const common = {
      id: `${listId}-${i}`,
      role: 'option' as const,
      'aria-selected': i === hi,
      style: { top: i * ROW_H, height: ROW_H },
      onMouseEnter: () => selectable(r) && setHi(i),
      onClick: () => selectable(r) && commit(i),
    };
    switch (r.t) {
      case 'header':
        return (
          <div key={`h-${i}`} className="sx-combo-row sx-combo-header" role="presentation" style={{ top: i * ROW_H, height: ROW_H }}>
            <span className="sx-combo-name">{r.label}</span>
            {r.label === 'All' || r.label === 'Recent'
              ? columns?.map((c, ci) => (
                  <span key={ci} className="sx-combo-col" style={{ width: c.width, textAlign: c.align ?? 'left' }}>
                    {r.label === 'Recent' ? c.label ?? '' : ''}
                  </span>
                ))
              : null}
          </div>
        );
      case 'add':
        return (
          <div key="__add" {...common} className={base + ' sx-combo-action'}>
            <span className="sx-combo-name">
              <Plus size={14} className="sx-combo-action-icon" aria-hidden="true" />
              {addNewLabel.replace(/^<\s*|\s*>$/g, '')}
            </span>
          </div>
        );
      case 'quick':
        return (
          <div key="__quick" {...common} className={base + ' sx-combo-action'}>
            <span className="sx-combo-name">
              <Plus size={14} className="sx-combo-action-icon" aria-hidden="true" />
              {quickAddLabel ? quickAddLabel(typedText) : <>Add &ldquo;{typedText}&rdquo;</>}
            </span>
          </div>
        );
      case 'details':
        return (
          <div key="__details" {...common} className={base + ' sx-combo-action sx-combo-details'}>
            <span className="sx-combo-name">Add with details&hellip;</span>
          </div>
        );
      default: {
        const item = r.item;
        const inactive = isInactive?.(item);
        const dis = isDisabled?.(item);
        return (
          <div
            key={(r.recent ? 'r:' : '') + String(getKey(item))}
            {...common}
            aria-disabled={dis || undefined}
            className={base + (inactive ? ' sx-inactive' : '') + (dis ? ' sx-disabled' : '') + (curItem(r) ? ' sx-cur' : '')}
          >
            <span className="sx-combo-name" style={{ paddingLeft: 10 + (filtering || r.recent ? 0 : (getLevel?.(item) ?? 0) * 14) }}>
              {filtering || r.recent || !getListLabel ? getLabel(item) : getListLabel(item)}
              {inactive ? ' (inactive)' : null}
            </span>
            {columns?.map((c, ci) => (
              <span key={ci} className={'sx-combo-col' + (c.className ? ' ' + c.className : '')} style={{ width: c.width, textAlign: c.align ?? 'left' }}>
                {c.render(item)}
              </span>
            ))}
          </div>
        );
      }
    }
  };

  return (
    <>
      <div
        ref={wrapRef}
        className={
          'sx-combo' +
          (inGrid ? ' sx-in-grid' : '') +
          (disabled ? ' sx-disabled' : '') +
          (open ? ' sx-open' : '') +
          (bad ? ' sx-invalid' : '') +
          (className ? ' ' + className : '')
        }
        style={{ width, ...style }}
        title={title}
      >
        <input
          ref={inputRef}
          id={id}
          name={name}
          type="text"
          className={'sx-input' + (inGrid ? ' sx-in-grid' : '') + (bad ? ' sx-invalid' : '') + (selected && isInactive?.(selected) ? ' sx-inactive-text' : '')}
          role="combobox"
          aria-label={props['aria-label']}
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="both"
          aria-invalid={bad || undefined}
          aria-describedby={err.describedBy}
          aria-activedescendant={open && hi >= 0 ? `${listId}-${hi}` : undefined}
          autoComplete="off"
          spellCheck={false}
          autoFocus={autoFocus}
          disabled={disabled}
          readOnly={readOnly}
          tabIndex={tabIndex}
          placeholder={placeholder}
          value={text ?? label}
          onChange={onType}
          onFocus={(e) => {
            if (textRef.current === null) e.target.select();
            onFocus?.(e);
          }}
          onBlur={(e) => {
            if (textRef.current !== null) commit(hiRef.current >= 0 ? hiRef.current : undefined);
            else setOpen(false);
            onBlur?.(e);
          }}
          onKeyDown={(e) => {
            if (!fieldEditable) {
              onKeyDown?.(e);
              return;
            }
            const k = e.key;
            const handled = () => {
              e.preventDefault();
              e.stopPropagation();
            };
            if ((k === 'ArrowDown' || k === 'ArrowUp') && e.altKey) {
              if (open) setOpen(false);
              else openList();
              return handled();
            }
            if (k === 'F4') {
              if (open) setOpen(false);
              else openList();
              return handled();
            }
            if (k === 'ArrowDown' || k === 'ArrowUp') {
              if (!open) {
                if (inGrid) {
                  if (textRef.current !== null) commit(hiRef.current >= 0 ? hiRef.current : undefined);
                  onKeyDown?.(e);
                  return;
                }
                openList();
                return handled();
              }
              move(k === 'ArrowDown' ? 1 : -1);
              return handled();
            }
            if (open && (k === 'PageDown' || k === 'PageUp')) {
              move(k === 'PageDown' ? maxRows : -maxRows);
              return handled();
            }
            if (k === 'Enter') {
              if (open) {
                commit(hiRef.current >= 0 ? hiRef.current : undefined);
                return handled();
              }
              if (textRef.current !== null && commit() === 'dialog') return handled();
            } else if (k === 'Tab') {
              // a box (Add New / quick create / not in list) takes over: stay in this field (and grid cell)
              if (textRef.current !== null && commit(hiRef.current >= 0 ? hiRef.current : undefined) === 'dialog') return handled();
              setOpen(false);
            } else if (k === 'Escape') {
              if (open || textRef.current !== null) {
                reset();
                return handled();
              }
            }
            onKeyDown?.(e);
          }}
        />
        {!readOnly && (
          <button
            type="button"
            className="sx-combo-btn"
            tabIndex={-1}
            disabled={disabled}
            aria-label="Show list"
            onMouseDown={(e) => {
              e.preventDefault();
              if (!fieldEditable) return;
              if (document.activeElement !== inputRef.current) inputRef.current?.focus();
              if (open) setOpen(false);
              else openList();
            }}
          >
            <ChevronDown size={14} strokeWidth={2} aria-hidden="true" />
          </button>
        )}
        <Popup anchor={wrapRef.current} open={open} onClose={() => setOpen(false)} minWidth={popupWidth} className="sx-popup-list">
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            className="sx-combo-list"
            style={{ height: rows.length ? listH : 0, width: popupWidth }}
            onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
          >
            {rows.length === 0 ? null : <div style={{ height: rows.length * ROW_H, position: 'relative' }}>{rows.slice(start, end).map((r, n) => renderRow(r, start + n))}</div>}
          </div>
          {rows.length === 0 && <div className="sx-combo-empty">No matches</div>}
        </Popup>
      </div>
      {err.message}
    </>
  );
}

/**
 * Generic drop-down with auto-complete type-ahead, tree indentation, extra columns, "+ Add new",
 * quick create rows, recent entries and full keyboard support. Pickers (AccountPicker,
 * NamePicker, ...) build on it.
 */
export const ComboBox = forwardRef(ComboBoxInner) as <T>(props: ComboBoxProps<T> & { ref?: Ref<HTMLInputElement> }) => ReactElement;

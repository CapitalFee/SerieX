// Date input with date shortcut keys and a calendar popover.
//
// Clicking the field (or the calendar button, Alt+Down, F4) opens a month calendar: arrows move
// the cursor by day/week, PageUp/PageDown by month (Shift: by year), Home/End to the start/end
// of the week, Enter or a click picks, "Today" picks today, Escape closes. Typing keeps working.
// Inline errors: a FormErrorsProvider error for `name` shows a red border and a message below.
//
// Keys while the field has focus:
//   + or =  next day        -  previous day       t  today
//   w  first day of week    k  last day of week   (press again for the previous/next week)
//   m  first day of month   h  last day of month  (press again for the previous/next month)
//   y  first day of year    r  last day of year   (press again for the previous/next year)
//   [  same day previous week    ]  same day next week
// Typed text accepts 1/5, 1/5/26, 01/05/2026, 010526 and is reformatted MM/DD/YYYY on blur.
import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { fmtDate, parseDate } from '@/util/format';
import {
  addDays,
  addMonthsClamped,
  endOfMonth,
  endOfWeek,
  endOfYear,
  MONTH_NAMES,
  startOfMonth,
  startOfWeek,
  startOfYear,
  todayIso,
  weekday,
} from '@/util/dates';
import { Popup } from './Popup';
import { useControlError } from './inputs';

/** Props of {@link DateField}. */
export interface DateFieldProps {
  /** ISO date `YYYY-MM-DD`, or "" for no date. */
  value: string | null | undefined;
  /** Called with the new ISO date ("" when cleared). Fires on commit and on every shortcut key. */
  onChange?: (iso: string) => void;
  /** Do not allow an empty date (clearing reverts to the previous date). */
  required?: boolean;
  width?: number | string;
  /** Borderless style for grid cells. */
  inGrid?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  autoFocus?: boolean;
  name?: string;
  id?: string;
  title?: string;
  className?: string;
  style?: CSSProperties;
  'aria-label'?: string;
  tabIndex?: number;
  placeholder?: string;
  /** Open the calendar when the field is clicked (default true; the button and Alt+Down always work). */
  calendarOnClick?: boolean;
  /** Red border; errors from a FormErrorsProvider (by `name`) set it automatically. */
  invalid?: boolean;
  /** Keep the red border of an inline error but not its message. */
  hideErrorMessage?: boolean;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onFocus?: (e: React.FocusEvent<HTMLInputElement>) => void;
  onBlur?: (e: React.FocusEvent<HTMLInputElement>) => void;
}

/** Applies a date shortcut key to a date; returns null when `key` is not a shortcut. */
export function applyDateKey(key: string, d: string): string | null {
  switch (key) {
    case '+':
    case '=':
      return addDays(d, 1);
    case '-':
    case '_':
      return addDays(d, -1);
    case 't':
    case 'T':
      return todayIso();
    case 'w':
    case 'W':
      return weekday(d) === 0 ? startOfWeek(addDays(d, -1)) : startOfWeek(d);
    case 'k':
    case 'K':
      return weekday(d) === 6 ? endOfWeek(addDays(d, 1)) : endOfWeek(d);
    case 'm':
    case 'M':
      return d === startOfMonth(d) ? startOfMonth(addDays(d, -1)) : startOfMonth(d);
    case 'h':
    case 'H':
      return d === endOfMonth(d) ? endOfMonth(addDays(d, 1)) : endOfMonth(d);
    case 'y':
    case 'Y':
      return d === startOfYear(d) ? startOfYear(addDays(d, -1)) : startOfYear(d);
    case 'r':
    case 'R':
      return d === endOfYear(d) ? endOfYear(addDays(d, 1)) : endOfYear(d);
    case '[':
      return addDays(d, -7);
    case ']':
      return addDays(d, 7);
    default:
      return null;
  }
}

/** Date input (MM/DD/YYYY) with date shortcut keys and a calendar popup. */
export const DateField = forwardRef<HTMLInputElement, DateFieldProps>(function DateField(props, ref) {
  const { value, onChange, required, width, inGrid, disabled, readOnly, className, style, onKeyDown, onFocus, onBlur, calendarOnClick = true, invalid, hideErrorMessage, ...rest } = props;
  const err = useControlError(rest.name, inGrid, hideErrorMessage);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  useImperativeHandle(ref, () => inputRef.current!);
  const [text, setTextState] = useState<string | null>(null);
  /** The value the edit text was built from, and whether the user changed the text since. */
  const base = useRef<{ value: string; modified: boolean } | null>(null);
  /** Text the field shows after a new `value` replaced the edit text (re-selected once rendered). */
  const resynced = useRef<string | null>(null);
  /** Sets the edit text; `fromValue` = built from that value (not typed / picked by the user). */
  const setText = (t: string | null, fromValue?: string) => {
    if (t === null) base.current = null;
    else if (fromValue !== undefined) base.current = { value: fromValue, modified: false };
    else if (base.current) base.current.modified = true;
    else base.current = { value: valueRef.current, modified: true };
    setTextState(t);
  };
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<string>(() => startOfMonth(value || todayIso()));
  const valueRef = useRef(value ?? '');
  valueRef.current = value ?? '';
  // select the whole date after a shortcut key, right after the re-render (before the next key)
  const selectAll = useRef(false);
  useLayoutEffect(() => {
    if (!selectAll.current) return;
    selectAll.current = false;
    if (document.activeElement === inputRef.current) inputRef.current?.select();
  });

  // A new `value` arrives while the field has focus but before the user typed (e.g. the record
  // finished loading after an autoFocus): show it, so leaving the field does not write back the
  // stale text.
  useLayoutEffect(() => {
    const b = base.current;
    const v = value ?? '';
    if (text === null || !b || b.modified || b.value === v) return;
    const t = fmtDate(v);
    resynced.current = t;
    setText(t, v);
    setView(startOfMonth(v || todayIso()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  useLayoutEffect(() => {
    const t = resynced.current;
    if (t === null) return;
    const el = inputRef.current;
    if (!el || document.activeElement !== el) {
      resynced.current = null;
      return;
    }
    if (el.value !== t) return; // wait for the commit that writes the new text
    resynced.current = null;
    el.select();
  });

  const current = (): string => {
    if (text !== null) {
      const p = parseDate(text, valueRef.current || todayIso());
      if (p) return p;
    }
    return valueRef.current || todayIso();
  };

  const set = (iso: string, keepText = true) => {
    if (iso !== valueRef.current) {
      err.clear();
      onChange?.(iso);
    }
    valueRef.current = iso;
    setText(keepText ? fmtDate(iso) : null, iso);
    setView(startOfMonth(iso || todayIso()));
  };

  const commit = () => {
    if (text === null) return;
    const t = text.trim();
    if (t === '') {
      if (required) setText(null);
      else set('', false);
      return;
    }
    const p = parseDate(t, valueRef.current || todayIso());
    if (!p) {
      setText(null); // invalid: revert
      return;
    }
    set(p, false);
  };

  const openCalendar = () => {
    setView(startOfMonth(current()));
    setOpen(true);
  };

  const editable = !disabled && !readOnly;

  const bad = invalid || !!err.error;
  return (
    <>
    <div
      ref={wrapRef}
      className={'sx-datefield' + (inGrid ? ' sx-in-grid' : '') + (disabled ? ' sx-disabled' : '') + (open ? ' sx-open' : '') + (bad ? ' sx-invalid' : '') + (className ? ' ' + className : '')}
      style={{ width, ...style }}
    >
      <input
        ref={inputRef}
        type="text"
        autoComplete="off"
        spellCheck={false}
        placeholder={rest.placeholder ?? (inGrid ? undefined : 'MM/DD/YYYY')}
        {...rest}
        disabled={disabled}
        readOnly={readOnly}
        className={'sx-input' + (inGrid ? ' sx-in-grid' : '') + (bad ? ' sx-invalid' : '')}
        role="combobox"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-invalid={bad || undefined}
        aria-describedby={err.describedBy}
        value={text ?? fmtDate(value)}
        onFocus={(e) => {
          setText(fmtDate(value), value ?? '');
          e.target.select();
          onFocus?.(e);
        }}
        onMouseUp={() => {
          // a click in the field opens the calendar (typing still works)
          if (calendarOnClick && editable && !open) openCalendar();
        }}
        onChange={(e) => {
          selectAll.current = false;
          setText(e.target.value.replace(/[^0-9/.\s]/g, ''));
        }}
        onBlur={(e) => {
          commit();
          setOpen(false);
          onBlur?.(e);
        }}
        onKeyDown={(e) => {
          if (!editable) {
            onKeyDown?.(e);
            return;
          }
          const k = e.key;
          if ((k === 'ArrowDown' && e.altKey) || k === 'F4') {
            e.preventDefault();
            e.stopPropagation();
            if (open) setOpen(false);
            else openCalendar();
            return;
          }
          if (open) {
            const d = current();
            let next: string | null = null;
            if (k === 'ArrowLeft') next = addDays(d, -1);
            else if (k === 'ArrowRight') next = addDays(d, 1);
            else if (k === 'ArrowUp') next = addDays(d, -7);
            else if (k === 'ArrowDown') next = addDays(d, 7);
            else if (k === 'PageUp') next = addMonthsClamped(d, e.shiftKey ? -12 : -1);
            else if (k === 'PageDown') next = addMonthsClamped(d, e.shiftKey ? 12 : 1);
            else if (k === 'Home') next = startOfWeek(d);
            else if (k === 'End') next = endOfWeek(d);
            else if (k === 'Enter') {
              set(d);
              setOpen(false);
              e.preventDefault();
              e.stopPropagation();
              return;
            } else if (k === 'Escape') {
              setOpen(false);
              setText(fmtDate(valueRef.current), valueRef.current);
              e.preventDefault();
              e.stopPropagation();
              return;
            }
            if (next) {
              // move the calendar cursor; the date is committed by Enter, a click or leaving the field
              setText(fmtDate(next));
              setView(startOfMonth(next));
              e.preventDefault();
              e.stopPropagation();
              return;
            }
          }
          if (!e.ctrlKey && !e.metaKey && !e.altKey && k.length === 1) {
            const next = applyDateKey(k, current());
            if (next) {
              e.preventDefault();
              set(next);
              selectAll.current = true;
              e.currentTarget.select(); // in case nothing re-renders (same date)
              return;
            }
          }
          if (k === 'Enter') commit();
          onKeyDown?.(e);
        }}
      />
      {!inGrid || !readOnly ? (
        <button
          type="button"
          className="sx-datefield-btn"
          tabIndex={-1}
          disabled={!editable}
          aria-label="Open calendar"
          onMouseDown={(e) => {
            e.preventDefault();
            if (!editable) return;
            inputRef.current?.focus();
            if (open) setOpen(false);
            else openCalendar();
          }}
        >
          <CalendarDays size={14} strokeWidth={1.8} aria-hidden="true" />
        </button>
      ) : null}
      <Popup anchor={wrapRef.current} open={open} onClose={() => setOpen(false)} className="sx-popup-calendar">
        <Calendar
          value={text !== null ? current() : value || ''}
          view={view}
          onView={setView}
          onPick={(iso) => {
            set(iso);
            setOpen(false);
            inputRef.current?.focus();
          }}
        />
      </Popup>
    </div>
    {err.message}
    </>
  );
});

/** Props of {@link Calendar}. */
export interface CalendarProps {
  /** Selected ISO date ("" for none). */
  value: string;
  /** First day of the month shown. */
  view: string;
  onView(firstOfMonth: string): void;
  onPick(iso: string): void;
  /** Show the "Today" button in the footer (default true). */
  showToday?: boolean;
  /** Days that get a small dot (e.g. dates with transactions in the Calendar window). */
  marked?: (iso: string) => boolean;
  className?: string;
}

const DOW = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

/** Month calendar used by DateField (also usable on its own, e.g. the Calendar window). */
export function Calendar({ value, view, onView, onPick, showToday = true, marked, className }: CalendarProps) {
  const today = todayIso();
  const first = startOfMonth(view);
  const gridStart = addDays(first, -weekday(first));
  const days: string[] = [];
  for (let i = 0; i < 42; i++) days.push(addDays(gridStart, i));
  const month = +first.slice(5, 7);
  return (
    <div className={'sx-calendar' + (className ? ' ' + className : '')} role="dialog" aria-label="Calendar">
      <div className="sx-cal-head">
        <span className="sx-cal-title">
          {MONTH_NAMES[month - 1]} {first.slice(0, 4)}
        </span>
        <button type="button" className="sx-cal-nav" tabIndex={-1} aria-label="Previous month" title="Previous month (Page Up)" onClick={() => onView(addMonthsClamped(first, -1))}>
          <ChevronLeft size={16} aria-hidden="true" />
        </button>
        <button type="button" className="sx-cal-nav" tabIndex={-1} aria-label="Next month" title="Next month (Page Down)" onClick={() => onView(addMonthsClamped(first, 1))}>
          <ChevronRight size={16} aria-hidden="true" />
        </button>
      </div>
      <div className="sx-cal-grid" role="grid">
        {DOW.map((d) => (
          <div key={d} className="sx-cal-dow" role="columnheader">
            {d}
          </div>
        ))}
        {days.map((d) => {
          const other = +d.slice(5, 7) !== month;
          return (
            <div
              key={d}
              role="gridcell"
              aria-selected={d === value}
              aria-label={fmtDate(d)}
              className={'sx-cal-day' + (other ? ' sx-other' : '') + (d === value ? ' sx-sel' : '') + (d === today ? ' sx-today' : '') + (marked?.(d) ? ' sx-marked' : '')}
              onClick={() => onPick(d)}
            >
              {+d.slice(8, 10)}
            </div>
          );
        })}
      </div>
      {showToday && (
        <div className="sx-cal-foot">
          <button type="button" className="sx-cal-today" tabIndex={-1} onClick={() => onPick(today)} title="Pick today (T)">
            Today
          </button>
          <span className="sx-cal-hint">{fmtDate(today)}</span>
        </div>
      )}
    </div>
  );
}

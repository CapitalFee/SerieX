// Company > Calendar: a month grid showing the transactions entered on each day, invoices and bills
// due, and to dos. Click a day to list its items on the right; the right side also lists what is
// coming up in the next 7 days and what is past due. Items open with a click.
import { useMemo, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api, getCompanyId, qs } from '@/api/client';
import { useTxnList } from '@/api/hooks';
import type { TxnListResult, TxnSummary, TxnType } from '@/api/types';
import { Button, Select, Spinner } from '@/components';
import { openTxn, openWindow } from '@/windows/windowStore';
import { addDays, endOfMonth, endOfWeek, startOfMonth, startOfWeek, todayIso, addMonthsClamped, longDate } from '@/util/dates';
import { fmtDate, fmtMoney } from '@/util/format';
import { MONTHS, useTodos } from './shared';
import './company.css';

export interface CalendarWindowProps {}

type Show = 'all' | 'sales' | 'purchases' | 'banking' | 'other';

const SHOW_TYPES: Record<Exclude<Show, 'all'>, TxnType[]> = {
  sales: ['INV', 'SALESRCPT', 'PMT', 'CREDMEM', 'STMTCHG', 'EST', 'REFUND'],
  purchases: ['BILL', 'BILLCRED', 'BILLPMT', 'ITEMRCPT', 'PURCHORD', 'CCCHARGE', 'CCCREDIT', 'TAXPMT'],
  banking: ['DEP', 'CHK', 'TRANSFER'],
  other: ['GENJRNL', 'INVADJ'],
};

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

interface DueItem {
  key: string;
  date: string;
  label: string;
  amount: number;
  open: () => void;
  kind: 'invoice' | 'bill' | 'todo';
}

export default function CalendarWindow(_props: CalendarWindowProps) {
  const today = todayIso();
  const [month, setMonth] = useState(startOfMonth(today));
  const [day, setDay] = useState<string>(today);
  const [show, setShow] = useState<Show>('all');

  const gridStart = startOfWeek(month);
  const gridEnd = endOfWeek(endOfMonth(month));
  const days = useMemo(() => {
    const out: string[] = [];
    for (let d = gridStart; d <= gridEnd; d = addDays(d, 1)) out.push(d);
    return out;
  }, [gridStart, gridEnd]);

  const entered = useQuery({
    queryKey: ['txns', 'calendar', gridStart, gridEnd],
    queryFn: () => api.get<TxnListResult>('/txns' + qs({ from: gridStart, to: gridEnd, limit: 10000, sort: 'date' })),
    enabled: !!getCompanyId(),
  });
  const open = useTxnList({ types: ['INV', 'BILL'], openOnly: true, limit: 10000 });
  const todos = useTodos({ status: 'open' });

  const typeOk = (t: TxnType) => show === 'all' || SHOW_TYPES[show].includes(t);
  const enteredBy = useMemo(() => {
    const m = new Map<string, TxnSummary[]>();
    for (const r of entered.data?.rows ?? []) {
      if (!typeOk(r.type)) continue;
      const l = m.get(r.date) ?? [];
      l.push(r);
      m.set(r.date, l);
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entered.data, show]);

  const dueItems = useMemo<DueItem[]>(() => {
    const out: DueItem[] = [];
    if (show === 'all' || show === 'sales' || show === 'purchases') {
      for (const r of open.data?.rows ?? []) {
        if (r.voided || r.isPending) continue;
        if (r.type === 'INV' && show === 'purchases') continue;
        if (r.type === 'BILL' && show === 'sales') continue;
        const due = r.dueDate || r.date;
        out.push({
          key: 't' + r.id,
          date: due,
          label: `${r.type === 'INV' ? 'Invoice' : 'Bill'}${r.refNumber ? ' #' + r.refNumber : ''} · ${r.nameFull}`,
          amount: r.openBalance,
          open: () => openTxn(r.type, r.id),
          kind: r.type === 'INV' ? 'invoice' : 'bill',
        });
      }
    }
    if (show === 'all' || show === 'other') {
      for (const t of todos.data ?? []) {
        if (!t.dueDate) continue;
        out.push({ key: 'd' + t.id, date: t.dueDate, label: `To do: ${t.title}`, amount: 0, open: () => openWindow('todos'), kind: 'todo' });
      }
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
  }, [open.data, todos.data, show]);

  const dueBy = useMemo(() => {
    const m = new Map<string, DueItem[]>();
    for (const d of dueItems) {
      const l = m.get(d.date) ?? [];
      l.push(d);
      m.set(d.date, l);
    }
    return m;
  }, [dueItems]);

  const upcoming = dueItems.filter((d) => d.date >= today && d.date <= addDays(today, 7));
  const pastDue = dueItems.filter((d) => d.date < today).reverse();
  const dayEntered = enteredBy.get(day) ?? [];
  const dayDue = dueBy.get(day) ?? [];
  const loading = entered.isLoading || open.isLoading;

  const go = (n: number) => {
    const m = addMonthsClamped(month, n);
    setMonth(m);
    setDay(m <= today && today <= endOfMonth(m) ? today : m);
  };

  return (
    <div className="cx-cal">
      <div className="cx-cal-bar">
        <Button size="sm" icon={ChevronLeft} title="Previous month" aria-label="Previous month" onClick={() => go(-1)} />
        <h2 className="cx-cal-title">
          {MONTHS[+month.slice(5, 7) - 1]} {month.slice(0, 4)}
        </h2>
        <Button size="sm" icon={ChevronRight} title="Next month" aria-label="Next month" onClick={() => go(1)} />
        <Button
          size="sm"
          label="Today"
          onClick={() => {
            setMonth(startOfMonth(today));
            setDay(today);
          }}
        />
        {loading && <Spinner />}
        <span className="cx-spacer" />
        <div className="cx-cal-legend">
          <span>
            <i className="cx-k-entered" /> Entered
          </span>
          <span>
            <i className="cx-k-due" /> Due
          </span>
          <span>
            <i className="cx-k-late" /> Past due
          </span>
        </div>
        <span className="cx-muted">Show</span>
        <Select
          value={show}
          width={170}
          onChange={(v) => setShow(v as Show)}
          aria-label="Show"
          options={[
            { value: 'all', label: 'All transactions' },
            { value: 'sales', label: 'Sales & customers' },
            { value: 'purchases', label: 'Purchases & vendors' },
            { value: 'banking', label: 'Banking' },
            { value: 'other', label: 'Journal & to dos' },
          ]}
        />
      </div>
      <div className="cx-cal-main">
        <div
          className="cx-cal-grid"
          role="grid"
          tabIndex={0}
          aria-label="Month"
          onKeyDown={(e) => {
            const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowDown' ? 7 : e.key === 'ArrowUp' ? -7 : 0;
            if (!step) return;
            e.preventDefault();
            const n = addDays(day, step);
            setDay(n);
            if (n.slice(0, 7) !== month.slice(0, 7)) setMonth(startOfMonth(n));
          }}
        >
          {DOW.map((d) => (
            <div key={d} className="cx-cal-dow">
              {d}
            </div>
          ))}
          {days.map((d) => {
            const ent = enteredBy.get(d) ?? [];
            const due = dueBy.get(d) ?? [];
            const late = due.some((x) => x.kind !== 'todo') && d < today;
            const inMonth = d.slice(0, 7) === month.slice(0, 7);
            const total = ent.reduce((s, r) => s + (r.voided ? 0 : r.amount), 0);
            return (
              <button
                key={d}
                type="button"
                role="gridcell"
                aria-selected={d === day}
                className={'cx-cal-day' + (inMonth ? '' : ' cx-out') + (d === today ? ' cx-today' : '') + (d === day ? ' cx-sel' : '')}
                onClick={() => setDay(d)}
                onDoubleClick={() => ent.length === 1 && openTxn(ent[0].type, ent[0].id)}
                title={longDate(d)}
              >
                <span className="cx-cal-num">{+d.slice(8, 10)}</span>
                {ent.length > 0 && (
                  <span
                    className="cx-cal-chip cx-k-entered"
                    title={`${ent.length} transaction${ent.length === 1 ? '' : 's'} entered, total ${fmtMoney(total)}`}
                  >
                    {ent.length} entered
                  </span>
                )}
                {due.length > 0 && (
                  <span className={'cx-cal-chip ' + (late ? 'cx-k-late' : 'cx-k-due')} title={due.map((x) => x.label).join('\n')}>
                    {due.length} due
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <aside className="cx-cal-side">
          <section>
            <h3>
              <CalendarDays size={14} /> {longDate(day)}
            </h3>
            {dayEntered.length === 0 && dayDue.length === 0 ? (
              <div className="cx-muted cx-small">Nothing on this day.</div>
            ) : (
              <>
                {dayEntered.length > 0 && <div className="cx-cal-sub">Entered ({dayEntered.length})</div>}
                <ul className="cx-cal-items">
                  {dayEntered.map((r) => (
                    <li key={r.id}>
                      <button type="button" onClick={() => openTxn(r.type, r.id)} title="Open">
                        <span className="cx-ellipsis">
                          {r.typeLabel}
                          {r.refNumber ? ` #${r.refNumber}` : ''} {r.nameFull && <span className="cx-muted">· {r.nameFull}</span>}
                        </span>
                        <span className="cx-num">{r.voided ? 'Void' : fmtMoney(r.amount)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
                {dayDue.length > 0 && <div className="cx-cal-sub">Due ({dayDue.length})</div>}
                <DueList items={dayDue} />
              </>
            )}
          </section>
          <section>
            <h3>Upcoming: next 7 days</h3>
            {upcoming.length ? <DueList items={upcoming} withDate /> : <div className="cx-muted cx-small">Nothing due in the next 7 days.</div>}
          </section>
          <section>
            <h3 className={pastDue.length ? 'cx-tone-danger' : undefined}>Past due {pastDue.length ? `(${pastDue.length})` : ''}</h3>
            {pastDue.length ? <DueList items={pastDue.slice(0, 40)} withDate late /> : <div className="cx-muted cx-small">Nothing is past due.</div>}
          </section>
        </aside>
      </div>
    </div>
  );
}

function DueList({ items, withDate, late }: { items: DueItem[]; withDate?: boolean; late?: boolean }) {
  return (
    <ul className="cx-cal-items">
      {items.map((d) => (
        <li key={d.key}>
          <button type="button" onClick={d.open} title="Open">
            <span className="cx-ellipsis">
              {withDate && <span className={late ? 'cx-tone-danger' : 'cx-muted'}>{fmtDate(d.date).slice(0, 5)} </span>}
              {d.label}
            </span>
            {d.amount ? <span className="cx-num">{fmtMoney(d.amount)}</span> : null}
          </button>
        </li>
      ))}
    </ul>
  );
}

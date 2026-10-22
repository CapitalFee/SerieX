// Journal Entry (Company menu).
// DATE, ENTRY NO. and the lines grid ACCOUNT, DEBIT, CREDIT, MEMO, NAME, BILLABLE?, CLASS. When an
// account is chosen on a new line, its amount is filled with what is needed to balance the entry
// and the memo of the line above is copied. Totals and the difference
// stay visible in the footer. "Reverse" prepares the reversing entry dated the first day of the next
// month. The side panel lists recent journal entries (it starts open only when the window has room
// for it next to the lines grid, so the grid does not scroll sideways). A saved entry's window is titled
// "Journal Entry 1043 - 10/19/2026"; a new one keeps the plain form title.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Repeat2 } from 'lucide-react';
import { api } from '@/api/client';
import { useAccountsById, useNames, usePrefValues, useTxnList } from '@/api/hooks';
import { emptyLine, emptyTxn, type ID, type Name, type Txn, type TxnLine } from '@/api/types';
import {
  AccountLabel,
  AccountPicker,
  ClassPicker,
  DateField,
  Grid,
  ListEntryLabel,
  NameLabel,
  NamePicker,
  TextField,
  toast,
  type GridColumn,
} from '@/components';
import { HeaderRow, HeaderSpacer, HistoryPanelFrame, HistorySection, TxnFormFrame, TxnHeaderField, isEmptyLine, useTxnForm, type TxnProblem } from '@/forms';
import { addDate, startOfMonth, todayIso } from '@/util/dates';
import { escHtml, printHtml } from '@/util/print';
import { fmtDate, fmtMoney, round2 } from '@/util/format';
import { useSession } from '@/state/session';
import './company.css';

export interface JournalEntryFormProps {
  id?: number;
  /** Prefilled new entry (memorized transactions, copies). */
  template?: Txn;
}

const TYPE_HINT = 'A journal entry moves amounts between accounts directly. Each line is a debit or a credit; total debits must equal total credits.';
const NEW_TITLE = 'Journal Entry';
/** Width of the open history panel. */
const PANEL_WIDTH = 220;
/** MEMO width the lines grid keeps next to the open history panel (MEMO takes the grid's free width). */
const PANEL_MEMO_MIN = 160;

/** First day of the month after `iso`. */
function firstOfNextMonth(iso: string): string {
  return startOfMonth(addDate(startOfMonth(iso), 0, 1, 0));
}

function renumber(lines: TxnLine[]): TxnLine[] {
  return lines.map((l, i) => (l.seq === i + 1 && l.kind === 'je' ? l : { ...l, seq: i + 1, kind: 'je' }));
}

interface TotalsLayout {
  /** Left of the grid's table, from the left of the totals row (negative when the grid is scrolled). */
  shift: number;
  /** Width of the columns before DEBIT (ACCOUNT). */
  lead: number;
  debit: number;
  credit: number;
}

/**
 * Totals row under the lines grid. The amounts are placed from the grid's own DEBIT and CREDIT header
 * cells (the 2nd and 3rd columns), so they stay under their columns whatever the column widths are
 * (the user can resize them, and the widths are remembered) and when the grid scrolls sideways.
 */
function JeTotals({ debits, credits, diff }: { debits: number; credits: number; diff: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [lay, setLay] = useState<TotalsLayout | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const grid = el?.closest('.sx-grid');
    if (!el || !grid) return;
    const scroller = grid.querySelector<HTMLElement>('.sx-grid-scroll');
    const ths = Array.from(grid.querySelectorAll<HTMLElement>('thead th')).slice(0, 3);
    if (ths.length < 3) return;
    const measure = () => {
      const base = el.getBoundingClientRect().left;
      const [a, d, c] = ths.map((t) => t.getBoundingClientRect());
      const next: TotalsLayout = {
        shift: Math.round(a.left - base),
        lead: Math.round(d.left - a.left),
        debit: Math.round(d.width),
        credit: Math.round(c.width),
      };
      setLay((cur) =>
        cur && cur.shift === next.shift && cur.lead === next.lead && cur.debit === next.debit && cur.credit === next.credit ? cur : next,
      );
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const t of ths) ro.observe(t);
    scroller?.addEventListener('scroll', measure, { passive: true });
    return () => {
      ro.disconnect();
      scroller?.removeEventListener('scroll', measure);
    };
  }, []);
  return (
    <div ref={ref} className="cx-je-totals">
      <div
        className="cx-je-totals-row"
        style={
          lay
            ? {
                gridTemplateColumns: `${lay.lead}px ${lay.debit}px ${lay.credit}px minmax(0, 1fr)`,
                transform: lay.shift ? `translateX(${lay.shift}px)` : undefined,
                marginRight: lay.shift < 0 ? lay.shift : undefined,
              }
            : undefined
        }
      >
        <span className="cx-je-totlabel">Totals</span>
        <span className="cx-num">{fmtMoney(debits)}</span>
        <span className="cx-num">{fmtMoney(credits)}</span>
        <span className={diff === 0 ? 'cx-je-ok' : 'cx-je-bad'}>
          {diff === 0 ? (debits > 0 ? 'In balance' : '') : `Out of balance by ${fmtMoney(Math.abs(diff))}`}
        </span>
      </div>
    </div>
  );
}

export default function JournalEntryForm({ id, template }: JournalEntryFormProps) {
  const prefs = usePrefValues();
  const accounts = useAccountsById();
  const names = useNames(undefined, { active: 'all' });
  const namesById = useMemo(() => new Map<ID, Name>((names.data ?? []).map((n) => [n.id, n])), [names.data]);

  const form = useTxnForm({
    type: 'GENJRNL',
    id,
    required: [],
    makeNew: async () => {
      let ref = '';
      try {
        ref = (await api.get<{ refNumber: string }>('/next-ref?type=GENJRNL')).refNumber ?? '';
      } catch {
        /* numbering is optional */
      }
      if (template)
        return {
          ...emptyTxn('GENJRNL', todayIso()),
          ...template,
          id: 0,
          type: 'GENJRNL',
          refNumber: template.refNumber || ref,
          lines: renumber(template.lines ?? []),
        };
      return { ...emptyTxn('GENJRNL', todayIso()), refNumber: ref };
    },
    prepare: (t) => {
      const lines = renumber(t.lines.filter((l) => !isEmptyLine(l)));
      return { ...t, lines, amount: round2(lines.reduce((s, l) => s + (l.amount > 0 ? l.amount : 0), 0)) };
    },
    validate: (t) => {
      const problems: TxnProblem[] = [];
      const lines = t.lines;
      if (lines.length < 2) return { field: 'lines', message: 'A journal entry needs at least two lines: one debit and one credit.' };
      lines.forEach((l, i) => {
        if (!l.accountId && l.amount !== 0) problems.push({ field: 'lines', message: `Choose an account on line ${i + 1}.` });
        const a = l.accountId ? accounts.get(l.accountId) : undefined;
        const n = l.nameId ? namesById.get(l.nameId) : undefined;
        if (a?.type === 'Accounts Receivable' && n?.kind !== 'customer')
          problems.push({ field: 'lines', message: `Line ${i + 1} posts to ${a.name}: choose the customer in the NAME column.` });
        if (a?.type === 'Accounts Payable' && n?.kind !== 'vendor')
          problems.push({ field: 'lines', message: `Line ${i + 1} posts to ${a.name}: choose the vendor in the NAME column.` });
      });
      const diff = round2(lines.reduce((s, l) => s + l.amount, 0));
      if (diff !== 0)
        problems.push({
          field: 'lines',
          message: `Debits and credits must be equal. The entry is out of balance by ${fmtMoney(Math.abs(diff))} (${diff > 0 ? 'more debits' : 'more credits'}).`,
        });
      if (problems.length) return { field: 'lines', message: problems.map((p) => p.message).join(' ') };
      return null;
    },
  });

  const t = form.txn;
  // a saved entry is named after its number and date (the saved ones, not what is being typed)
  const saved = form.original;
  useEffect(() => {
    form.win?.setTitle(
      form.isNew || !saved ? NEW_TITLE : `Journal Entry${saved.refNumber ? ' ' + saved.refNumber : ''} - ${fmtDate(saved.date)}`,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.isNew, saved?.id, saved?.refNumber, saved?.date]);
  const linesRef = useRef(t.lines);
  linesRef.current = t.lines;
  const debits = round2(t.lines.reduce((s, l) => s + (l.amount > 0 ? l.amount : 0), 0));
  const credits = round2(t.lines.reduce((s, l) => s + (l.amount < 0 ? -l.amount : 0), 0));
  const diff = round2(debits - credits);

  const columns = useMemo<GridColumn<TxnLine>[]>(
    () => [
      {
        key: 'accountId',
        label: 'ACCOUNT',
        width: 190,
        editor: (p) => <AccountPicker inGrid autoFocus aria-label="Account" value={p.value as ID | null} onChange={(v) => p.onChange(v)} />,
        render: (r) => <AccountLabel id={r.accountId} />,
      },
      {
        key: 'debit',
        label: 'DEBIT',
        // fits 9,999,999.99, also in bold in the Totals row under it
        width: 112,
        align: 'right',
        editor: 'money',
        nullable: true,
        get: (r) => (r.amount > 0 ? r.amount : null),
        set: (r, v: number | null) => ({ ...r, amount: v ? round2(v) : r.amount > 0 ? 0 : r.amount }),
        render: (r) => (r.amount > 0 ? fmtMoney(r.amount) : ''),
      },
      {
        key: 'credit',
        label: 'CREDIT',
        width: 112,
        align: 'right',
        editor: 'money',
        nullable: true,
        get: (r) => (r.amount < 0 ? -r.amount : null),
        set: (r, v: number | null) => ({ ...r, amount: v ? -round2(v) : r.amount < 0 ? 0 : r.amount }),
        render: (r) => (r.amount < 0 ? fmtMoney(-r.amount) : ''),
      },
      { key: 'description', label: 'MEMO', width: 200, grow: true, editor: 'text' },
      {
        key: 'nameId',
        label: 'NAME',
        width: 150,
        editor: (p) => <NamePicker inGrid autoFocus aria-label="Name" value={p.value as ID | null} onChange={(v) => p.onChange(v)} />,
        render: (r) => <NameLabel id={r.nameId} />,
      },
      {
        key: 'billable',
        label: 'BILLABLE?',
        width: 80,
        editor: 'checkbox',
        readOnly: (r) => !r.nameId || namesById.get(r.nameId)?.kind !== 'customer',
        title: 'Billable to the customer on the line (add it to an invoice later)',
      },
      {
        key: 'classId',
        label: 'CLASS',
        width: 104,
        hidden: !prefs.useClassTracking,
        editor: (p) => <ClassPicker inGrid autoFocus aria-label="Class" value={p.value as ID | null} onChange={(v) => p.onChange(v)} />,
        render: (r) => <ListEntryLabel list="class" id={r.classId} />,
      },
    ],
    [prefs.useClassTracking, namesById],
  );

  // The history panel starts open only when this window has room for it: with the panel open, the
  // lines grid must still show its columns at their normal widths (MEMO at least PANEL_MEMO_MIN), so
  // it does not scroll sideways. The room is measured once, before the first paint, from the grid's
  // own width (the window's width, not the screen's: a floating window is narrower than the screen),
  // so the panel is left out of that first render. Once the user opens or closes the panel, that
  // choice is remembered and wins.
  const [panelRoom, setPanelRoom] = useState<boolean | null>(null);
  const gridNeed = columns.reduce((s, c) => s + (c.hidden ? 0 : c.grow ? PANEL_MEMO_MIN : (c.width ?? 100)), 0);
  useLayoutEffect(() => {
    if (panelRoom !== null) return;
    const area = form.rootRef.current?.querySelector<HTMLElement>('.sx-grid-scroll');
    const w = area?.clientWidth ?? 0;
    setPanelRoom(w > 0 && w - PANEL_WIDTH >= gridNeed);
  });

  const onRowChange = (next: TxnLine, prev: TxnLine, key: string, index: number): TxnLine => {
    let r: TxnLine = next.kind === 'je' ? next : { ...next, kind: 'je' };
    if (key === 'accountId' && !prev.accountId && r.accountId && r.amount === 0) {
      // fill the amount that balances the entry, and repeat the memo of the line above
      const others = linesRef.current.filter((_, i) => i !== index);
      const bal = round2(-others.reduce((s, l) => s + l.amount, 0));
      if (bal !== 0) r = { ...r, amount: bal };
      if (!r.description) {
        const above = linesRef.current[index - 1] ?? linesRef.current[linesRef.current.length - 1];
        if (above && index > 0 && above.description) r = { ...r, description: above.description };
      }
    }
    if (key === 'nameId' && (!r.nameId || namesById.get(r.nameId)?.kind !== 'customer') && r.billable) r = { ...r, billable: false };
    return r;
  };

  const reverse = async () => {
    const orig = form.txn;
    if (!orig.id) return;
    await form.copy();
    let applied = false;
    form.setTxn((cur) => {
      if (cur.id !== 0) return cur; // the copy was cancelled
      applied = true;
      return {
        ...cur,
        date: firstOfNextMonth(orig.date),
        refNumber: orig.refNumber ? `${orig.refNumber}R` : '',
        memo: orig.memo,
        lines: cur.lines.map((l) => ({ ...l, amount: -l.amount })),
      };
    });
    if (applied) toast(`Reversing entry dated ${fmtDate(firstOfNextMonth(orig.date))} is ready. Check it and save.`, { kind: 'info' });
  };

  const print = () => {
    const company = useSession.getState().company?.name ?? '';
    const name = (id: ID | null) => (id ? (namesById.get(id)?.fullName ?? '') : '');
    const acct = (id: ID | null) => (id ? (accounts.get(id)?.fullName ?? '') : '');
    const rows = t.lines
      .filter((l) => l.accountId || l.amount)
      .map(
        (l) =>
          `<tr><td>${escHtml(acct(l.accountId))}</td><td class="num">${l.amount > 0 ? fmtMoney(l.amount) : ''}</td><td class="num">${l.amount < 0 ? fmtMoney(-l.amount) : ''}</td><td>${escHtml(l.description)}</td><td>${escHtml(name(l.nameId))}</td></tr>`,
      )
      .join('');
    void printHtml(
      'General Journal Entry',
      `<div class="muted">${escHtml(company)}</div><h1>General Journal Entry</h1>
       <p>Date: <b>${fmtDate(t.date)}</b> &nbsp;&nbsp; Entry No.: <b>${escHtml(t.refNumber || '')}</b></p>
       <table><thead><tr><th>Account</th><th class="num">Debit</th><th class="num">Credit</th><th>Memo</th><th>Name</th></tr></thead>
       <tbody>${rows}<tr class="bold"><td>Totals</td><td class="num">${fmtMoney(debits)}</td><td class="num">${fmtMoney(credits)}</td><td></td><td></td></tr></tbody></table>`,
    );
  };

  const recent = useTxnList({ types: ['GENJRNL'], sort: '-date', limit: 25 });

  return (
    <TxnFormFrame
      form={form}
      title="Journal Entry"
      onPrint={print}
      extraButtons={[
        {
          key: 'reverse',
          label: 'Reverse',
          icon: Repeat2,
          onClick: () => void reverse(),
          disabled: form.isNew,
          title: 'Create the reversing entry, dated the first day of the next month',
        },
      ]}
      header={
        <HeaderRow>
          <TxnHeaderField label="DATE" width={150} required>
            <DateField name="date" value={t.date} onChange={(v) => form.update({ date: v })} autoFocus={!id} />
          </TxnHeaderField>
          <TxnHeaderField label="ENTRY NO." width={120}>
            <TextField
              name="refNumber"
              value={t.refNumber}
              onChange={(v) => form.update({ refNumber: v })}
              placeholder={prefs.autoAssignJournalNumbers ? 'Automatic' : ''}
            />
          </TxnHeaderField>
          <HeaderSpacer />
          <div className="cx-je-hint cx-muted cx-small">{TYPE_HINT}</div>
        </HeaderRow>
      }
      lines={
        <Grid<TxnLine>
          aria-label="Journal entry lines"
          columns={columns}
          rows={t.lines}
          onChange={(rows) => form.setLines(renumber(rows))}
          newRow={() => emptyLine('je')}
          onRowChange={onRowChange}
          readOnly={t.voided}
          minRows={8}
          persistKey="genjrnl"
          footer={<JeTotals debits={debits} credits={credits} diff={diff} />}
        />
      }
      totals={[
        { key: 'd', label: 'Total debits', value: debits },
        { key: 'c', label: 'Total credits', value: credits },
        { key: 'x', label: 'Difference', value: diff, strong: true, tone: diff === 0 ? (debits > 0 ? 'success' : undefined) : 'danger' },
      ]}
      sidePanel={
        panelRoom !== null && (
          <HistoryPanelFrame persistKey="genjrnl" title="Recent journal entries" width={PANEL_WIDTH} defaultOpen={panelRoom}>
            <HistorySection title="LATEST FIRST">
              {(recent.data?.rows ?? []).length === 0 ? (
                <div className="cx-muted cx-small">No journal entries yet.</div>
              ) : (
                <ul className="cx-jelist">
                  {(recent.data?.rows ?? []).map((r) => (
                    <li key={r.id}>
                      <button
                        type="button"
                        className={'cx-jeitem' + (r.id === t.id ? ' cx-on' : '')}
                        onClick={() => void form.load(r.id)}
                        title={r.memo || undefined}
                      >
                        <span className="cx-jeitem-top">
                          <span>{fmtDate(r.date)}</span>
                          <span className="cx-num">{r.voided ? 'Void' : fmtMoney(r.amount)}</span>
                        </span>
                        <span className="cx-jememo cx-ellipsis">
                          {r.refNumber ? `#${r.refNumber}` : 'No number'}
                          {r.memo ? ` · ${r.memo}` : ''}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </HistorySection>
          </HistoryPanelFrame>
        )
      }
    />
  );
}

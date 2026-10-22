// Earlier Tax Payments: tax and deduction payments made this year before using SerieX Payroll
// (kind "prior"). They lower the amounts owed and count as deposits on Forms 941/940, but are
// never posted to SerieX Books (they are already in the books). The list shows these payments;
// the panel below adds or edits one (Payment Date, For Period Ending, Payee, taxes and
// deductions grid ITEM / AMOUNT / MEMO) with Save and Add Another and Done.
import { useEffect, useMemo, useRef, useState } from 'react';
import { History, Plus, Save, Trash2 } from 'lucide-react';
import { ApiError, api } from '@/api/client';
import { invalidateAll, useLiabilityPayments } from '@/api/hooks';
import type { Id, LiabilityPayment } from '@/api/types';
import {
  Button,
  DateField,
  EmptyState,
  ErrorBanner,
  Field,
  FormErrorsProvider,
  Grid,
  ListView,
  PayrollItemLabel,
  PayrollItemPicker,
  TextField,
  VendorPicker,
  alertBox,
  commitActiveEditor,
  confirmBox,
  msgBox,
  toast,
  useFormErrors,
  type GridColumn,
  type ListColumn,
} from '@/components';
import { useWindow } from '@/windows/WindowContext';
import { openWindow } from '@/windows/windowStore';
import { todayIso } from '@/util/dates';
import { fmtMoney, round2 } from '@/util/format';
import { forgetRecent, recordRecent } from '@/util/recent';
import { LIABILITY_TYPES, errText, isCancelled, previousMonth, sum2 } from './shared';

export interface PriorPaymentsWindowProps {}

interface Row {
  itemId: Id | null;
  amount: number;
  memo: string;
}
interface Entry {
  id: number;
  date: string;
  periodEnd: string;
  agencyVendorId: Id | null;
  agencyName: string;
  memo: string;
  rows: Row[];
}

const emptyRow = (): Row => ({ itemId: null, amount: 0, memo: '' });

function blankEntry(today: string): Entry {
  return { id: 0, date: today, periodEnd: previousMonth(today).end, agencyVendorId: null, agencyName: '', memo: '', rows: [] };
}
function toEntry(p: LiabilityPayment): Entry {
  return {
    id: p.id,
    date: p.date,
    periodEnd: p.periodEnd,
    agencyVendorId: p.agencyVendorId,
    agencyName: p.agencyName,
    memo: p.memo,
    rows: p.lines.filter((l) => l.kind === 'item').map((l) => ({ itemId: l.itemId, amount: l.amount, memo: l.memo })),
  };
}
const snap = (e: Entry) =>
  JSON.stringify([e.date, e.periodEnd, e.agencyVendorId, e.memo, e.rows.filter((r) => r.itemId || r.amount || r.memo).map((r) => [r.itemId, round2(r.amount), r.memo])]);

export default function PriorPaymentsWindow(_props: PriorPaymentsWindowProps) {
  const win = useWindow();
  const today = todayIso();
  const fe = useFormErrors();
  const list = useLiabilityPayments({ kind: 'prior' });
  const [entry, setEntry] = useState<Entry>(() => blankEntry(today));
  const [base, setBase] = useState(() => snap(blankEntry(today)));
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const dirty = snap(entry) !== base;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const total = sum2(entry.rows.map((r) => r.amount));

  useEffect(() => {
    win.setTitle('Earlier Tax Payments');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    win.setDirty(dirty);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty]);

  const payments = useMemo(() => (Array.isArray(list.data) ? list.data : []), [list.data]);

  const load = (e: Entry) => {
    setEntry(e);
    setBase(snap(e));
    fe.clearAll();
  };

  const save = async (): Promise<boolean> => {
    await commitActiveEditor(rootRef.current);
    fe.clearAll();
    const e = entryRef.current;
    if (!e.date) return fe.setErrors({ date: 'Enter the payment date.' }), false;
    if (!e.periodEnd) return fe.setErrors({ periodEnd: 'Enter the end of the period the payment was for.' }), false;
    const used = e.rows.filter((r) => r.itemId || r.amount);
    if (used.some((r) => !r.itemId)) return fe.setErrors({ lines: 'Choose the payroll item of every line.' }), false;
    if (sum2(used.map((r) => r.amount)) <= 0) return fe.setErrors({ lines: 'Enter the amount paid for each payroll item.' }), false;
    const body = {
      id: e.id,
      kind: 'prior',
      date: e.date,
      periodStart: e.periodEnd.slice(0, 8) + '01',
      periodEnd: e.periodEnd,
      agencyVendorId: e.agencyVendorId,
      bankAccountId: null,
      checkNumber: '',
      toBePrinted: false,
      method: 'check',
      memo: e.memo,
      lines: used.map((r) => ({ kind: 'item', itemId: r.itemId, accountId: null, amount: round2(r.amount), memo: r.memo })),
    };
    setBusy(true);
    try {
      const saved = e.id ? await api.put<LiabilityPayment>(`/liability-payments/${e.id}`, body) : await api.post<LiabilityPayment>('/liability-payments', body);
      recordRecent({ kind: 'liability_payment', id: saved.id, number: '', name: saved.agencyName || 'Earlier tax payment', amount: saved.amount, date: saved.date });
      await invalidateAll();
      toast(`Earlier tax payment of ${fmtMoney(saved.amount)} saved`);
      setBase(snap(e));
      return true;
    } catch (err) {
      if (!isCancelled(err)) {
        const f = err instanceof ApiError ? err.field : undefined;
        if (f) fe.setErrors({ [f.startsWith('lines') ? 'lines' : f]: errText(err) });
        else fe.setErrors({}, errText(err));
      }
      return false;
    } finally {
      setBusy(false);
    }
  };
  const entryRef = useRef(entry);
  entryRef.current = entry;

  const askSave = async (): Promise<boolean> => {
    if (!dirtyRef.current) return true;
    const r = await msgBox({
      title: 'Unsaved Changes',
      message: 'This earlier tax payment has changes that are not saved. Save them before you leave?',
      buttons: ['&Save', "&Don't Save", 'Cancel'],
      icon: 'question',
    });
    if (r === 'Save') return save();
    return r === "Don't Save";
  };
  useEffect(() => {
    win.setBeforeClose(askSave);
    return () => win.setBeforeClose(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const nextPayment = async () => {
    if (await save()) load(blankEntry(today));
  };
  const newPayment = async () => {
    if (await askSave()) load(blankEntry(today));
  };
  const select = async (p: LiabilityPayment) => {
    if (p.id === entry.id) return;
    if (await askSave()) load(toEntry(p));
  };
  const del = async () => {
    if (!entry.id) return load(blankEntry(today));
    if (!(await confirmBox('Delete this earlier tax payment? The taxes it paid are owed again.', 'Delete Earlier Tax Payment'))) return;
    try {
      await api.del(`/liability-payments/${entry.id}`);
      forgetRecent('liability_payment', entry.id);
      await invalidateAll();
      toast('Earlier tax payment deleted');
      load(blankEntry(today));
    } catch (e) {
      if (!isCancelled(e)) await alertBox(errText(e), 'Delete', 'error');
    }
  };

  const listCols: ListColumn<LiabilityPayment>[] = [
    { key: 'date', label: 'PAYMENT DATE', width: 110, type: 'date' },
    { key: 'periodEnd', label: 'FOR PERIOD ENDING', width: 150, type: 'date' },
    { key: 'agencyName', label: 'PAYEE', width: 200 },
    { key: 'items', label: 'TAXES AND DEDUCTIONS', width: 260, grow: true, render: (p) => p.lines.filter((l) => l.kind === 'item').map((l) => l.itemName).join(', '), sortable: false },
    { key: 'memo', label: 'MEMO', width: 140 },
    { key: 'amount', label: 'AMOUNT', width: 110, type: 'money' },
  ];
  const gridCols = useMemo<GridColumn<Row>[]>(
    () => [
      {
        key: 'itemId',
        label: 'ITEM',
        width: 250,
        editor: (p) => <PayrollItemPicker inGrid autoFocus aria-label="Payroll item" types={LIABILITY_TYPES} value={p.value as Id | null} onChange={(id) => p.onChange(id)} />,
        render: (r) => <PayrollItemLabel id={r.itemId} />,
      },
      { key: 'amount', label: 'AMOUNT', width: 120, editor: 'money', align: 'right', blankZero: true },
      { key: 'memo', label: 'MEMO', width: 220, grow: true, editor: 'text' },
    ],
    [],
  );

  return (
    <FormErrorsProvider value={fe}>
      <div className="lx-page" ref={rootRef}>
        <div className="lx-note">
          <History size={15} aria-hidden="true" />
          <span>
            List the payroll tax and deduction payments you made this year before you started using SerieX Payroll. They lower the amounts owed and count as deposits on Forms 941
            and 940, but they are not posted to SerieX Books (they are already in your books).
          </span>
        </div>
        <div className="lx-prior">
          <div className="lx-grid">
            {list.isLoading ? null : payments.length ? (
              <ListView<LiabilityPayment>
                aria-label="Earlier tax payments"
                columns={listCols}
                rows={payments}
                selectedKey={entry.id || null}
                onSelect={(_k, p) => void select(p)}
                onActivate={(p) => openWindow('liabilityPayment', { id: p.id })}
                isInactive={(p) => p.voided}
                persistKey="priorpayments"
                contextMenu={(p) => (p ? [{ label: 'Open in the payment form', onClick: () => openWindow('liabilityPayment', { id: p.id }) }] : [])}
              />
            ) : (
              <EmptyState icon={History} compact title="No earlier tax payments" message="Payments you enter below are listed here." />
            )}
          </div>
          <section className="lx-panel">
            <div className="lx-panel-head">
              {entry.id ? 'Edit payment' : 'New payment'}
              <span className="lx-spacer" />
              <span className="lx-muted">Total {fmtMoney(total)}</span>
            </div>
            <div className="lx-panel-body lx-prior-form">
              {(fe.message || Object.keys(fe.errors).length > 0) && <ErrorBanner errors={fe.errors} message={fe.message} onDismiss={() => fe.clearAll()} root={rootRef.current} />}
              <div className="lx-prior-head">
                <Field label="Payment date" htmlFor="lx-pp-date" width={140}>
                  <DateField id="lx-pp-date" name="date" value={entry.date} required onChange={(v) => setEntry((e) => ({ ...e, date: v }))} />
                </Field>
                <Field label="For period ending" htmlFor="lx-pp-end" width={150} help="The end of the month or quarter the payment was for (it decides the Form 941/940 quarter it counts in).">
                  <DateField id="lx-pp-end" name="periodEnd" value={entry.periodEnd} required onChange={(v) => setEntry((e) => ({ ...e, periodEnd: v }))} />
                </Field>
                <Field label="Payee" htmlFor="lx-pp-payee" width={260}>
                  <VendorPicker
                    id="lx-pp-payee"
                    name="agencyVendorId"
                    placeholder="Agency (optional)"
                    value={entry.agencyVendorId}
                    fallbackLabel={entry.agencyName}
                    onChange={(id, v) => setEntry((e) => ({ ...e, agencyVendorId: id, agencyName: v?.fullName ?? v?.name ?? '' }))}
                  />
                </Field>
                <Field label="Memo" htmlFor="lx-pp-memo" width={240}>
                  <TextField id="lx-pp-memo" name="memo" value={entry.memo} onChange={(v) => setEntry((e) => ({ ...e, memo: v }))} />
                </Field>
              </div>
              <div data-field="lines">
                <Grid<Row>
                  aria-label="Taxes and deductions paid"
                  columns={gridCols}
                  rows={entry.rows}
                  onChange={(rows) => {
                    fe.clear('lines');
                    setEntry((e) => ({ ...e, rows }));
                  }}
                  newRow={emptyRow}
                  minRows={5}
                  persistKey="priorpayment-lines"
                />
              </div>
            </div>
          </section>
        </div>
        <div className="lx-actions">
          <Button icon={Plus} label="&New Payment" onClick={() => void newPayment()} />
          <Button icon={Trash2} label="&Delete" disabled={!entry.id && !dirty} onClick={() => void del()} />
          <span className="lx-spacer" />
          <Button icon={Save} label="Save and &Add Another" busy={busy} disabled={!dirty} onClick={() => void nextPayment()} />
          <Button
            variant="primary"
            label="D&one"
            onClick={() =>
              void (async () => {
                if (dirtyRef.current && !(await save())) return;
                await win.close(true);
              })()
            }
          />
        </div>
      </div>
    </FormErrorsProvider>
  );
}

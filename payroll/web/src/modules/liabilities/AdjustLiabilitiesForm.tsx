// Adjust Tax Balances: Date, Effective Date (the period whose amounts owed and tax forms
// change), Adjustment is for Company / Employee, Class, and the taxes and deductions grid
// ITEM NAME / AMOUNT / INCOME SUBJECT TO TAX / MEMO. Positive amounts increase what is owed,
// negative ones decrease it. "Books Accounts..." chooses whether SerieX Books gets a journal
// entry (liability and expense accounts) or only the amounts owed in payroll change.
// Prev / Next walk through the saved adjustments.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpenCheck, Scale } from 'lucide-react';
import { ApiError, api } from '@/api/client';
import { invalidateAll, useLiabilityAdjustments, usePrefValues } from '@/api/hooks';
import type { Id, LiabilityAdjustment } from '@/api/types';
import {
  Button,
  ClassPicker,
  DateField,
  EmployeePicker,
  Grid,
  PayrollItemLabel,
  PayrollItemPicker,
  RadioGroup,
  TextField,
  alertBox,
  commitActiveEditor,
  confirmBox,
  msgBox,
  showDialog,
  toast,
  type FieldErrors,
  type GridColumn,
} from '@/components';
import { FormFrame, HeaderRow, TxnHeaderField, type FooterTotal } from '@/forms';
import { useWindow } from '@/windows/WindowContext';
import { openWindow } from '@/windows/windowStore';
import { todayIso } from '@/util/dates';
import { fmtDate, fmtMoney, round2 } from '@/util/format';
import { forgetRecent, recordRecent } from '@/util/recent';
import { BooksStatusLine, LIABILITY_TYPES, booksErr, errText, isCancelled, sum2 } from './shared';

export interface AdjustLiabilitiesFormProps {
  /** Saved adjustment (new when missing). */
  id?: number;
  /** Prefill of a new adjustment (e.g. the Form 940 credit reduction). */
  itemId?: number;
  amount?: number;
  effectiveDate?: string;
  employeeId?: number;
  memo?: string;
}

interface AdjRow {
  itemId: Id | null;
  amount: number;
  wageBase: number;
  memo: string;
}

interface Draft {
  rec: LiabilityAdjustment;
  lines: AdjRow[];
}

const emptyRow = (): AdjRow => ({ itemId: null, amount: 0, wageBase: 0, memo: '' });

function blank(today: string): LiabilityAdjustment {
  return {
    id: 0,
    date: today,
    effectiveDate: today,
    employeeId: null,
    memo: '',
    affectsAccounts: true,
    classId: null,
    lines: [],
    employeeName: '',
    booksTxnId: null,
    syncStatus: 'none',
    syncError: '',
    createdBy: '',
    createdAt: '',
  };
}

const toDraft = (a: LiabilityAdjustment): Draft => ({ rec: a, lines: a.lines.map((l) => ({ itemId: l.itemId, amount: l.amount, wageBase: l.wageBase, memo: l.memo })) });

function snapshot(d: Draft): string {
  const r = d.rec;
  return JSON.stringify([
    r.date,
    r.effectiveDate,
    r.employeeId,
    r.memo,
    r.affectsAccounts,
    r.classId,
    d.lines.filter((l) => l.itemId || l.amount || l.wageBase || l.memo).map((l) => [l.itemId, round2(l.amount), round2(l.wageBase), l.memo]),
  ]);
}

export default function AdjustLiabilitiesForm(props: AdjustLiabilitiesFormProps) {
  const win = useWindow();
  const prefs = usePrefValues();
  const today = todayIso();
  const { data: allAdj } = useLiabilityAdjustments();
  const [curId, setCurId] = useState<number>(props.id ?? 0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [base, setBase] = useState('');
  const [mode, setMode] = useState<'company' | 'employee'>('company');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const skipLoad = useRef(false);

  const rec = draft?.rec ?? null;
  const isNew = !curId;
  const dirty = !!draft && snapshot(draft) !== base;
  const total = sum2((draft?.lines ?? []).map((l) => l.amount));
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const loadNew = useCallback(
    (prefill: AdjustLiabilitiesFormProps = {}) => {
      const a = blank(today);
      if (prefill.effectiveDate) {
        a.effectiveDate = prefill.effectiveDate;
        a.date = prefill.effectiveDate;
      }
      a.employeeId = prefill.employeeId ?? null;
      a.memo = prefill.memo ?? '';
      const d: Draft = { rec: a, lines: [] };
      setBase(snapshot(d));
      if (prefill.itemId) d.lines = [{ itemId: prefill.itemId, amount: prefill.amount ?? 0, wageBase: 0, memo: '' }];
      setDraft(d);
      setMode(a.employeeId ? 'employee' : 'company');
      setFieldErrors({});
      setFormError(null);
    },
    [today],
  );
  const loadSaved = useCallback(async (id: number) => {
    const a = await api.get<LiabilityAdjustment>(`/liability-adjustments/${id}`);
    const d = toDraft(a);
    setDraft(d);
    setBase(snapshot(d));
    setMode(a.employeeId ? 'employee' : 'company');
    setFieldErrors({});
    setFormError(null);
    recordRecent({ kind: 'adjustment', id: a.id, number: '', name: a.employeeName || 'Company', amount: sum2(a.lines.map((l) => l.amount)), date: a.date });
  }, []);

  useEffect(() => {
    if (skipLoad.current) {
      skipLoad.current = false;
      return;
    }
    let alive = true;
    setLoading(true);
    (curId ? loadSaved(curId) : Promise.resolve(loadNew(props)))
      .catch(async (e) => {
        if (alive) await alertBox(errText(e), 'Tax Balance Adjustment', 'error');
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curId]);

  useEffect(() => {
    win.setTitle(isNew ? 'Adjust Tax Balances' : `Tax Balance Adjustment - ${rec?.employeeName || 'Company'} ${fmtDate(rec?.date)}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNew, rec?.employeeName, rec?.date]);
  useEffect(() => {
    win.setDirty(dirty);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty]);

  const update = (patch: Partial<LiabilityAdjustment>) => setDraft((d) => (d ? { ...d, rec: { ...d.rec, ...patch } } : d));
  const clearError = (f: string) =>
    setFieldErrors((e) => {
      if (!(f in e)) return e;
      const n = { ...e };
      delete n[f];
      return n;
    });

  const setFor = (m: 'company' | 'employee') => {
    setMode(m);
    if (m === 'company') setDraft((d) => (d ? { rec: { ...d.rec, employeeId: null, employeeName: '' }, lines: d.lines.map((l) => ({ ...l, wageBase: 0 })) } : d));
  };

  const save = async (): Promise<LiabilityAdjustment | null> => {
    await commitActiveEditor(rootRef.current);
    const d = draftRef.current;
    if (!d) return null;
    const e: FieldErrors = {};
    if (!d.rec.date) e.date = 'Enter the date of the adjustment.';
    if (!d.rec.effectiveDate) e.effectiveDate = 'Enter the effective date (the period the adjustment belongs to).';
    if (mode === 'employee' && !d.rec.employeeId) e.employeeId = 'Choose the employee, or choose Company.';
    const used = d.lines.filter((l) => l.itemId || l.amount || l.wageBase);
    if (used.some((l) => !l.itemId)) e.lines = 'Choose the payroll item of every line.';
    else if (!used.length) e.lines = 'Enter at least one payroll item with the amount to adjust.';
    setFieldErrors(e);
    setFormError(null);
    if (Object.keys(e).length) return null;
    const body: LiabilityAdjustment = {
      ...d.rec,
      employeeId: mode === 'employee' ? d.rec.employeeId : null,
      lines: used.map((l) => ({ itemId: l.itemId!, amount: round2(l.amount), wageBase: mode === 'employee' ? round2(l.wageBase) : 0, memo: l.memo, itemName: '' })),
    };
    setSaving(true);
    try {
      const saved = curId ? await api.put<LiabilityAdjustment>(`/liability-adjustments/${curId}`, body) : await api.post<LiabilityAdjustment>('/liability-adjustments', body);
      const nd = toDraft(saved);
      setDraft(nd);
      setBase(snapshot(nd));
      if (!curId) {
        win.setKeyProps({ id: saved.id });
        skipLoad.current = true;
        setCurId(saved.id);
      }
      recordRecent({ kind: 'adjustment', id: saved.id, number: '', name: saved.employeeName || 'Company', amount: sum2(saved.lines.map((l) => l.amount)), date: saved.date });
      void invalidateAll();
      toast('Tax balance adjustment saved');
      if (saved.syncStatus === 'error')
        await alertBox(`The adjustment was saved in SerieX Payroll, but its journal entry is not in SerieX Books yet:\n${booksErr(saved.syncError)}\n\nUse Retry under the form after fixing the problem.`, 'SerieX Books', 'warning');
      return saved;
    } catch (err) {
      if (isCancelled(err)) return null;
      const f = err instanceof ApiError ? err.field : undefined;
      if (f) setFieldErrors({ [f.startsWith('lines') ? 'lines' : f]: errText(err) });
      else setFormError(errText(err));
      return null;
    } finally {
      setSaving(false);
    }
  };

  const askSave = async (): Promise<boolean> => {
    if (!dirtyRef.current) return true;
    const r = await msgBox({
      title: 'Unsaved Changes',
      message: 'This adjustment has changes that are not saved. Save them before you leave?',
      buttons: ['&Save', "&Don't Save", 'Cancel'],
      icon: 'question',
    });
    if (r === 'Save') return !!(await save());
    return r === "Don't Save";
  };
  useEffect(() => {
    win.setBeforeClose(askSave);
    return () => win.setBeforeClose(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const goTo = async (id: number) => {
    if (!(await askSave())) return;
    win.setKeyProps(id ? { id } : { id: undefined, new: Date.now() });
    if (id === curId) {
      if (!id) loadNew();
      return;
    }
    setCurId(id);
  };

  // previous / next adjustment (by date, then id)
  const ordered = useMemo(() => [...(allAdj ?? [])].sort((a, b) => (a.date === b.date ? a.id - b.id : a.date < b.date ? -1 : 1)), [allAdj]);
  const pos = ordered.findIndex((a) => a.id === curId);
  const prevId = isNew ? ordered[ordered.length - 1]?.id : pos > 0 ? ordered[pos - 1].id : undefined;
  const nextId = !isNew && pos >= 0 && pos < ordered.length - 1 ? ordered[pos + 1].id : undefined;

  const accountsAffected = async () => {
    if (!rec) return;
    const v = await showDialog<boolean | null>({
      title: 'Change Account Balances?',
      width: 460,
      cancelValue: null,
      render: (close) => <AffectBody initial={rec.affectsAccounts} close={close} />,
    });
    if (v !== null && v !== rec.affectsAccounts) update({ affectsAccounts: v });
  };

  /** Reads the posting status again after a SerieX Books retry (keeps the user's unsaved edits). */
  const refreshSync = async () => {
    if (!curId) return;
    const a = await api.get<LiabilityAdjustment>(`/liability-adjustments/${curId}`, { noPrompt: true });
    if (!dirtyRef.current) {
      const d = toDraft(a);
      setDraft(d);
      setBase(snapshot(d));
      return;
    }
    update({ syncStatus: a.syncStatus, syncError: a.syncError, booksTxnId: a.booksTxnId });
  };

  const del = async () => {
    if (!rec) return;
    if (!curId) return loadNew();
    if (!(await confirmBox(`Delete this tax balance adjustment?${rec.booksTxnId ? ' Its journal entry is also deleted from SerieX Books.' : ''}`, 'Delete Adjustment'))) return;
    try {
      await api.del(`/liability-adjustments/${curId}`);
      forgetRecent('adjustment', curId);
      void invalidateAll();
      toast('Tax balance adjustment deleted');
      await win.close(true);
    } catch (e) {
      if (!isCancelled(e)) await alertBox(errText(e), 'Delete', 'error');
    }
  };

  const columns = useMemo<GridColumn<AdjRow>[]>(
    () => [
      {
        key: 'itemId',
        label: 'ITEM NAME',
        width: 250,
        editor: (p) => <PayrollItemPicker inGrid autoFocus aria-label="Payroll item" types={LIABILITY_TYPES} value={p.value as Id | null} onChange={(id) => p.onChange(id)} />,
        render: (r) => <PayrollItemLabel id={r.itemId} />,
      },
      { key: 'amount', label: 'AMOUNT', width: 120, editor: 'money', align: 'right', blankZero: true },
      {
        key: 'wageBase',
        label: 'INCOME SUBJECT TO TAX',
        width: 170,
        editor: 'money',
        align: 'right',
        blankZero: true,
        readOnly: () => mode !== 'employee',
        title: 'Wage base change of a tax item (employee adjustments only; changes the W-2 and tax form wages)',
      },
      { key: 'memo', label: 'MEMO', width: 220, grow: true, editor: 'text' },
    ],
    [mode],
  );

  if (!rec || !draft) return <FormFrame title="Tax Balance Adjustment" loading />;

  const totals: FooterTotal[] = [
    ...(mode === 'employee' ? [{ key: 'wb', label: 'Income subject to tax', value: sum2(draft.lines.map((l) => l.wageBase)) }] : []),
    { key: 'total', label: 'Total adjustment', value: total, strong: true, tone: total < 0 ? ('danger' as const) : undefined },
  ];

  return (
    <FormFrame
      rootRef={rootRef}
      title="Tax Balance Adjustment"
      status={!rec.affectsAccounts ? 'Does not affect accounts' : null}
      isNew={isNew}
      dirty={dirty}
      busy={saving || loading}
      saving={saving}
      loading={loading}
      fieldErrors={fieldErrors}
      formError={formError}
      onClearError={clearError}
      onClearErrors={() => {
        setFieldErrors({});
        setFormError(null);
      }}
      onPrev={prevId ? () => void goTo(prevId) : undefined}
      onNext={nextId || !isNew ? () => void goTo(nextId ?? 0) : undefined}
      onNew={() => void goTo(0)}
      onSave={() => void save()}
      onSaveClose={() => void (async () => (await save()) && (await win.close(true)))()}
      onSaveNew={() => void (async () => (await save()) && goTo(0))()}
      onRevert={() => curId && void loadSaved(curId)}
      onClear={() => loadNew()}
      onDelete={() => void del()}
      extraButtons={[{ key: 'acct', label: 'Books Accounts...', icon: BookOpenCheck, onClick: () => void accountsAffected(), title: 'Choose whether this adjustment changes the account balances in SerieX Books' }]}
      reportButtons={[
        { label: 'Payroll Liability Balances', onClick: () => openWindow('report', { key: 'payroll_liability_balances' }) },
        { label: 'Payroll Item Detail', onClick: () => openWindow('report', { key: 'payroll_item_detail' }) },
      ]}
      header={
        <>
          <HeaderRow>
            <TxnHeaderField label="DATE" htmlFor={`${win.id}-date`} width={150} help="The date the adjustment is recorded (the journal entry date in SerieX Books).">
              <DateField id={`${win.id}-date`} name="date" required value={rec.date} onChange={(v) => update({ date: v })} />
            </TxnHeaderField>
            <TxnHeaderField
              label="EFFECTIVE DATE"
              htmlFor={`${win.id}-eff`}
              width={150}
              help="Decides which period's amounts owed and tax forms (941, 940, W-2) the adjustment changes. Use the date of the last paycheck of the month or quarter you correct."
            >
              <DateField id={`${win.id}-eff`} name="effectiveDate" required value={rec.effectiveDate} onChange={(v) => update({ effectiveDate: v })} />
            </TxnHeaderField>
            <TxnHeaderField label="ADJUSTMENT IS FOR" width={430}>
              <div className="lx-adj-for">
                <RadioGroup<'company' | 'employee'>
                  row
                  aria-label="Adjustment is for"
                  value={mode}
                  onChange={setFor}
                  options={[
                    { value: 'company', label: 'Company' },
                    { value: 'employee', label: 'Employee' },
                  ]}
                />
                <EmployeePicker
                  name="employeeId"
                  aria-label="Employee"
                  placeholder="Choose an employee"
                  disabled={mode !== 'employee'}
                  value={rec.employeeId}
                  fallbackLabel={rec.employeeName}
                  width={210}
                  onChange={(id, e) => update({ employeeId: id, employeeName: e?.displayName ?? '' })}
                />
              </div>
            </TxnHeaderField>
            {prefs.classTracking !== 'none' && (
              <TxnHeaderField label="CLASS" htmlFor={`${win.id}-class`} width={180}>
                <ClassPicker id={`${win.id}-class`} name="classId" value={rec.classId} onChange={(id) => update({ classId: id })} />
              </TxnHeaderField>
            )}
          </HeaderRow>
          <div className="lx-help">
            <Scale size={13} aria-hidden="true" /> Positive amounts increase what is owed (too little was withheld or accrued); negative amounts decrease it.{' '}
            {mode === 'employee'
              ? "An employee adjustment also changes the employee's year-to-date amounts and W-2."
              : 'A company adjustment changes the amounts owed only (use Employee when an employee’s totals must change).'}
          </div>
        </>
      }
      lines={
        <Grid<AdjRow>
          aria-label="Taxes and deductions to adjust"
          columns={columns}
          rows={draft.lines}
          onChange={(rows) => {
            clearError('lines');
            setDraft((d) => (d ? { ...d, lines: rows } : d));
          }}
          newRow={emptyRow}
          minRows={6}
          persistKey="liabadj"
        />
      }
      footer={
        <div className="lx-footer">
          <TxnHeaderField label="MEMO" htmlFor={`${win.id}-memo`} width={420}>
            <TextField id={`${win.id}-memo`} name="memo" value={rec.memo} onChange={(v) => update({ memo: v })} />
          </TxnHeaderField>
          <div className="lx-affect">
            <span className="lx-muted">{rec.affectsAccounts ? 'Changes the liability and expense accounts' : 'Changes payroll only (no accounts)'}</span>
            <Button small label="Books Accounts..." onClick={() => void accountsAffected()} />
          </div>
          {curId ? (
            <BooksStatusLine
              entity="adjustment"
              id={curId}
              status={rec.syncStatus}
              error={rec.syncError}
              booksTxnId={rec.booksTxnId}
              onRetried={refreshSync}
              noneText={
                rec.affectsAccounts
                  ? 'Not in SerieX Books (only income subject to tax was adjusted, or posting is turned off).'
                  : 'Not posted to SerieX Books: this adjustment changes the amounts owed in payroll only.'
              }
            />
          ) : null}
        </div>
      }
      totals={totals}
    />
  );
}

function AffectBody({ initial, close }: { initial: boolean; close: (v: boolean | null) => void }) {
  const [v, setV] = useState<'affect' | 'none'>(initial ? 'affect' : 'none');
  return (
    <div className="lx-dlg">
      <div>The adjustment always changes the amounts owed in payroll (and the Payroll Liability Balances report). Should it also change account balances in SerieX Books?</div>
      <RadioGroup<'affect' | 'none'>
        aria-label="Accounts affected"
        value={v}
        onChange={(x) => setV(x)}
        options={[
          { value: 'none', label: 'No, change payroll only' },
          { value: 'affect', label: 'Yes, also change the liability and expense accounts' },
        ]}
      />
      <div className="lx-muted">With “Yes” the adjustment is posted to SerieX Books as a journal entry (liability account and the item’s expense account).</div>
      <div className="sx-dlg-buttons">
        <Button variant="primary" label="OK" onClick={() => close(v === 'affect')} />
        <Button label="Cancel" onClick={() => close(null)} />
      </div>
    </div>
  );
}

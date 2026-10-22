// Refund (REFUND): pays back a customer's credit (credit memo or unapplied payment) by
// check, cash or credit card. The refund is linked to the credits it uses (REFUND links to
// CREDMEM/PMT); amount = Σ links ≤ credit available.
import { useEffect, useMemo, useRef } from 'react';
import { api } from '@/api/client';
import { useAccounts, useOpenDocs } from '@/api/hooks';
import { emptyLink, emptyTxn, type ID, type Name, type OpenDoc, type Txn } from '@/api/types';
import { AccountPicker, AddressBlock, Checkbox, ClassPicker, DateField, EmptyState, MoneyField, NamePicker, Select, Spinner, TextField } from '@/components';
import { HeaderRow, HeaderSpacer, TxnFormFrame, TxnHeaderField, useTxnForm, type FooterTotal, type TxnProblem } from '@/forms';
import { openTxn } from '@/windows/windowStore';
import { todayIso } from '@/util/dates';
import { fmtDate, fmtMoney, round2 } from '@/util/format';
import { CustomerHistoryPanel } from './CustomerHistoryPanel';
import { loadCustomers, loadPrefs, nextRef } from './salesForm';
import { customerDefaults, HeaderField, money$, useCustomers } from './shared';

export interface RefundFormProps {
  id?: number;
  creditId?: number;
  customerId?: number;
  template?: Txn;
}

type Via = 'check' | 'cash' | 'card';

async function makeRefund(props: RefundFormProps): Promise<Txn> {
  const prefs = await loadPrefs();
  if (props.template) return { ...props.template, id: 0, links: [], linked: [] };
  const t = emptyTxn('REFUND', todayIso());
  t.accountId = prefs.defaultCheckAccountId ?? null;
  t.extra = { via: 'check' };
  let custId: ID | null = props.customerId ?? null;
  if (props.creditId) {
    const c = await api.get<Txn>(`/txns/${props.creditId}`);
    custId = c.nameId;
    t.links = c.openBalance > 0 ? [{ ...emptyLink(c.id), amount: c.openBalance }] : [];
    t.amount = round2(c.openBalance);
    t.classId = c.classId;
  }
  if (custId) {
    const all = await loadCustomers();
    const n = all.find((x) => x.id === custId) ?? (await api.get<Name>(`/names/${custId}`));
    t.nameId = n.id;
    t.nameFull = n.fullName;
    t.billAddress = customerDefaults(n, all, prefs).billAddress;
  }
  if (t.accountId) t.refNumber = await nextRef('CHK', t.accountId);
  return t;
}

export default function RefundForm(props: RefundFormProps) {
  const form = useTxnForm({
    type: 'REFUND',
    id: props.id,
    makeNew: () => makeRefund(props),
    prepare: (t) => ({ ...t, lines: [], links: (t.links ?? []).filter((l) => l.amount > 0), amount: round2((t.links ?? []).reduce((s, l) => s + (l.amount > 0 ? l.amount : 0), 0)) }),
    validate: (t) => validate(t),
    toastOnSave: (s) => `Refund of ${money$(s.amount)} to ${s.nameFull} saved`,
  });
  const t = form.txn;
  const ro = t.voided;
  const customers = useCustomers().data;
  const via: Via = (t.extra?.via as Via) ?? 'check';
  const accounts = useAccounts({ types: ['Bank', 'Credit Card'], active: 'all' }).data ?? [];
  const account = accounts.find((a) => a.id === t.accountId);
  const docs = useOpenDocs({ nameId: t.nameId, kind: 'receivable', includeJobs: true, excludeTxnId: t.id || undefined }, { enabled: !!t.nameId });
  const credits = useMemo(() => (docs.data?.credits ?? []).filter((c) => c.openBalance > 0 || (t.links ?? []).some((l) => l.toTxnId === c.txnId)), [docs.data, t.links]);
  const amountOf = (c: OpenDoc) => (t.links ?? []).find((l) => l.toTxnId === c.txnId)?.amount ?? 0;
  const total = round2((t.links ?? []).reduce((s, l) => s + l.amount, 0));
  const avail = round2(credits.reduce((s, c) => s + c.openBalance, 0));
  const refFetch = useRef(0);

  useEffect(() => {
    form.win?.setTitle(form.isNew ? 'Refund' : `Refund${t.refNumber ? ' ' + t.refNumber : ''} - ${t.nameFull}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.isNew, t.id, t.refNumber, t.nameFull]);

  function validate(x: Txn): TxnProblem[] {
    const out: TxnProblem[] = [];
    const links = (x.links ?? []).filter((l) => l.amount > 0);
    if (!links.length) out.push({ field: 'lines', message: 'Choose the credit you are refunding (check it in the list and enter the amount).' });
    for (const l of links) {
      const c = credits.find((d) => d.txnId === l.toTxnId);
      if (c && l.amount > c.openBalance + 0.004) out.push({ field: 'lines', message: `${c.typeLabel} ${c.refNumber} only has ${money$(c.openBalance)} of credit left.` });
    }
    return out;
  }

  const setCustomer = (id: ID | null, n: Name | null) => {
    const bill = n ? customerDefaults(n, customers, form.prefs).billAddress : '';
    form.setTxn((cur) => ({ ...cur, nameId: id, nameFull: n?.fullName ?? '', billAddress: bill, links: [], amount: 0 }));
  };
  const setLink = (c: OpenDoc, amount: number) => {
    const a = Math.max(0, Math.min(c.openBalance, round2(amount)));
    form.setTxn((cur) => {
      const links = (cur.links ?? []).filter((l) => l.toTxnId !== c.txnId);
      if (a > 0) links.push({ ...emptyLink(c.txnId), amount: a });
      return { ...cur, links, amount: round2(links.reduce((s, l) => s + l.amount, 0)) };
    });
  };
  const setAccount = async (id: ID | null) => {
    form.update({ accountId: id });
    const acc = accounts.find((a) => a.id === id);
    if (form.isNew && id && acc?.type === 'Bank' && via === 'check' && !t.toBePrinted) {
      const seq = ++refFetch.current;
      const ref = await nextRef('CHK', id);
      if (seq === refFetch.current) form.update({ refNumber: ref });
    }
  };
  const setVia = (v: Via) => {
    const patch: Partial<Txn> = { extra: { ...(t.extra ?? {}), via: v } };
    if (v === 'card' && account?.type !== 'Credit Card') patch.accountId = accounts.find((a) => a.type === 'Credit Card' && a.active)?.id ?? null;
    if (v !== 'card' && account?.type === 'Credit Card') patch.accountId = accounts.find((a) => a.type === 'Bank' && a.active)?.id ?? null;
    if (v !== 'check') patch.toBePrinted = false;
    form.update(patch);
  };

  const totals: FooterTotal[] = [
    { key: 'avail', label: 'Credit available', value: avail },
    { key: 'amt', label: 'Refund amount', value: total, strong: true },
  ];

  return (
    <TxnFormFrame
      form={form}
      title="Refund"
      status={t.voided ? 'Void' : null}
      stamp={t.voided ? 'VOID' : null}
      readOnly={ro}
      hideSaveNew
      header={
        <>
          <HeaderRow>
            <HeaderField label="CUSTOMER OR JOB" width={300} required help="Customer or Job">
              <NamePicker name="nameId" kinds={['customer']} value={t.nameId} fallbackLabel={t.nameFull} autoFocus={form.isNew && !t.nameId} onChange={setCustomer} readOnly={ro || !!t.id} aria-label="Customer or job" />
            </HeaderField>
            <HeaderSpacer />
            <TxnHeaderField label="REFUND AMOUNT" width={150}>
              <div className="sx-cust-readout sx-cust-bigreadout">{money$(total)}</div>
            </TxnHeaderField>
            <HeaderField label="DATE" width={140} required>
              <DateField name="date" value={t.date} onChange={(d) => form.update({ date: d })} readOnly={ro} />
            </HeaderField>
            <HeaderField label={via === 'check' ? 'CHECK NO.' : 'REF. NO.'} width={110}>
              <TextField name="refNumber" value={t.toBePrinted ? '' : t.refNumber} placeholder={t.toBePrinted ? 'To print' : ''} onChange={(v) => form.update({ refNumber: v })} readOnly={ro || t.toBePrinted} />
            </HeaderField>
          </HeaderRow>
          <div className="sx-cust-addrrow">
            <HeaderField label="ADDRESS" width={230}>
              <AddressBlock name="billAddress" rows={4} value={t.billAddress} onChange={(v) => form.update({ billAddress: v })} readOnly={ro} aria-label="Address" />
            </HeaderField>
            <div className="sx-cust-fieldgrid sx-cust-fieldgrid-left">
              <HeaderRow>
                <HeaderField label="ISSUE THIS REFUND VIA" width={150}>
                  <Select
                    name="via"
                    value={via}
                    options={[
                      { value: 'check', label: 'Check' },
                      { value: 'cash', label: 'Cash' },
                      { value: 'card', label: 'Credit card' },
                    ]}
                    onChange={(v) => setVia(v as Via)}
                    disabled={ro}
                  />
                </HeaderField>
                <HeaderField label="ACCOUNT" width={240} required help="The bank or credit card account the money is paid from.">
                  <AccountPicker name="accountId" types={via === 'card' ? ['Credit Card'] : ['Bank']} value={t.accountId} onChange={(id) => void setAccount(id)} readOnly={ro} />
                </HeaderField>
                {account && (
                  <TxnHeaderField label="ENDING BALANCE" width={130}>
                    <div className="sx-cust-readout">{fmtMoney(account.balance)}</div>
                  </TxnHeaderField>
                )}
              </HeaderRow>
              <HeaderRow>
                {form.prefs.useClassTracking && (
                  <HeaderField label="CLASS" width={150} help="Class">
                    <ClassPicker name="classId" value={t.classId} onChange={(id) => form.update({ classId: id })} readOnly={ro} />
                  </HeaderField>
                )}
                <HeaderField label="MEMO" width={260} help="Memo">
                  <TextField name="memo" value={t.memo} onChange={(v) => form.update({ memo: v })} readOnly={ro} />
                </HeaderField>
                {via === 'check' && (
                  <div className="sx-cust-tobeprinted">
                    <Checkbox checked={t.toBePrinted} onChange={(v) => form.update({ toBePrinted: v })} disabled={ro} label="To be printed" />
                  </div>
                )}
              </HeaderRow>
            </div>
          </div>
        </>
      }
      lines={
        !t.nameId ? (
          <EmptyState compact title="Choose a customer" message="Pick the customer you are paying back. Their available credits (credit memos and unused payments) appear here." />
        ) : docs.isLoading ? (
          <Spinner center label="Loading credits..." />
        ) : (
          <div className="sx-cust-paytable-scroll">
            <table className="sx-cust-paytable" aria-label="Credits to refund">
              <thead>
                <tr>
                  <th className="sx-cust-ck" />
                  <th>DATE</th>
                  <th>TYPE</th>
                  <th>NUMBER</th>
                  <th>CUSTOMER OR JOB</th>
                  <th className="sx-num">ORIG. AMT.</th>
                  <th className="sx-num">CREDIT LEFT</th>
                  <th className="sx-num">REFUND</th>
                </tr>
              </thead>
              <tbody>
                {credits.length === 0 && (
                  <tr>
                    <td colSpan={8} className="sx-cust-paytable-empty">
                      This customer has no credit to refund. Create a credit memo first.
                    </td>
                  </tr>
                )}
                {credits.map((c) => {
                  const a = amountOf(c);
                  return (
                    <tr key={c.txnId} className={a > 0 ? 'sx-on' : undefined}>
                      <td className="sx-cust-ck">
                        <input type="checkbox" aria-label={`Refund ${c.typeLabel} ${c.refNumber}`} checked={a > 0} disabled={ro} onChange={(e) => setLink(c, e.target.checked ? c.openBalance : 0)} />
                      </td>
                      <td>{fmtDate(c.date)}</td>
                      <td>{c.typeLabel}</td>
                      <td>
                        <button type="button" className="sx-linkbtn" onClick={() => openTxn(c.type, c.txnId)}>
                          {c.refNumber || '(no number)'}
                        </button>
                      </td>
                      <td>{c.nameFull}</td>
                      <td className="sx-num">{fmtMoney(c.amount)}</td>
                      <td className="sx-num">{fmtMoney(c.openBalance)}</td>
                      <td className="sx-num sx-cust-amtcell">
                        <MoneyField value={a} blankZero width={110} readOnly={ro} aria-label={`Refund amount of ${c.refNumber}`} onChange={(v) => setLink(c, v ?? 0)} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      }
      footer={
        t.nameId && total > 0 ? (
          <div className="sx-cust-explain">
            <p>
              {money$(total)} will be paid to {t.nameFull} {via === 'card' ? 'back to their card from' : via === 'cash' ? 'in cash from' : 'by check from'} <b>{account?.fullName ?? 'the chosen account'}</b>, and the credit
              {(t.links ?? []).length > 1 ? 's are' : ' is'} reduced by the same amount.
            </p>
          </div>
        ) : null
      }
      totals={totals}
      sidePanel={<CustomerHistoryPanel nameId={t.nameId} txn={form.original} persistKey="refund" />}
    />
  );
}

// Right-side history panel of the customer forms: customer summary (open balance, overdue,
// unbilled costs, last payment, open estimates, credit limit), recent transactions and notes;
// the "Transaction" tab lists the documents linked to the form's transaction.
import { useState } from 'react';
import { useNameSummary, useTxnList } from '@/api/hooks';
import { TXN_TYPE_LABELS, type ID, type LinkedTxn, type Txn } from '@/api/types';
import { StatusPill } from '@/components';
import { HistoryPanelFrame, HistoryRow, HistorySection } from '@/forms';
import { openTxn, openWindow } from '@/windows/windowStore';
import { todayIso } from '@/util/dates';
import { fmtDate, fmtMoney, localIso } from '@/util/format';
import { displayStatus, useName } from './shared';

/** Props of {@link CustomerHistoryPanel}. */
export interface CustomerHistoryPanelProps {
  /** Customer or job of the form. */
  nameId: ID | null;
  /** The form's transaction (for the Transaction tab). */
  txn?: Txn | null;
  /** Remember open/closed under this key. */
  persistKey: string;
  /** Extra rows at the top of the Transaction tab (e.g. payments applied). */
  extraLinked?: LinkedTxn[];
}

/** Customer / Transaction history panel (side panel with a short summary). */
export function CustomerHistoryPanel({ nameId, txn, persistKey }: CustomerHistoryPanelProps) {
  const [tab, setTab] = useState<'customer' | 'txn'>('customer');
  const name = useName(nameId).data;
  const sum = useNameSummary(nameId).data;
  const recent = useTxnList({ nameId: nameId ?? undefined, includeJobs: true, limit: 6, sort: '-date' }, { enabled: !!nameId }).data;
  const today = todayIso();
  const linked = txn?.linked ?? [];
  const showTxnTab = !!txn && !!txn.id;
  const active = showTxnTab ? tab : 'customer';
  // the panel starts open only when the window has room for it next to the lines (as in the vendor forms)
  const roomy = typeof window !== 'undefined' && window.innerWidth >= 1400;

  return (
    <HistoryPanelFrame
      persistKey={persistKey}
      defaultOpen={roomy}
      width={236}
      tabs={showTxnTab ? [
        { key: 'customer', label: 'Customer' },
        { key: 'txn', label: 'Transaction' },
      ] : undefined}
      activeTab={active}
      onTabChange={(k) => setTab(k as 'customer' | 'txn')}
      title={
        active === 'customer' ? (
          name ? (
            <div className="sx-cust-hist-title">
              <span className="sx-cust-hist-name" title={name.fullName}>
                {name.fullName}
              </span>
              <button type="button" className="sx-linkbtn" onClick={() => openWindow('customerEdit', { id: name.id, parentId: name.parentId ?? undefined })}>
                Edit
              </button>
            </div>
          ) : (
            <span className="sx-muted">No customer selected</span>
          )
        ) : (
          <span>{txn ? `${TXN_TYPE_LABELS[txn.type]}${txn.refNumber ? ' #' + txn.refNumber : ''}` : ''}</span>
        )
      }
    >
      {active === 'customer' ? (
        nameId ? (
          <>
            <HistorySection title="Summary" action={name ? { label: 'Open', onClick: () => openWindow('customerCenter', { selectId: name.id }) } : undefined}>
              {name?.phone && <HistoryRow label="Phone" value={name.phone} />}
              {name?.email && <HistoryRow label="Email" value={<span className="sx-cust-ellipsis" title={name.email}>{name.email}</span>} />}
              <HistoryRow
                label="Open balance"
                value={fmtMoney(sum?.openBalance ?? 0)}
                onClick={() => openWindow('report', { key: 'customer_balance_detail', params: { nameIds: String(nameId), includeJobs: '1', dates: 'all' } })}
              />
              {!!sum?.overdue && <HistoryRow label="Overdue" value={<span className="sx-tone-text-danger">{fmtMoney(sum.overdue)}</span>} />}
              {!!sum?.unbilledCosts && <HistoryRow label="Unbilled costs" value={fmtMoney(sum.unbilledCosts)} />}
              <HistoryRow label="Active estimates" value={String(sum?.openEstimates ?? 0)} />
              {sum?.creditLimit !== null && sum?.creditLimit !== undefined && <HistoryRow label="Credit limit" value={fmtMoney(sum.creditLimit)} />}
              {sum?.lastPayment && (
                <HistoryRow
                  label="Last payment"
                  value={
                    <span className="sx-cust-hist-lastpay">
                      {fmtMoney(sum.lastPayment.amount)}
                      <small>{fmtDate(sum.lastPayment.date)}</small>
                    </span>
                  }
                />
              )}
            </HistorySection>
            <HistorySection title="Recent transactions">
              {(recent?.rows ?? []).length === 0 && <div className="sx-muted sx-cust-hist-empty">No transactions yet.</div>}
              {(recent?.rows ?? []).map((r) => (
                <div key={r.id} className="sx-cust-hist-txn">
                  <button type="button" className="sx-linkbtn" onClick={() => openTxn(r.type, r.id)} title={`Open ${r.typeLabel}${r.refNumber ? ' #' + r.refNumber : ''}`}>
                    {r.typeLabel}
                    {r.refNumber ? ` #${r.refNumber}` : ''}
                  </button>
                  <span className="sx-cust-hist-amt">{fmtMoney(r.amount)}</span>
                  <span className="sx-cust-hist-sub">
                    {fmtDate(r.date)}
                    {(r.type === 'INV' || r.type === 'EST' || r.voided) && <StatusPill status={displayStatus(r, today)} />}
                  </span>
                </div>
              ))}
            </HistorySection>
            <HistorySection title="Notes" action={name ? { label: 'Edit', onClick: () => openWindow('customerEdit', { id: name.id, parentId: name.parentId ?? undefined, section: 'notes' }) } : undefined}>
              {name?.notes ? <div className="sx-cust-hist-notes">{name.notes}</div> : <div className="sx-muted sx-cust-hist-empty">No notes.</div>}
            </HistorySection>
          </>
        ) : (
          <div className="sx-muted sx-cust-hist-empty">Choose a customer to see their balance, recent transactions and notes.</div>
        )
      ) : (
        <>
          <HistorySection title="Related transactions">
            {linked.length === 0 && <div className="sx-muted sx-cust-hist-empty">Nothing is linked to this transaction yet.</div>}
            {linked.map((l) => (
              <div key={`${l.txnId}-${l.relation}`} className="sx-cust-hist-txn">
                <button type="button" className="sx-linkbtn" onClick={() => openTxn(l.type, l.txnId)} title="Open">
                  {l.typeLabel}
                  {l.refNumber ? ` #${l.refNumber}` : ''}
                </button>
                <span className="sx-cust-hist-amt">{fmtMoney(l.amount)}</span>
                <span className="sx-cust-hist-sub">
                  {fmtDate(l.date)} · {l.relation}
                </span>
              </div>
            ))}
          </HistorySection>
          {txn && (
            <HistorySection title="Details">
              <HistoryRow label="Created by" value={txn.createdBy || '—'} />
              <HistoryRow label="Created" value={txn.createdAt ? fmtDate(localIso(new Date(txn.createdAt))) : '—'} />
              <HistoryRow label="Last changed" value={txn.updatedAt ? fmtDate(localIso(new Date(txn.updatedAt))) : '—'} />
            </HistorySection>
          )}
        </>
      )}
    </HistoryPanelFrame>
  );
}

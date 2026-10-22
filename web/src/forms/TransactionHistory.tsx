// "Transaction History" box (Ctrl+H on a form): the transactions linked to this one
// (payments of an invoice, the invoice of a payment...) with Go To.
import { useState } from 'react';
import { TXN_TYPE_LABELS, type LinkedTxn, type Txn } from '@/api/types';
import { openTxn } from '@/windows/windowStore';
import { showDialog } from '@/components/dialogs';
import { ListView } from '@/components/ListView';
import { fmtDate, fmtMoney } from '@/util/format';

/** Opens the Transaction History box of a saved transaction. */
export function showTransactionHistory(txn: Txn): Promise<void> {
  const label = TXN_TYPE_LABELS[txn.type] ?? 'Transaction';
  return showDialog<void>({
    title: `Transaction History - ${label}`,
    width: 640,
    cancelValue: undefined,
    render: (close) => <HistoryBody txn={txn} close={() => close(undefined)} />,
  });
}

function HistoryBody({ txn, close }: { txn: Txn; close: () => void }) {
  const rows = txn.linked ?? [];
  const [sel, setSel] = useState<number | null>(rows[0]?.txnId ?? null);
  const label = TXN_TYPE_LABELS[txn.type] ?? 'Transaction';
  const goTo = (r?: LinkedTxn) => {
    const target = r ?? rows.find((x) => x.txnId === sel);
    if (!target) return;
    close();
    openTxn(target.type, target.txnId);
  };
  return (
    <div className="sx-txnhist">
      <fieldset className="sx-group">
        <legend>{label} Information</legend>
        <div className="sx-txnhist-info">
          <span className="sx-label-plain">Name</span>
          <span>{txn.nameFull || '—'}</span>
          <span className="sx-label-plain">Number</span>
          <span>{txn.refNumber || '—'}</span>
          <span className="sx-label-plain">Date</span>
          <span>{fmtDate(txn.date)}</span>
          <span className="sx-label-plain">Amount</span>
          <span>{fmtMoney(txn.amount)}</span>
          <span className="sx-label-plain">Entered by</span>
          <span>
            {txn.createdBy || '—'} {txn.createdAt ? `on ${fmtDate(txn.createdAt.slice(0, 10))}` : ''}
          </span>
          <span className="sx-label-plain">Last modified</span>
          <span>{txn.updatedAt ? fmtDate(txn.updatedAt.slice(0, 10)) : '—'}</span>
        </div>
      </fieldset>
      <div className="sx-txnhist-caption">Related transactions</div>
      <ListView<LinkedTxn>
        className="sx-txnhist-list"
        rows={rows}
        getKey={(r) => r.txnId}
        selectedKey={sel}
        onSelect={(k) => setSel(k as number)}
        onActivate={(r) => goTo(r)}
        emptyText="There are no transactions related to this one."
        columns={[
          { key: 'typeLabel', label: 'TYPE', width: 130 },
          { key: 'date', label: 'DATE', width: 80, type: 'date' },
          { key: 'refNumber', label: 'NUM', width: 70 },
          { key: 'relation', label: 'RELATIONSHIP', width: 160, grow: true },
          { key: 'amount', label: 'AMOUNT', width: 90, type: 'money' },
        ]}
        aria-label="Related transactions"
      />
      <div className="sx-dlg-buttons">
        <button type="button" className="sx-btn sx-btn-default" onClick={close}>
          OK
        </button>
        <button type="button" className="sx-btn" disabled={!sel} onClick={() => goTo()}>
          Go To
        </button>
      </div>
    </div>
  );
}

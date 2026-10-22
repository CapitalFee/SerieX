// Right-side history panel of vendor forms (bills, purchase orders, item receipts): vendor summary,
// recent transactions, notes, and the transactions linked to the open record.
import { useLayoutEffect, useRef, useState } from 'react';
import { useNameSummary, useTxnList } from '@/api/hooks';
import { TXN_TYPE_LABELS, type ID, type Txn } from '@/api/types';
import { HistoryPanelFrame, HistoryRow, HistorySection } from '@/forms';
import { openTxn, openWindow } from '@/windows/windowStore';
import { fmtDate, fmtMoney } from '@/util/format';
import { openVendorActivity, useVendors } from './shared';

export interface VendorHistoryPanelProps {
  vendorId: ID | null;
  /** The open transaction (its links are listed on the Transaction tab once saved). */
  txn?: Txn | null;
  persistKey: string;
}

/** Width of the open panel (px). */
const PANEL_WIDTH = 230;
/** Lines width a form needs next to the panel when it has no lines grid to measure. */
const MIN_LINES_WIDTH = 760;

/** The open/closed choice the user saved with the panel's toggle (HistoryPanelFrame keeps it in "sx.hist.<key>"). */
function savedChoice(persistKey: string): boolean | null {
  try {
    const v = localStorage.getItem('sx.hist.' + persistKey);
    return v === null ? null : v === '1';
  } catch {
    return null;
  }
}

/**
 * Whether the form's lines grid keeps its full width with the panel open (no sideways scroll), measured in
 * the form window itself. `wrap` holds the panel and sits in the form's main row next to the lines column.
 * Null while it cannot be measured (the window is hidden).
 */
function linesGridFits(wrap: HTMLElement): boolean | null {
  const panel = wrap.firstElementChild as HTMLElement | null;
  const row = wrap.parentElement;
  if (!panel || !row || row.clientWidth === 0) return null;
  // the open panel takes this much more width from the lines column than it takes now
  const extra = PANEL_WIDTH - panel.offsetWidth;
  const scroll = (wrap.closest('.sx-txnform') ?? row).querySelector<HTMLElement>('.sx-txnform-lines .sx-grid-scroll');
  if (!scroll) return row.clientWidth - PANEL_WIDTH >= MIN_LINES_WIDTH;
  if (scroll.clientWidth === 0) return null;
  const table = scroll.firstElementChild as HTMLElement | null;
  const need = Math.max(parseFloat(table ? getComputedStyle(table).minWidth : '') || 0, scroll.scrollWidth > scroll.clientWidth + 1 ? scroll.scrollWidth : 0);
  return need <= scroll.clientWidth - extra - 2;
}

/**
 * Open state of the panel. It starts open only when the form window has room for it next to the lines grid
 * (a floating window at the default width starts with it closed). A panel that opened by itself closes
 * again when the grid no longer fits (Items tab, more columns, a smaller window). Once the user clicks the
 * toggle the panel follows the user; a panel the user closed starts closed next time.
 */
function useRoomyPanel(persistKey: string) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  // 'wait' = not measured yet; 'auto' = open because the grid fits; 'fixed' = no more automatic changes
  const [start] = useState<'wait' | 'fixed'>(() => (savedChoice(persistKey) === false ? 'fixed' : 'wait'));
  const phase = useRef<'wait' | 'auto' | 'fixed'>(start);

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || phase.current === 'fixed') return;
    let frame = 0;
    // re-check when the window is resized and when the lines grid changes (tab switch, columns)
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => later());
    const mo = new MutationObserver(() => later());
    const stop = () => {
      cancelAnimationFrame(frame);
      ro?.disconnect();
      mo.disconnect();
    };
    const check = () => {
      if (phase.current === 'fixed') return stop();
      const fits = linesGridFits(wrap);
      if (fits === null) return;
      if (fits && phase.current === 'wait') {
        phase.current = 'auto';
        setOpen(true);
      } else if (!fits) {
        phase.current = 'fixed';
        setOpen(false);
        stop();
      }
    };
    const later = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(check);
    };
    if (wrap.parentElement) ro?.observe(wrap.parentElement);
    const lines = wrap.closest('.sx-txnform')?.querySelector('.sx-txnform-lines');
    if (lines) mo.observe(lines, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
    check();
    return stop;
  }, []);

  const onToggle = (next: boolean) => {
    phase.current = 'fixed';
    setOpen(next);
  };
  return { wrapRef, open, onToggle };
}

/** Collapsible vendor / transaction history panel for purchase forms. */
export function VendorHistoryPanel({ vendorId, txn, persistKey }: VendorHistoryPanelProps) {
  const [tab, setTab] = useState<'vendor' | 'txn'>('vendor');
  const { byId } = useVendors();
  const vendor = vendorId ? byId.get(vendorId) : undefined;
  const summary = useNameSummary(vendorId);
  const recent = useTxnList({ nameId: vendorId ?? undefined, limit: 6, sort: '-date' }, { enabled: !!vendorId });
  const saved = !!txn?.id;
  const linked = txn?.linked ?? [];
  const showTxnTab = saved && tab === 'txn';
  const panel = useRoomyPanel(persistKey);

  return (
    // the wrapper only gives the panel's place in the form to the room check; it adds no box to the layout
    <div ref={panel.wrapRef} style={{ display: 'contents' }}>
      <HistoryPanelFrame
        persistKey={persistKey}
        open={panel.open}
        onToggle={panel.onToggle}
        width={PANEL_WIDTH}
        tabs={saved ? [{ key: 'vendor', label: 'Vendor' }, { key: 'txn', label: 'Transaction' }] : [{ key: 'vendor', label: 'Vendor' }]}
        activeTab={showTxnTab ? 'txn' : 'vendor'}
        onTabChange={(k) => setTab(k as 'vendor' | 'txn')}
        title={
          showTxnTab ? (
            <span>{txn ? TXN_TYPE_LABELS[txn.type] : ''}</span>
          ) : vendor ? (
            <button type="button" className="sx-linkbtn" title="Edit vendor" onClick={() => openWindow('vendorEdit', { id: vendor.id })}>
              {vendor.name}
            </button>
          ) : (
            <span className="vx-muted">No vendor selected</span>
          )
        }
      >
        {showTxnTab ? (
          <>
            <HistorySection title="RELATED TRANSACTIONS">
              {linked.length === 0 ? (
                <span className="vx-muted">Nothing is linked to this transaction yet.</span>
              ) : (
                <div className="vx-hist-list">
                  {linked.map((l) => (
                    <button key={`${l.txnId}-${l.relation}`} type="button" className="vx-hist-txn" onClick={() => openTxn(l.type, l.txnId)}>
                      <span className="vx-hist-type">
                        {l.typeLabel || TXN_TYPE_LABELS[l.type]} {l.refNumber}
                      </span>
                      <span className="vx-hist-amt">{fmtMoney(l.amount)}</span>
                      <span className="vx-hist-date">
                        {fmtDate(l.date)} · {l.relation}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </HistorySection>
            <HistorySection title="RECORD">
              <HistoryRow label="Entered by" value={txn?.createdBy || '—'} />
              <HistoryRow label="Created" value={txn?.createdAt ? fmtDate(txn.createdAt.slice(0, 10)) : '—'} />
              <HistoryRow label="Last changed" value={txn?.updatedAt ? fmtDate(txn.updatedAt.slice(0, 10)) : '—'} />
            </HistorySection>
          </>
        ) : !vendor ? (
          <span className="vx-muted">Choose a vendor to see their balance, recent transactions and notes.</span>
        ) : (
          <>
            <HistorySection title="SUMMARY" action={{ label: 'Activity Report', onClick: () => openVendorActivity(vendor) }}>
              <HistoryRow label="Phone" value={vendor.phone || '—'} />
              <HistoryRow label="Open balance" value={fmtMoney(summary.data?.openBalance ?? vendor.balance)} />
              <HistoryRow label="Overdue" value={<span className={summary.data?.overdue ? 'vx-danger-text' : undefined}>{fmtMoney(summary.data?.overdue ?? 0)}</span>} />
              <HistoryRow label="Open POs" value={summary.data?.openPOs ?? 0} />
              {summary.data?.lastPayment && (
                <HistoryRow label="Last paid" value={`${fmtMoney(summary.data.lastPayment.amount)} · ${fmtDate(summary.data.lastPayment.date)}`} />
              )}
              {summary.data?.creditLimit ? <HistoryRow label="Credit limit" value={fmtMoney(summary.data.creditLimit)} /> : null}
            </HistorySection>
            <HistorySection title="RECENT TRANSACTIONS">
              {(recent.data?.rows ?? []).length === 0 ? (
                <span className="vx-muted">No transactions yet.</span>
              ) : (
                <div className="vx-hist-list">
                  {(recent.data?.rows ?? []).map((r) => (
                    <button key={r.id} type="button" className="vx-hist-txn" onClick={() => openTxn(r.type, r.id)} title="Open this transaction">
                      <span className="vx-hist-type">
                        {r.typeLabel} {r.refNumber}
                      </span>
                      <span className="vx-hist-amt">{fmtMoney(r.amount)}</span>
                      <span className="vx-hist-date">{fmtDate(r.date)}</span>
                    </button>
                  ))}
                </div>
              )}
            </HistorySection>
            <HistorySection title="NOTES" action={{ label: vendor.notes ? 'Edit' : 'Add', onClick: () => openWindow('vendorEdit', { id: vendor.id }) }}>
              {vendor.notes ? <div className="vx-hist-notes">{vendor.notes}</div> : <span className="vx-muted">No notes.</span>}
            </HistorySection>
          </>
        )}
      </HistoryPanelFrame>
    </div>
  );
}

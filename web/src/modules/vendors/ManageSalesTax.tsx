// Manage Sales Tax: one place for the sales tax steps — preferences, sales tax items and groups,
// the sales tax reports, and paying the tax that is due (with what is owed now per agency).
import { useMemo, useState } from 'react';
import { BarChart3, FilePlus2, Landmark, Pencil, Percent, Settings, Wallet } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { useItems, useItemsById, usePrefValues } from '@/api/hooks';
import type { ID, Item, SalesTaxDue } from '@/api/types';
import { Button, Card, EmptyState, ListView, Spinner, type ListColumn } from '@/components';
import { openWindow } from '@/windows/windowStore';
import { todayIso } from '@/util/dates';
import { fmtDate, fmtMoney, fmtPercent, round2 } from '@/util/format';
import { isTaxAdjustment, openReport, sum2, useVendors } from './shared';
import './vendors.css';

export interface ManageSalesTaxProps {}

const FREQ: Record<string, string> = { monthly: 'monthly', quarterly: 'quarterly', annually: 'once a year' };

/** Total rate of a tax item or group (%). */
export function taxItemRate(it: Item, byId: Map<ID, Item>): number {
  if (it.type === 'Sales Tax Group') return (it.groupLines ?? []).reduce((s, g) => s + (byId.get(g.itemId)?.taxRate ?? 0), 0);
  return it.taxRate ?? 0;
}

export default function ManageSalesTax(_props: ManageSalesTaxProps) {
  const prefs = usePrefValues();
  const today = todayIso();
  const items = useItems({ types: ['Sales Tax Item', 'Sales Tax Group'], active: 'all' });
  const byId = useItemsById();
  const { byId: vendors } = useVendors();
  const due = useQuery({ queryKey: ['sales-tax-due', today], queryFn: () => api.get<SalesTaxDue[]>(`/sales-tax/due?asOf=${today}`), enabled: prefs.salesTaxEnabled });
  const [sel, setSel] = useState<ID | null>(null);

  const rows = items.data ?? [];
  const defaultItem = prefs.defaultSalesTaxItemId ? byId.get(prefs.defaultSalesTaxItemId) : undefined;
  // owed per agency; sales tax adjustments (rows without a tax item, e.g. a journal entry for a
  // discount or penalty) are part of what is owed and are also shown on their own
  const byAgency = useMemo(() => {
    const m = new Map<string, { total: number; adjustments: number }>();
    for (const d of due.data ?? []) {
      const k = d.agencyName || 'No agency set';
      const a = m.get(k) ?? { total: 0, adjustments: 0 };
      a.total = round2(a.total + d.amountDue);
      if (isTaxAdjustment(d)) a.adjustments = round2(a.adjustments + d.amountDue);
      m.set(k, a);
    }
    return [...m.entries()];
  }, [due.data]);
  const totalDue = sum2((due.data ?? []).map((d) => d.amountDue));

  if (!prefs.salesTaxEnabled) {
    return (
      <div className="vx-salestax">
        <EmptyState
          icon={Percent}
          title="Sales tax is turned off"
          message="Turn on sales tax in Preferences if you sell taxable products or services. You can then set up tax rates, charge tax on invoices and pay it to the tax agency here."
          action={{ label: 'Turn on sales tax', onClick: () => openWindow('preferences', { section: 'salesTax' }) }}
        />
      </div>
    );
  }

  // Three columns, so the list fits its half of the window at the default size: a group has no tax
  // agency of its own (each item in it has one), so its agency cell says it is a group instead of
  // a separate TYPE column.
  const agencyText = (i: Item) => (i.taxAgencyId ? vendors.get(i.taxAgencyId)?.name ?? '' : '');
  const groupText = (i: Item) => {
    const n = (i.groupLines ?? []).length;
    return `Group of ${n} item${n === 1 ? '' : 's'}`;
  };
  const cols: ListColumn<Item>[] = [
    { key: 'name', label: 'TAX ITEM', width: 150, grow: true, render: (i) => i.fullName || i.name },
    { key: 'rate', label: 'RATE', width: 62, align: 'right', sortValue: (i) => taxItemRate(i, byId), render: (i) => fmtPercent(taxItemRate(i, byId)) },
    {
      key: 'agency',
      label: 'TAX AGENCY',
      width: 196,
      sortValue: (i) => (i.type === 'Sales Tax Group' ? groupText(i) : agencyText(i)),
      render: (i) =>
        i.type === 'Sales Tax Group' ? <span className="vx-muted">{groupText(i)}</span> : i.taxAgencyId ? agencyText(i) : <span className="vx-danger-text">Not set</span>,
    },
  ];

  return (
    <div className="vx-salestax">
      <p className="vx-st-intro">
        Sales tax you charge customers is held in <strong>Sales Tax Payable</strong> until you pay it to the tax agency.
      </p>
      <div className="vx-st-grid">
        <Card
          className="vx-st-items"
          title={
            <span className="vx-st-title">
              <span className="vx-st-step">1</span> Sales tax items
            </span>
          }
          actions={
            <>
              <Button small icon={FilePlus2} label="New item" onClick={() => openWindow('itemEdit', { type: 'Sales Tax Item' })} />
              <Button small label="New group" onClick={() => openWindow('itemEdit', { type: 'Sales Tax Group' })} />
              <Button small icon={Pencil} label="Edit" disabled={!sel} onClick={() => sel && openWindow('itemEdit', { id: sel })} />
            </>
          }
          flush
        >
          {items.isLoading ? (
            <Spinner center />
          ) : (
            <ListView<Item>
              className="vx-st-list"
              aria-label="Sales tax items"
              rows={rows}
              columns={cols}
              selectedKey={sel}
              onSelect={(k) => setSel(k as ID)}
              onActivate={(i) => openWindow('itemEdit', { id: i.id })}
              isInactive={(i) => !i.active}
              emptyText={<EmptyState compact title="No sales tax items" message="Add one item per tax rate (for example your state and city taxes)." action={{ label: 'New sales tax item', onClick: () => openWindow('itemEdit', { type: 'Sales Tax Item' }) }} />}
            />
          )}
        </Card>
        <div className="vx-st-side">
          <Card
            title={
              <span className="vx-st-title">
                <Settings size={15} /> Preferences
              </span>
            }
            actions={<Button small label="Edit…" onClick={() => openWindow('preferences', { section: 'salesTax' })} />}
          >
            <dl className="vx-dlg-info">
              <dt>Most common</dt>
              <dd>{defaultItem ? `${defaultItem.name} (${fmtPercent(taxItemRate(defaultItem, byId))})` : 'Not set'}</dd>
              <dt>You pay</dt>
              <dd>{FREQ[prefs.salesTaxFrequency] ?? prefs.salesTaxFrequency}</dd>
              <dt>Tax is owed</dt>
              <dd>{prefs.salesTaxBasis === 'cash' ? 'when customers pay (cash)' : 'when you invoice (accrual)'}</dd>
            </dl>
          </Card>
          <Card
            title={
              <span className="vx-st-title">
                <span className="vx-st-step">2</span> Review what you owe
              </span>
            }
          >
            <div className="vx-st-links">
              <Button small icon={BarChart3} label="Sales Tax Liability" onClick={() => openReport('sales_tax_liability', { dates: 'lastMonth' })} />
              <Button small icon={BarChart3} label="Sales Tax Revenue Summary" onClick={() => openReport('sales_tax_revenue_summary', { dates: 'lastMonth' })} />
            </div>
          </Card>
          <Card
            title={
              <span className="vx-st-title">
                <span className="vx-st-step">3</span> Pay sales tax
              </span>
            }
            subtitle={`Owed as of ${fmtDate(today)}`}
          >
            {due.isLoading ? (
              <Spinner />
            ) : byAgency.length === 0 ? (
              <p className="vx-muted vx-m0">Nothing is owed right now.</p>
            ) : (
              <dl className="vx-dlg-info">
                {byAgency.map(([name, a]) => (
                  <div key={name} className="vx-contents">
                    <dt>
                      <Landmark size={13} /> {name}
                    </dt>
                    <dd className="vx-num">{fmtMoney(a.total)}</dd>
                    {a.adjustments !== 0 && (
                      <>
                        <dt className="vx-muted vx-st-adj">Adjustments (included)</dt>
                        <dd className="vx-num vx-muted">{fmtMoney(a.adjustments)}</dd>
                      </>
                    )}
                  </div>
                ))}
                <dt className="vx-strong">Total</dt>
                <dd className="vx-num vx-strong">{fmtMoney(totalDue)}</dd>
              </dl>
            )}
            <div className="vx-st-links">
              <Button small variant="primary" icon={Wallet} label="Pay sales tax…" onClick={() => openWindow('paySalesTax')} />
              <Button small label="Adjust (journal entry)…" title="Record a discount, credit or penalty on the tax you owe" onClick={() => openWindow('journalEntry')} />
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

// Company > Reminders: what needs attention, grouped by kind (overdue invoices,
// bills to pay, money to deposit, checks / invoices to print, inventory to reorder, memorized
// transactions due, open purchase orders, sales tax due, to dos). Groups expand to their items;
// clicking an item opens it, and each group offers its main action (Pay bills, Make deposits...).
import { useState } from 'react';
import { ChevronDown, ChevronRight, CheckCircle2, RefreshCw, Settings2 } from 'lucide-react';
import { queryClient } from '@/api/hooks';
import type { ReminderGroup, ReminderItem } from '@/api/types';
import { Badge, Button, EmptyState, Spinner, Toolbar, ToolbarButton, ToolbarSpacer } from '@/components';
import { enterMemorizedById } from '@/modules/lists/memorized';
import { openWindow } from '@/windows/windowStore';
import type { WindowKind } from '@/windows/kinds';
import { fmtDate } from '@/util/format';
import { todayIso } from '@/util/dates';
import { money2, openTxnById, useReminders } from './shared';
import './company.css';

export interface RemindersWindowProps {}

const ACTIONS: Partial<Record<ReminderGroup['key'], { label: string; kind: WindowKind; props?: Record<string, unknown> }>> = {
  overdue_invoices: { label: 'Receive payments', kind: 'receivePayment' },
  bills_to_pay: { label: 'Pay bills', kind: 'payBills' },
  checks_to_print: { label: 'Print checks', kind: 'printChecks' },
  invoices_to_print: { label: 'Print invoices', kind: 'printChecks', props: { kind: 'invoices' } },
  money_to_deposit: { label: 'Make deposits', kind: 'makeDeposit' },
  inventory_to_reorder: { label: 'Create purchase order', kind: 'purchaseOrder' },
  memorized_due: { label: 'Memorized transactions', kind: 'memorizedTxns' },
  purchase_orders: { label: 'Receive items', kind: 'receiveItems' },
  todos: { label: 'To Do list', kind: 'todos' },
  sales_tax_due: { label: 'Pay sales tax', kind: 'paySalesTax' },
};

const DATE_LABEL: Partial<Record<ReminderGroup['key'], string>> = {
  overdue_invoices: 'Due',
  bills_to_pay: 'Due',
  memorized_due: 'Next',
  todos: 'Due',
  purchase_orders: 'Date',
};

export default function RemindersWindow(_props: RemindersWindowProps) {
  const q = useReminders();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const groups = q.data ?? [];
  const full = groups.filter((g) => g.items.length > 0);
  const empty = groups.filter((g) => g.items.length === 0);
  const today = todayIso();

  const openItem = (g: ReminderGroup, it: ReminderItem) => {
    if (it.txnId) void openTxnById(it.txnId);
    // a memorized transaction due: open its filled form (saving it moves the schedule on)
    else if (it.memorizedId) void enterMemorizedById(it.memorizedId);
    else if (g.key === 'sales_tax_due') openWindow('paySalesTax');
    else if (it.itemId) openWindow('itemEdit', { id: it.itemId });
    else if (g.key === 'todos') openWindow('todos');
  };

  return (
    <div className="cx-reminders">
      <Toolbar>
        <ToolbarButton
          label="Expand all"
          icon={ChevronDown}
          onClick={() => setOpen(Object.fromEntries(full.map((g) => [g.key, true])))}
          disabled={!full.length}
        />
        <ToolbarButton label="Collapse all" icon={ChevronRight} onClick={() => setOpen({})} disabled={!full.length} />
        <ToolbarSpacer />
        <ToolbarButton label="Refresh" icon={RefreshCw} onClick={() => void queryClient.invalidateQueries({ queryKey: ['reminders'] })} />
        <ToolbarButton label="Preferences" icon={Settings2} onClick={() => openWindow('preferences', { section: 'reminders' })} />
      </Toolbar>
      <div className="cx-rem-body">
        {q.isLoading ? (
          <div style={{ padding: 30, display: 'grid', placeItems: 'center' }}>
            <Spinner label="Loading reminders..." />
          </div>
        ) : q.error ? (
          <EmptyState
            compact
            title="Reminders could not be loaded"
            message={(q.error as Error).message}
            action={{ label: 'Try again', onClick: () => void q.refetch() }}
          />
        ) : full.length === 0 ? (
          <EmptyState icon={CheckCircle2} title="You are all caught up" message="Nothing is overdue, due or waiting to be printed or deposited." />
        ) : (
          full.map((g) => {
            const isOpen = !!open[g.key];
            const action = ACTIONS[g.key];
            const late = g.items.some((i) => i.date && i.date < today && g.key !== 'money_to_deposit' && g.key !== 'sales_tax_due');
            return (
              <section key={g.key} className={'cx-remgroup' + (isOpen ? ' cx-open' : '')}>
                <div className="cx-remhead">
                  <button type="button" className="cx-remtoggle" aria-expanded={isOpen} onClick={() => setOpen((o) => ({ ...o, [g.key]: !isOpen }))}>
                    {isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                    <span className="cx-remlabel">{g.label}</span>
                    <Badge tone={g.key === 'overdue_invoices' || late ? 'danger' : 'accent'}>{g.items.length}</Badge>
                    <span className="cx-spacer" />
                    {g.total > 0 && <span className="cx-num cx-remtotal">{money2(g.total)}</span>}
                  </button>
                  {action && <Button size="sm" variant="ghost" label={action.label} onClick={() => openWindow(action.kind, action.props ?? {})} />}
                </div>
                {isOpen && (
                  <table className="cx-remitems">
                    <tbody>
                      {g.items.map((it, i) => (
                        <tr
                          key={i}
                          tabIndex={0}
                          onDoubleClick={() => openItem(g, it)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              openItem(g, it);
                            }
                          }}
                          title="Double-click to open"
                        >
                          <td className={'cx-remdate' + (it.date && it.date < today && DATE_LABEL[g.key] === 'Due' ? ' cx-tone-danger' : '')}>
                            {it.date ? `${DATE_LABEL[g.key] ? DATE_LABEL[g.key] + ' ' : ''}${fmtDate(it.date)}` : ''}
                          </td>
                          <td className="cx-ellipsis">
                            <button type="button" className="sx-linkbtn" onClick={() => openItem(g, it)} tabIndex={-1}>
                              {it.label}
                            </button>
                          </td>
                          <td className="cx-num cx-right">{it.amount ? money2(it.amount) : ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>
            );
          })
        )}
        {!q.isLoading && empty.length > 0 && full.length > 0 && (
          <div className="cx-muted cx-small" style={{ padding: '10px 4px' }}>
            Nothing in: {empty.map((g) => g.label).join(', ')}.
          </div>
        )}
      </div>
    </div>
  );
}

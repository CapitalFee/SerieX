// The Home page task cards: four cards (Sell, Buy, Bank, Books), each a short numbered list of
// the everyday tasks in the order they usually happen. A click opens the task's window.
// Tasks follow the feature preferences (estimates, purchase orders, inventory, sales tax).
import type { CSSProperties } from 'react';
import {
  ArrowDownToLine,
  BookOpen,
  CalendarDays,
  ChartColumn,
  ClipboardList,
  CreditCard,
  FileCheck2,
  FileClock,
  FileSpreadsheet,
  FileText,
  HandCoins,
  Landmark,
  ListTree,
  NotebookPen,
  Package,
  PackageCheck,
  PackagePlus,
  Percent,
  PiggyBank,
  Printer,
  ReceiptText,
  RotateCcw,
  ScrollText,
  ShoppingCart,
  SquarePen,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import type { Prefs } from '@/api/types';
import { openWindow } from '@/windows/windowStore';
import type { WindowKind } from '@/windows/kinds';

interface Task {
  id: string;
  label: string;
  icon: LucideIcon;
  open: () => void;
  title?: string;
}

interface TaskCard {
  key: string;
  title: string;
  sub: string;
  icon: LucideIcon;
  /** Accent (text) and soft (background) colors of the card's icons. */
  fg: string;
  bg: string;
  tasks: Task[];
}

const win = (kind: WindowKind, props?: Record<string, unknown>) => () => {
  openWindow(kind, props ?? {});
};

export interface WorkflowProps {
  prefs: Prefs;
  /** Opens the check register (bank account chosen by the caller). */
  onCheckRegister: () => void;
}

/** The task cards of the Home page. */
export function Workflow({ prefs, onCheckRegister }: WorkflowProps) {
  const inv = prefs.inventoryEnabled;
  const po = prefs.purchaseOrdersEnabled;
  const est = prefs.estimatesEnabled;
  const tax = prefs.salesTaxEnabled;
  const receiving = inv || po;
  const only = (on: boolean, t: Task): Task[] => (on ? [t] : []);

  const cards: TaskCard[] = [
    {
      key: 'sell',
      title: 'Sell',
      sub: 'Quote, invoice and get paid',
      icon: ReceiptText,
      fg: '#15803d',
      bg: '#dcfce7',
      tasks: [
        ...only(est, { id: 'est', label: 'Estimate', icon: FileClock, open: win('estimate') }),
        { id: 'inv', label: 'Invoice', icon: ReceiptText, open: win('invoice') },
        { id: 'rp', label: 'Receive a payment', icon: HandCoins, open: win('receivePayment') },
        { id: 'sr', label: 'Sales receipt', icon: FileCheck2, open: win('salesReceipt'), title: 'Paid on the spot: no invoice needed' },
        { id: 'rc', label: 'Credit or refund', icon: RotateCcw, open: win('creditMemo') },
        { id: 'sc', label: 'Statement charge', icon: SquarePen, open: win('statementCharges') },
        { id: 'stm', label: 'Customer statements', icon: ScrollText, open: win('createStatements') },
      ],
    },
    {
      key: 'buy',
      title: 'Buy',
      sub: 'Order, record bills and pay them',
      icon: ShoppingCart,
      fg: '#c2410c',
      bg: '#ffedd5',
      tasks: [
        ...only(po, { id: 'po', label: 'Purchase order', icon: ShoppingCart, open: win('purchaseOrder') }),
        ...only(receiving, { id: 'ri', label: 'Receive items', icon: PackagePlus, open: win('receiveItems'), title: 'Items arrived, the bill comes later' }),
        ...only(receiving, { id: 'ebai', label: 'Bill for received items', icon: PackageCheck, open: win('enterBillForReceived') }),
        { id: 'eb', label: 'Enter a bill', icon: FileText, open: win('bill') },
        { id: 'pb', label: 'Pay bills', icon: Wallet, open: win('payBills') },
        ...only(tax, { id: 'st', label: 'Pay sales tax', icon: Percent, open: win('manageSalesTax') }),
      ],
    },
    {
      key: 'bank',
      title: 'Bank',
      sub: 'Deposit, spend and reconcile',
      icon: Landmark,
      fg: '#1d4ed8',
      bg: '#dbeafe',
      tasks: [
        { id: 'dep', label: 'Deposit', icon: PiggyBank, open: win('makeDeposit') },
        { id: 'wc', label: 'Write a check', icon: FileSpreadsheet, open: win('writeCheck') },
        { id: 'pc', label: 'Print checks', icon: Printer, open: win('printChecks') },
        { id: 'cc', label: 'Card charge', icon: CreditCard, open: win('ccCharge') },
        { id: 'bi', label: 'Import bank activity', icon: ArrowDownToLine, open: win('bankFeeds') },
        { id: 'rec', label: 'Reconcile', icon: Landmark, open: win('reconcileBegin') },
        { id: 'reg', label: 'Bank register', icon: BookOpen, open: onCheckRegister },
      ],
    },
    {
      key: 'books',
      title: 'Books',
      sub: 'Accounts, products and reports',
      icon: ChartColumn,
      fg: '#6d28d9',
      bg: '#ede9fe',
      tasks: [
        { id: 'coa', label: 'Chart of accounts', icon: ListTree, open: win('chartOfAccounts') },
        { id: 'items', label: 'Products and services', icon: Package, open: win('itemList') },
        ...only(inv, { id: 'ia', label: 'Adjust inventory', icon: ClipboardList, open: win('inventoryAdjust') }),
        { id: 'je', label: 'Journal entry', icon: NotebookPen, open: win('journalEntry') },
        { id: 'cal', label: 'Calendar', icon: CalendarDays, open: win('calendar') },
        { id: 'rep', label: 'Reports', icon: ChartColumn, open: win('reportCenter') },
      ],
    },
  ];

  return (
    <div className="cx-tasks">
      {cards.map((c) => (
        <Card key={c.key} card={c} />
      ))}
    </div>
  );
}

function Card({ card }: { card: TaskCard }) {
  const Icon = card.icon;
  const colors = { '--cx-task-fg': card.fg, '--cx-task-bg': card.bg } as CSSProperties;
  return (
    <section className="cx-task-card" style={colors} aria-label={card.title}>
      <div className="cx-task-head">
        <span className="cx-task-headicon" aria-hidden="true">
          <Icon size={16} strokeWidth={2} />
        </span>
        <div>
          <div className="cx-task-title">{card.title}</div>
          <div className="cx-task-sub">{card.sub}</div>
        </div>
      </div>
      <ol className="cx-task-steps">
        {card.tasks.map((t) => {
          const TIcon = t.icon;
          return (
            <li key={t.id}>
              <button type="button" className="cx-task-step" onClick={t.open} title={t.title ?? t.label}>
                <span className="cx-task-icon" aria-hidden="true">
                  <TIcon size={15} strokeWidth={1.9} />
                </span>
                <span className="cx-task-label">{t.label}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

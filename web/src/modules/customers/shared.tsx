// Shared helpers of the Customers module: customer defaults for sales forms, due dates from
// terms, small data hooks and labels.
import { cloneElement, isValidElement, useId, type ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { useAccountsById, useList, useNames } from '@/api/hooks';
import type { Address, ID, Item, ListEntry, Name, Prefs, TermsData, Txn, TxnLine, TxnType } from '@/api/types';
import { formatAddress } from '@/components/inputs';
import { TxnHeaderField, type TxnHeaderFieldProps } from '@/forms';
import { addDate, addDays } from '@/util/dates';
import { fmtMoney } from '@/util/format';
import './customers.css';

/** One customer or job (GET /names/{id}); disabled when id is empty. */
export function useName(id: ID | null | undefined) {
  return useQuery({
    queryKey: ['name', id ?? 0],
    queryFn: ({ signal }) => api.get<Name>(`/names/${id}`, { signal }),
    enabled: !!id,
  });
}

/** Every customer and job (active and inactive), cached by the pickers too. */
export function useCustomers() {
  return useNames('customer', { active: 'all' });
}

/** "$1,234.56" (minus sign for negatives). */
export function money$(n: number | null | undefined): string {
  if (n === null || n === undefined) return '';
  return (n < 0 ? '-$' : '$') + fmtMoney(Math.abs(n));
}

function sameText(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();
}

function hasAddress(a: Address | null | undefined): boolean {
  return !!a && !!(a.line1 || a.line2 || a.line3 || a.city || a.state || a.zip || a.country);
}

/** The person or company line of an address block (company name, else first + last name, else the list name). */
export function addresseeOf(n: Name): string {
  const person = [n.salutation, n.firstName, n.middleName, n.lastName].filter(Boolean).join(' ');
  return n.companyName || person || n.name;
}

/** The top customer of a job (or the name itself). */
export function topCustomer(n: Name, all: readonly Name[] | undefined): Name {
  let cur = n;
  for (let i = 0; i < 10 && cur.parentId; i++) {
    const p = all?.find((x) => x.id === cur.parentId);
    if (!p) break;
    cur = p;
  }
  return cur;
}

/** Customer defaults copied into a sales form when the CUSTOMER OR JOB changes. */
export interface CustomerDefaults {
  billAddress: string;
  shipAddress: string;
  termsId: ID | null;
  repId: ID | null;
  taxItemId: ID | null;
  paymentMethodId: ID | null;
  /** Customer is taxable (tax code "Tax"). */
  taxable: boolean;
}

/**
 * Defaults of a customer or job for sales forms. A job uses its own address, terms, rep and tax
 * settings and falls back to its customer's when they are empty (jobs inherit them).
 */
export function customerDefaults(n: Name, all: readonly Name[] | undefined, prefs: Prefs): CustomerDefaults {
  const chain: Name[] = [n];
  let cur = n;
  for (let i = 0; i < 10 && cur.parentId; i++) {
    const p = all?.find((x) => x.id === cur.parentId);
    if (!p) break;
    chain.push(p);
    cur = p;
  }
  const pick = <K extends keyof Name>(k: K): Name[K] | null => {
    for (const c of chain) if (c[k] !== null && c[k] !== undefined && c[k] !== '') return c[k];
    return null;
  };
  const billOwner = chain.find((c) => hasAddress(c.billAddress)) ?? n;
  const shipOwner = chain.find((c) => hasAddress(c.shipAddress));
  const top = chain[chain.length - 1];
  const addressee = addresseeOf(n.parentId ? top : n);
  const block = (a: Address) => formatAddress(sameText(a.line1, addressee) ? null : addressee, a);
  const bill = block(billOwner.billAddress);
  const ship = shipOwner ? block(shipOwner.shipAddress) : bill;
  return {
    billAddress: bill,
    shipAddress: ship,
    termsId: (pick('termsId') as ID | null) ?? null,
    repId: (pick('repId') as ID | null) ?? null,
    taxItemId: (pick('taxItemId') as ID | null) ?? prefs.defaultSalesTaxItemId ?? null,
    paymentMethodId: (pick('paymentMethodId') as ID | null) ?? null,
    taxable: n.taxable,
  };
}

/** A line is taxable when its item is taxable and the customer is taxable (taxable / non-taxable tax codes). */
export function lineTaxable(item: Item | undefined, customerTaxable: boolean): boolean {
  if (!item) return false;
  if (item.type === 'Subtotal' || item.type === 'Payment' || item.type === 'Sales Tax Item' || item.type === 'Sales Tax Group' || item.type === 'Group') return false;
  return !!item.taxable && customerTaxable;
}

/** Recomputes the TAX column of every line after the customer (or its tax code) changed. */
export function retaxLines(lines: TxnLine[], itemsById: Map<ID, Item>, customerTaxable: boolean): TxnLine[] {
  return lines.map((l) => {
    if (!l.itemId) return l;
    const t = lineTaxable(itemsById.get(l.itemId), customerTaxable);
    return t === l.taxable ? l : { ...l, taxable: t };
  });
}

/** Due date from terms, exactly like the server (standard: date + net days; date driven: due day). */
export function dueDateFromTerms(date: string, terms: ListEntry | null | undefined): string {
  if (!date) return '';
  if (!terms) return date;
  const d = (terms.data ?? {}) as TermsData;
  if (!d.dateDriven) return addDays(date, Number(d.netDays ?? 0));
  const day = Math.max(1, Number(d.dueDay ?? 1));
  const within = Number(d.dueNextMonthDays ?? 0);
  const dayOf = (iso: string) => {
    const first = iso.slice(0, 8) + '01';
    const last = +addDate(first, 0, 1, -1).slice(8, 10);
    return first.slice(0, 8) + String(Math.min(day, last)).padStart(2, '0');
  };
  let due = dayOf(date);
  const until = Math.round((Date.parse(due) - Date.parse(date)) / 86400000);
  if (until < 0 || (within > 0 && until <= within)) due = dayOf(addDate(date.slice(0, 8) + '01', 0, 1, 0));
  return due;
}

/** Terms list (for due dates). */
export function useTerms() {
  return useList('terms', { active: 'all' }).data;
}

/** Friendly names of customer transaction types (menus, lists). */
export const CUSTOMER_TXN_LABELS: Partial<Record<TxnType, string>> = {
  EST: 'Estimate',
  INV: 'Invoice',
  STMTCHG: 'Statement Charge',
  SALESRCPT: 'Sales Receipt',
  PMT: 'Payment',
  CREDMEM: 'Credit Memo',
  REFUND: 'Refund',
  GENJRNL: 'General Journal',
};

/** Customer transaction types shown in the Customer Center. */
export const CUSTOMER_TXN_TYPES: TxnType[] = ['EST', 'INV', 'STMTCHG', 'SALESRCPT', 'PMT', 'CREDMEM', 'REFUND'];

/** Is an open invoice / statement charge past due as of `today`? */
export function isOverdue(t: { type: TxnType; dueDate: string; date: string; openBalance: number; voided?: boolean; isPending?: boolean }, today: string): boolean {
  if (t.voided || t.isPending) return false;
  if (t.type !== 'INV' && t.type !== 'STMTCHG') return false;
  if (t.openBalance <= 0) return false;
  const due = t.dueDate || t.date;
  return due < today;
}

/** Days between due date and today (positive when overdue). */
export function daysOverdue(due: string, today: string): number {
  return Math.round((Date.parse(today) - Date.parse(due)) / 86400000);
}

/** Display status of a customer transaction summary row. */
export function displayStatus(r: { type: TxnType; status: string; voided: boolean; isPending: boolean; openBalance: number; amount: number; dueDate: string; date: string }, today: string): string {
  if (r.voided) return 'Void';
  if (r.isPending) return 'Pending';
  switch (r.type) {
    case 'INV':
    case 'STMTCHG':
      if (r.openBalance <= 0 && r.amount > 0) return 'Paid';
      if (isOverdue(r, today)) return 'Overdue';
      if (r.openBalance < r.amount) return 'Partially paid';
      return 'Open';
    case 'EST':
      return r.status || 'Pending';
    case 'CREDMEM':
      if (r.openBalance > 0) return r.openBalance < r.amount ? 'Partially applied' : 'Unapplied';
      return 'Applied';
    case 'PMT':
      if (r.openBalance > 0) return r.openBalance < r.amount ? 'Partially applied' : 'Unapplied';
      return 'Closed';
    case 'SALESRCPT':
      return 'Paid';
    case 'REFUND':
      return 'Paid';
    default:
      return r.status;
  }
}

/** Quick lookup of a Txn's ref for messages: "Invoice #1042". */
export function refText(t: Pick<Txn, 'refNumber'>, label: string): string {
  return t.refNumber ? `${label} #${t.refNumber}` : label;
}

/** Id of the Undeposited Funds account (null while loading or when missing). */
export function useUndepositedFundsId(): ID | null {
  const map = useAccountsById();
  for (const a of map.values()) if (a.special === 'UndepositedFunds') return a.id;
  return null;
}

/** "DUE DATE" → "Due date", "P.O. NO." → "P.O. no.", "A/R ACCOUNT" → "A/R account" (accessible names). */
export function labelText(label: string): string {
  const keep = (w: string) => /^([A-Z]\.)+$/.test(w) || w.includes('/');
  const text = label
    .trim()
    .split(/\s+/)
    .map((w) => (keep(w) ? w : w.toLowerCase()))
    .join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * A form header field whose label names its control: the control gets an id unique to the window
 * (clicking the label focuses it) and, for a text label, an aria-label in plain case ("Due date"),
 * so screen readers do not read the help button or the required mark as part of the name.
 */
export function HeaderField(props: TxnHeaderFieldProps) {
  const autoId = useId();
  const child = props.children;
  if (props.htmlFor || !isValidElement(child)) return <TxnHeaderField {...props} />;
  const el = child as ReactElement<{ id?: string; 'aria-label'?: string }>;
  const id = el.props.id ?? autoId;
  const aria = el.props['aria-label'] ?? (typeof props.label === 'string' ? labelText(props.label) : undefined);
  return (
    <TxnHeaderField {...props} htmlFor={id}>
      {cloneElement(el, { id, 'aria-label': aria })}
    </TxnHeaderField>
  );
}

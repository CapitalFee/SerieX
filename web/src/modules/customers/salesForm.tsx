// Shared logic and parts of the sales forms (Create Invoices, Enter Sales Receipts, Create
// Credit Memos, Create Estimates): customer defaults, totals (computeSales), preparation and
// validation before saving, and the CUSTOMER MESSAGE / MEMO / TAX footer.
import { useMemo, useRef } from 'react';
import { api } from '@/api/client';
import { DEFAULT_PREFS, queryClient, useItemsById } from '@/api/hooks';
import { emptyLine, emptyTxn, type ID, type Item, type Name, type Prefs, type Txn, type TxnLine, type TxnType } from '@/api/types';
import { CustomerMessagePicker, ItemPicker, NamePicker, TextField, msgBox } from '@/components';
import { computeSales, stripEmptyLines, taxRateOf, TotalsBlock, type SalesCalcResult, type TotalsRow, type TxnForm, type TxnProblem } from '@/forms';
import { todayIso } from '@/util/dates';
import { fmtQty, round2 } from '@/util/format';
import { customerDefaults, dueDateFromTerms, HeaderField, retaxLines, useCustomers, useTerms } from './shared';

/** Preferences, fetched (cached) — for makeNew functions that run before the hooks have data. */
export async function loadPrefs(): Promise<Prefs> {
  try {
    const p = await queryClient.fetchQuery({ queryKey: ['prefs'], queryFn: () => api.get<Prefs>('/prefs'), staleTime: 60_000 });
    return { ...DEFAULT_PREFS, ...p };
  } catch {
    return DEFAULT_PREFS;
  }
}

/** Every customer (cached), for makeNew functions. */
export async function loadCustomers(): Promise<Name[]> {
  try {
    return await queryClient.fetchQuery({ queryKey: ['names', 'customer', { active: 'all' }], queryFn: () => api.get<Name[]>('/names?kind=customer&active=all'), staleTime: 30_000 });
  } catch {
    return [];
  }
}

/** Every item (cached), for makeNew functions. */
export async function loadItemsById(): Promise<Map<ID, Item>> {
  try {
    const items = await queryClient.fetchQuery({ queryKey: ['items', { active: 'all' }], queryFn: () => api.get<Item[]>('/items?active=all'), staleTime: 30_000 });
    return new Map(items.map((i) => [i.id, i]));
  } catch {
    return new Map();
  }
}

/** Next number the server would give a new transaction of this type ('' when none). */
export async function nextRef(type: TxnType, accountId?: ID | null): Promise<string> {
  try {
    const r = await api.get<{ refNumber: string }>(`/next-ref?type=${type}${accountId ? `&accountId=${accountId}` : ''}`);
    return r.refNumber ?? '';
  } catch {
    return '';
  }
}

/** Applies a customer's defaults (addresses, terms, rep, tax item, line tax codes) to a transaction. */
export function withCustomer(t: Txn, n: Name, all: readonly Name[] | undefined, prefs: Prefs, itemsById: Map<ID, Item>, opts: { terms?: Parameters<typeof dueDateFromTerms>[1][] } = {}): Txn {
  const d = customerDefaults(n, all, prefs);
  const next: Txn = {
    ...t,
    nameId: n.id,
    nameFull: n.fullName,
    billAddress: d.billAddress,
    shipAddress: d.shipAddress,
    repId: d.repId ?? t.repId,
    taxItemId: prefs.salesTaxEnabled ? d.taxItemId ?? t.taxItemId : t.taxItemId,
    lines: retaxLines(t.lines, itemsById, d.taxable),
  };
  if (t.type === 'INV' || t.type === 'EST' || t.type === 'STMTCHG') next.termsId = d.termsId;
  if (t.type === 'SALESRCPT' && d.paymentMethodId) next.paymentMethodId = d.paymentMethodId;
  if (t.type === 'INV') {
    const term = d.termsId ? opts.terms?.find((x) => x && x.id === d.termsId) : null;
    next.dueDate = dueDateFromTerms(t.date, term ?? null);
  }
  return next;
}

/** A blank sales transaction with the company defaults (tax item, ship via, F.O.B., template). */
export function blankSales(type: TxnType, prefs: Prefs): Txn {
  const t = emptyTxn(type, todayIso());
  t.taxItemId = prefs.salesTaxEnabled ? prefs.defaultSalesTaxItemId : null;
  if (type === 'INV') {
    t.template = prefs.defaultInvoiceTemplate || 'Product Invoice';
    t.shipViaId = prefs.defaultShipViaId;
    t.fob = prefs.defaultFob;
  }
  return t;
}

/** Applies props.template (memorized transactions, copies) to a blank transaction. */
export function fromTemplate(tpl: Txn): Txn {
  return {
    ...tpl,
    id: 0,
    date: tpl.date || todayIso(),
    status: tpl.type === 'EST' ? 'Pending' : '',
    voided: false,
    openBalance: 0,
    links: [],
    linked: [],
    lines: (tpl.lines ?? []).map((l, i) => ({ ...l, id: 0, seq: i + 1, linkedTxnId: null, linkedLineId: null, billedTxnId: null })),
  };
}

/** Lines prepared for saving: empty lines dropped, subtotal/percent lines computed, renumbered. */
export function prepareSales(t: Txn, itemsById: Map<ID, Item>, taxRatePct: number): Txn {
  const s = stripEmptyLines(t);
  const items = s.lines.filter((l) => l.kind === 'item');
  const calc = computeSales(items, itemsById, taxRatePct);
  return { ...s, lines: calc.lines.map((l, i) => ({ ...l, seq: i + 1 })), amount: calc.total };
}

/** Client checks of a sales form (the server checks the rest). */
export function validateSales(t: Txn, calc: SalesCalcResult, opts: { noun: string; requireLines?: boolean }): TxnProblem[] {
  const out: TxnProblem[] = [];
  const lines = t.lines.filter((l) => l.kind === 'item');
  if (opts.requireLines !== false && lines.length === 0) out.push({ field: 'lines', message: `Add at least one line to the ${opts.noun}.` });
  lines.forEach((l, i) => {
    if (l.itemId || l.accountId) return;
    if (l.amount) out.push({ field: 'lines', message: `Line ${i + 1} has an amount but no item. Choose an item for it.` });
    // a quantity or rate without an item would be saved (and printed) as a stray line
    else if (l.qty || l.rate) out.push({ field: 'lines', message: `Line ${i + 1}: choose an item (or clear its quantity and rate).` });
  });
  if (calc.total < 0) out.push({ field: 'lines', message: `The total of the ${opts.noun} cannot be negative.` });
  return out;
}

/** Sales tax is on, some lines are marked taxable, but no tax item is chosen (so no tax is charged). */
export function salesTaxMissing(t: Txn, prefs: Prefs): boolean {
  return prefs.salesTaxEnabled && !t.taxItemId && t.lines.some((l) => l.kind === 'item' && l.taxable && !!l.itemId && !!l.amount);
}

/**
 * validateSales, then — when nothing else is wrong — asks about taxable lines without a sales tax
 * item: "Choose a tax item" (the default) keeps the form open with the Tax field marked, "Save
 * without tax" saves it as it is.
 */
export async function validateSalesForm(t: Txn, calc: SalesCalcResult, prefs: Prefs, opts: { noun: string; requireLines?: boolean }): Promise<TxnProblem[]> {
  const out = validateSales(t, calc, opts);
  if (out.length || !salesTaxMissing(t, prefs)) return out;
  const r = await msgBox({
    title: 'No Sales Tax Item',
    message: `This ${opts.noun} has taxable lines but no sales tax item, so no tax is charged.\n\nChoose a tax item, or save the ${opts.noun} without sales tax?`,
    buttons: ['Choose a tax item', 'Save without tax'],
    defaultButton: 'Choose a tax item',
    cancelButton: 'Choose a tax item',
    icon: 'warning',
  });
  return r === 'Save without tax' ? [] : [{ field: 'taxItemId', message: 'Choose a sales tax item: some lines are marked "Tax".' }];
}

/** Everything a sales form needs to show and edit its lines, customer and totals. */
export interface SalesState {
  prefs: Prefs;
  itemsById: Map<ID, Item>;
  customers: Name[] | undefined;
  customer: Name | null;
  customerTaxable: boolean;
  taxRate: number;
  taxItem: Item | undefined;
  calc: SalesCalcResult;
  /** Item lines with computed amounts (subtotals, percents). */
  lines: TxnLine[];
  setLines(lines: TxnLine[]): void;
  /** Picks a customer/job and copies its defaults. */
  setCustomer(id: ID | null, rec: Name | null): void;
  /** Changes the date (and the due date of invoices). */
  setDate(date: string): void;
  /** Changes the terms (and the due date of invoices). */
  setTerms(id: ID | null): void;
  /** Ref for prepare(): latest itemsById and tax rate. */
  prepare(t: Txn): Txn;
}

/** Shared state of a sales form (call after useTxnForm). */
export function useSalesState(form: TxnForm): SalesState {
  const prefs = form.prefs;
  const itemsById = useItemsById();
  const customers = useCustomers().data;
  const terms = useTerms();
  const t = form.txn;
  const customer = useMemo(() => customers?.find((c) => c.id === t.nameId) ?? null, [customers, t.nameId]);
  const customerTaxable = customer ? customer.taxable : true;
  const tax = prefs.salesTaxEnabled ? taxRateOf(t.taxItemId, itemsById) : { rate: 0, members: [] };
  const taxItem = t.taxItemId ? itemsById.get(t.taxItemId) : undefined;
  const itemLines = useMemo(() => t.lines.filter((l) => l.kind === 'item'), [t.lines]);
  const calc = useMemo(() => computeSales(itemLines, itemsById, tax.rate), [itemLines, itemsById, tax.rate]);
  const ref = useRef({ itemsById, rate: tax.rate });
  ref.current = { itemsById, rate: tax.rate };

  const setCustomer = (id: ID | null, rec: Name | null) => {
    if (!id || !rec) {
      form.update({ nameId: id, nameFull: '' });
      return;
    }
    form.setTxn((cur) => withCustomer(cur, rec, customers, prefs, itemsById, { terms: terms ?? [] }));
  };
  const setDate = (date: string) => {
    form.setTxn((cur) => {
      const n: Txn = { ...cur, date };
      if (cur.type === 'INV' && date) n.dueDate = dueDateFromTerms(date, terms?.find((x) => x.id === cur.termsId) ?? null);
      return n;
    });
  };
  const setTerms = (id: ID | null) => {
    form.setTxn((cur) => {
      const n: Txn = { ...cur, termsId: id };
      if (cur.type === 'INV' && cur.date) n.dueDate = dueDateFromTerms(cur.date, terms?.find((x) => x.id === id) ?? null);
      return n;
    });
  };
  const setLines = (lines: TxnLine[]) => {
    form.setTxn((cur) => ({ ...cur, lines: [...lines, ...cur.lines.filter((l) => l.kind !== 'item')] }));
  };
  return {
    prefs,
    itemsById,
    customers,
    customer,
    customerTaxable,
    taxRate: tax.rate,
    taxItem,
    calc,
    lines: calc.lines,
    setLines,
    setCustomer,
    setDate,
    setTerms,
    prepare: (x: Txn) => prepareSales(x, ref.current.itemsById, ref.current.rate),
  };
}

/** Props of {@link CustomerField}. */
export interface CustomerFieldProps {
  form: TxnForm;
  sales: SalesState;
  label?: string;
  width?: number | string;
  required?: boolean;
  autoFocus?: boolean;
  help?: string;
}

/** CUSTOMER OR JOB picker of a sales form (copies the customer's defaults when changed). */
export function CustomerField({ form, sales, label = 'CUSTOMER OR JOB', width = 300, required, autoFocus, help = 'Customer or Job' }: CustomerFieldProps) {
  return (
    <HeaderField label={label} width={width} required={required} help={help}>
      <NamePicker
        name="nameId"
        kinds={['customer']}
        value={form.txn.nameId}
        fallbackLabel={form.txn.nameFull}
        autoFocus={autoFocus}
        aria-label="Customer or job"
        onChange={(id, rec) => sales.setCustomer(id, rec)}
        readOnly={form.txn.voided}
      />
    </HeaderField>
  );
}

/** Props of {@link SalesFooter}. */
export interface SalesFooterProps {
  form: TxnForm;
  sales: SalesState;
  /** Show CUSTOMER MESSAGE (default true). */
  showMessage?: boolean;
  /** Rows after the tax row (e.g. Total). */
  rows?: TotalsRow[];
  memoPlaceholder?: string;
}

/** Footer of the sales forms: customer message + memo on the left, subtotal / tax (picker) / totals on the right. */
export function SalesFooter({ form, sales, showMessage = true, rows = [], memoPlaceholder }: SalesFooterProps) {
  const t = form.txn;
  const ro = t.voided;
  const taxRows: TotalsRow[] = sales.prefs.salesTaxEnabled
    ? [
        { key: 'sub', label: 'Subtotal', value: sales.calc.subtotal },
        {
          key: 'tax',
          label: 'Tax',
          control: (
            <span className="sx-cust-taxctl">
              <ItemPicker
                name="taxItemId"
                compact
                types={['Sales Tax Item', 'Sales Tax Group']}
                value={t.taxItemId}
                width={160}
                listWidth={260}
                aria-label="Sales tax item"
                onChange={(id) => form.update({ taxItemId: id })}
                readOnly={ro}
              />
              <span className="sx-cust-taxrate">({fmtQty(sales.taxRate)}%)</span>
            </span>
          ),
          value: sales.calc.tax,
        },
      ]
    : [];
  return (
    <>
      <div className="sx-cust-footleft">
        {showMessage && (
          <HeaderField label="CUSTOMER MESSAGE" width={300} help="A note printed at the bottom of the form for the customer.">
            <CustomerMessagePicker name="customerMessageId" value={t.customerMessageId} onChange={(id) => form.update({ customerMessageId: id })} readOnly={ro} />
          </HeaderField>
        )}
        <HeaderField label="MEMO" width={300} help="Memo">
          <TextField name="memo" value={t.memo} placeholder={memoPlaceholder} onChange={(v) => form.update({ memo: v })} readOnly={ro} />
        </HeaderField>
      </div>
      {taxRows.length + rows.length > 0 && (
        <div className="sx-cust-totalscol">
          <TotalsBlock className="sx-cust-totals" rows={[...taxRows, ...rows]} />
          {!ro && salesTaxMissing({ ...t, lines: sales.lines }, sales.prefs) && (
            <div className="sx-cust-taxwarn" role="status">
              Some lines are marked &quot;Tax&quot; but no sales tax item is chosen, so no tax is charged. Choose a tax item.
            </div>
          )}
        </div>
      )}
    </>
  );
}

/** Blank item line helper (kept for callers building lines programmatically). */
export function itemLine(patch: Partial<TxnLine> = {}): TxnLine {
  return { ...emptyLine('item'), ...patch };
}

/** round2 of a payments-applied amount (amount − open balance) of a saved document. */
export function paymentsApplied(t: Txn | null): number {
  if (!t || !t.id || t.voided || t.isPending) return 0;
  return round2(t.amount - t.openBalance);
}

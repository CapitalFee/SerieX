// Printed layouts of the customer forms (invoice, sales receipt, credit memo, estimate) and of
// customer statements, rendered with util/print's printHtml.
import { api } from '@/api/client';
import { queryClient } from '@/api/hooks';
import type { CompanyInfo, ID, Item, ListEntry, Statement, Txn } from '@/api/types';
import { escHtml, printHtml } from '@/util/print';
import { fmtDate, fmtMoney, fmtQty } from '@/util/format';
import { computeSales, taxRateOf } from '@/forms';
import { fmtRate } from './SalesLinesGrid';

const esc = (s: string | null | undefined) => escHtml(s ?? '');
const usd = (n: number) => (n < 0 ? '-$' : '$') + fmtMoney(Math.abs(n));
const nl2br = (s: string | null | undefined) => esc(s).replace(/\n/g, '<br>');

/** Company information (cached). */
export async function companyInfo(): Promise<CompanyInfo | null> {
  try {
    return await queryClient.fetchQuery({ queryKey: ['company'], queryFn: () => api.get<CompanyInfo>('/company'), staleTime: 60_000 });
  } catch {
    return null;
  }
}

async function listOf(list: string): Promise<ListEntry[]> {
  try {
    return await queryClient.fetchQuery({ queryKey: ['list', list], queryFn: () => api.get<ListEntry[]>(`/lists/${list}?active=all`), staleTime: 60_000 });
  } catch {
    return [];
  }
}

function companyBlock(c: CompanyInfo | null): string {
  if (!c) return '';
  const city = [c.city, [c.state, c.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const lines = [c.legalName && c.legalName !== c.name ? c.legalName : '', c.address1, c.address2, city, c.phone ? 'Phone ' + c.phone : '', c.email].filter(Boolean);
  return `<div class="co"><div class="co-name">${esc(c.name)}</div>${lines.map((l) => `<div>${esc(l)}</div>`).join('')}</div>`;
}

const FORM_CSS = `
  .hdr { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 18px; }
  .co-name { font-size: 15px; font-weight: bold; margin-bottom: 2px; }
  .title { text-align: right; }
  .title h1 { font-size: 24px; margin: 0 0 6px; letter-spacing: 0.02em; }
  .meta { border-collapse: collapse; margin-left: auto; width: auto; }
  .meta th, .meta td { border: 1px solid #000; padding: 2px 8px; text-align: center; font-size: 11px; }
  .meta th { background: #eee; }
  .addr { display: flex; gap: 24px; margin-bottom: 12px; }
  .addr .box { border: 1px solid #000; min-width: 240px; min-height: 80px; }
  .addr .box .lbl { background: #eee; border-bottom: 1px solid #000; padding: 2px 6px; font-weight: bold; }
  .addr .box .txt { padding: 4px 6px; }
  .fields { border-collapse: collapse; margin-bottom: 8px; }
  .fields th, .fields td { border: 1px solid #000; padding: 2px 6px; text-align: center; font-size: 11px; }
  .fields th { background: #eee; }
  .lines { border: 1px solid #000; }
  .lines th { background: #eee; border: 1px solid #000; text-align: center; }
  .lines td { border-left: 1px solid #000; border-right: 1px solid #000; }
  .lines tr.fill td { height: 120px; }
  .tot { margin-left: auto; margin-top: 8px; width: 300px; border-collapse: collapse; }
  .tot td { padding: 3px 6px; }
  .tot tr.big td { font-weight: bold; font-size: 13px; border-top: 1px solid #000; }
  .msg { margin-top: 10px; }
  .stamp { position: absolute; top: 200px; left: 260px; transform: rotate(-12deg); border: 3px solid #b91c1c; color: #b91c1c; font-size: 36px; font-weight: 800; padding: 2px 18px; opacity: .45; }
`;

/** Options of {@link printSalesForm}. */
export interface PrintSalesOptions {
  /** Big title ("Invoice", "Sales Receipt", "Credit Memo", "Estimate"). */
  title: string;
  /** Label of the number box ("Invoice #"). */
  numberLabel: string;
  itemsById: Map<ID, Item>;
  taxEnabled: boolean;
  /** Payments/credits already applied (invoices). */
  paymentsApplied?: number;
  /** Label of the last total ("Balance Due", "Total", "Total Credit"). */
  balanceLabel?: string;
  stamp?: string | null;
}

/** Prints a sales form in its layout (invoices: Standard, Services or Services with Dates). */
export async function printSalesForm(t: Txn, o: PrintSalesOptions): Promise<void> {
  const [co, terms, reps, vias, msgs, methods] = await Promise.all([companyInfo(), listOf('terms'), listOf('sales_rep'), listOf('ship_via'), listOf('customer_message'), listOf('payment_method')]);
  const rate = o.taxEnabled ? taxRateOf(t.taxItemId, o.itemsById).rate : 0;
  const calc = computeSales(t.lines, o.itemsById, rate);
  const taxItem = t.taxItemId ? o.itemsById.get(t.taxItemId) : undefined;
  const nameOf = (list: ListEntry[], id: ID | null) => (id ? list.find((x) => x.id === id)?.name ?? '' : '');
  const repOf = (id: ID | null) => {
    const r = id ? reps.find((x) => x.id === id) : undefined;
    return r ? (r.data?.initials as string) || r.name : '';
  };
  const product = t.type === 'INV' && t.template === 'Product Invoice';
  const professional = t.type === 'INV' && t.template === 'Professional Invoice';
  const fields: [string, string][] = [];
  if (t.type === 'INV') {
    fields.push(['P.O. No.', t.poNumber], ['Terms', nameOf(terms, t.termsId)], ['Due Date', fmtDate(t.dueDate)]);
    if (!professional) fields.push(['Rep', repOf(t.repId)]);
    if (product) fields.push(['Ship Date', fmtDate(t.shipDate)], ['Shipped By', nameOf(vias, t.shipViaId)], ['F.O.B.', t.fob]);
  } else if (t.type === 'SALESRCPT') {
    fields.push(['Check No.', String(t.extra?.checkNumber ?? '')], ['Payment Method', nameOf(methods, t.paymentMethodId)]);
  } else if (t.type === 'CREDMEM') {
    fields.push(['P.O. No.', t.poNumber]);
  }
  const shownFields = fields.filter(([, v]) => v !== undefined);
  const lineRows = calc.lines
    .map((l) => {
      const it = l.itemId ? o.itemsById.get(l.itemId) : undefined;
      const sub = it?.type === 'Subtotal';
      return `<tr${sub ? ' class="bold"' : ''}>
        ${professional ? `<td>${esc(fmtDate(l.serviceDate))}</td>` : ''}
        <td>${esc(it?.fullName ?? '')}</td>
        <td>${nl2br(l.description)}</td>
        <td class="num">${esc(fmtQty(l.qty))}</td>
        <td class="num">${esc(fmtRate(l))}</td>
        <td class="num">${l.itemId || l.amount ? esc(fmtMoney(l.amount)) : ''}</td>
        ${o.taxEnabled ? `<td class="center">${l.taxable ? 'T' : ''}</td>` : ''}
      </tr>`;
    })
    .join('');
  const cols = (professional ? 1 : 0) + 5 + (o.taxEnabled ? 1 : 0);
  const applied = o.paymentsApplied ?? 0;
  const tot: [string, number, boolean?][] = [];
  if (o.taxEnabled && (calc.tax || taxItem)) {
    tot.push(['Subtotal', calc.subtotal]);
    tot.push([`Sales Tax${taxItem ? ` (${fmtQty(rate)}%)` : ''}`, calc.tax]);
  }
  if (t.type === 'INV') {
    tot.push(['Total', calc.total]);
    tot.push(['Payments/Credits', -applied]);
    tot.push([o.balanceLabel ?? 'Balance Due', calc.total - applied, true]);
  } else tot.push([o.balanceLabel ?? 'Total', calc.total, true]);
  const msg = nameOf(msgs, t.customerMessageId);
  const body = `
    ${o.stamp ? `<div class="stamp">${esc(o.stamp)}</div>` : ''}
    <div class="hdr">${companyBlock(co)}
      <div class="title"><h1>${esc(o.title)}</h1>
        <table class="meta"><tr><th>Date</th><th>${esc(o.numberLabel)}</th></tr><tr><td>${esc(fmtDate(t.date))}</td><td>${esc(t.refNumber)}</td></tr></table>
      </div>
    </div>
    <div class="addr">
      <div class="box"><div class="lbl">${t.type === 'EST' ? 'Name / Address' : t.type === 'CREDMEM' ? 'Customer' : t.type === 'SALESRCPT' ? 'Sold To' : 'Bill To'}</div><div class="txt">${nl2br(t.billAddress || t.nameFull)}</div></div>
      ${product ? `<div class="box"><div class="lbl">Ship To</div><div class="txt">${nl2br(t.shipAddress)}</div></div>` : ''}
    </div>
    ${shownFields.length ? `<table class="fields"><tr>${shownFields.map(([k]) => `<th>${esc(k)}</th>`).join('')}</tr><tr>${shownFields.map(([, v]) => `<td>${esc(v) || '&nbsp;'}</td>`).join('')}</tr></table>` : ''}
    <table class="lines">
      <thead><tr>${professional ? '<th style="width:70px">Serviced</th>' : ''}<th style="width:120px">Item</th><th>Description</th><th style="width:50px">Qty</th><th style="width:70px">Rate</th><th style="width:80px">Amount</th>${o.taxEnabled ? '<th style="width:30px">Tax</th>' : ''}</tr></thead>
      <tbody>${lineRows}<tr class="fill">${'<td></td>'.repeat(cols)}</tr></tbody>
    </table>
    <table class="tot">${tot.map(([k, v, big]) => `<tr${big ? ' class="big"' : ''}><td>${esc(k)}</td><td class="num">${esc(usd(v))}</td></tr>`).join('')}</table>
    ${msg ? `<div class="msg">${esc(msg)}</div>` : ''}
  `;
  await printHtml(`${o.title} ${t.refNumber}`.trim(), `<div style="position:relative">${body}</div>`, FORM_CSS);
}

const STMT_CSS =
  FORM_CSS +
  `
  .aging { border-collapse: collapse; margin-top: 12px; }
  .aging th, .aging td { border: 1px solid #000; padding: 3px 8px; text-align: center; font-size: 11px; }
  .aging th { background: #eee; }
  .due { margin-top: 10px; text-align: right; font-size: 13px; font-weight: bold; }
  .stmt-lines td.num { white-space: nowrap; }
`;

/** HTML of statements (one page per customer). */
export function statementsHtml(list: Statement[], co: CompanyInfo | null): string {
  return list
    .map((s, i) => {
      const rows = s.rows
        .map(
          (r) => `<tr><td>${esc(fmtDate(r.date))}</td><td>${esc(r.description)}</td><td class="num">${esc(fmtMoney(r.amount))}</td><td class="num">${esc(fmtMoney(r.balance))}</td></tr>`,
        )
        .join('');
      const opening = s.from ? `<tr><td>${esc(fmtDate(s.from))}</td><td>Balance forward</td><td></td><td class="num">${esc(fmtMoney(s.openingBalance))}</td></tr>` : '';
      return `<div class="${i < list.length - 1 ? 'page-break' : ''}">
        <div class="hdr">${companyBlock(co)}
          <div class="title"><h1>Statement</h1>
            <table class="meta"><tr><th>Date</th></tr><tr><td>${esc(fmtDate(s.statementDate))}</td></tr></table>
          </div>
        </div>
        <div class="addr"><div class="box"><div class="lbl">To</div><div class="txt">${nl2br(s.billAddress || s.customer.fullName)}</div></div>
          <div style="margin-left:auto;align-self:flex-end"><table class="fields"><tr><th>Amount Due</th><th>Amount Enc.</th></tr><tr><td>$${esc(fmtMoney(s.amountDue))}</td><td>&nbsp;</td></tr></table></div>
        </div>
        <table class="lines stmt-lines"><thead><tr><th style="width:80px">Date</th><th>Transaction</th><th style="width:90px">Amount</th><th style="width:90px">Balance</th></tr></thead>
          <tbody>${opening}${rows}<tr class="fill"><td></td><td></td><td></td><td></td></tr></tbody></table>
        <table class="aging"><tr><th>Current</th><th>1-30 Days Past Due</th><th>31-60 Days Past Due</th><th>61-90 Days Past Due</th><th>Over 90 Days Past Due</th><th>Amount Due</th></tr>
          <tr><td>${fmtMoney(s.aging.current)}</td><td>${fmtMoney(s.aging.d1_30)}</td><td>${fmtMoney(s.aging.d31_60)}</td><td>${fmtMoney(s.aging.d61_90)}</td><td>${fmtMoney(s.aging.over90)}</td><td><b>$${fmtMoney(s.amountDue)}</b></td></tr></table>
      </div>`;
    })
    .join('');
}

/** Prints statements (one page per customer). */
export async function printStatements(list: Statement[]): Promise<void> {
  const co = await companyInfo();
  await printHtml('Statements', statementsHtml(list, co), STMT_CSS);
}

/** CSS used by the on-screen statement preview (same look as the print). */
export const STATEMENT_PREVIEW_CSS = STMT_CSS;

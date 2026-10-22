// Sales form calculation. The server recomputes the same numbers on save;
// this mirror keeps the totals on screen identical to what will be posted.
import type { ID, Item, TxnLine } from '@/api/types';
import { round2 } from '@/util/format';

/** Items by id: a Map or a plain record. */
export type ItemsById = Map<ID, Item> | Record<ID, Item>;

function itemOf(items: ItemsById, id: ID | null | undefined): Item | undefined {
  if (id === null || id === undefined) return undefined;
  return items instanceof Map ? items.get(id) : items[id];
}

/** Result of {@link computeSales}. */
export interface SalesCalcResult {
  /** Lines with computed amounts for Subtotal and percent (Discount / Other Charge %) lines. */
  lines: TxnLine[];
  /** Σ amounts of all lines except Subtotal and Payment lines. */
  subtotal: number;
  /** Taxable base: Σ amounts of taxable lines (excluding Subtotal and Payment lines). */
  taxable: number;
  /** round(taxable × rate / 100). */
  tax: number;
  /** subtotal + tax + Σ Payment item lines (negative). */
  total: number;
  /** Σ Payment item line amounts (≤ 0). */
  payments: number;
}

/**
 * Computes a sales form exactly like the server does:
 * 1. Subtotal lines = Σ amounts of the preceding non-subtotal lines since the previous Subtotal.
 * 2. Percent lines (`rateIsPercent`) = round(previous line amount × rate / 100); Discount items negative.
 * 3. Other lines keep their amount (qty × rate, computed when the line was edited).
 * 4-6. subtotal, taxable base, tax = round(base × rate / 100), total = subtotal + tax + payments.
 * `taxRatePct` is 0 when there is no tax item or sales tax is off.
 */
export function computeSales(lines: TxnLine[], itemsById: ItemsById, taxRatePct: number): SalesCalcResult {
  const out: TxnLine[] = [];
  let sinceSubtotal = 0;
  let subtotal = 0;
  let taxable = 0;
  let payments = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const item = itemOf(itemsById, l.itemId);
    const type = item?.type;
    let amount = l.amount;
    if (type === 'Subtotal') {
      amount = round2(sinceSubtotal);
      sinceSubtotal = 0;
      out.push(amount === l.amount ? l : { ...l, amount });
      continue;
    }
    if (l.rateIsPercent) {
      const prev = out.length ? out[out.length - 1].amount : 0;
      const raw = round2((prev * (l.rate ?? 0)) / 100);
      amount = type === 'Discount' ? -Math.abs(raw) : raw;
    }
    const line = amount === l.amount ? l : { ...l, amount };
    out.push(line);
    sinceSubtotal += amount;
    if (type === 'Payment') {
      payments += amount;
      continue;
    }
    subtotal += amount;
    if (line.taxable) taxable += amount;
  }
  subtotal = round2(subtotal);
  taxable = round2(taxable);
  payments = round2(payments);
  const tax = taxRatePct ? round2((taxable * taxRatePct) / 100) : 0;
  return { lines: out, subtotal, taxable, tax, total: round2(subtotal + tax + payments), payments };
}

/** One member of a sales tax group (or the single tax item). */
export interface TaxPart {
  itemId: ID;
  rate: number;
  amount: number;
}

/**
 * Tax rate and members of a tax item: a Sales Tax Item gives its own rate; a Sales Tax Group gives
 * the sum of its member items' rates. Unknown/none → rate 0, no members.
 */
export function taxRateOf(taxItemId: ID | null | undefined, itemsById: ItemsById): { rate: number; members: { itemId: ID; rate: number }[] } {
  const item = itemOf(itemsById, taxItemId);
  if (!item) return { rate: 0, members: [] };
  if (item.type === 'Sales Tax Item') return { rate: item.taxRate, members: [{ itemId: item.id, rate: item.taxRate }] };
  if (item.type === 'Sales Tax Group') {
    const members = item.groupLines
      .map((g) => itemOf(itemsById, g.itemId))
      .filter((m): m is Item => !!m && m.type === 'Sales Tax Item')
      .map((m) => ({ itemId: m.id, rate: m.taxRate }));
    return { rate: members.reduce((s, m) => s + m.rate, 0), members };
  }
  return { rate: 0, members: [] };
}

/**
 * Splits the tax of a group per member: round(base × memberRate / 100) each, the rounding
 * difference goes to the last member so the parts add up to `totalTax`.
 */
export function splitGroupTax(base: number, members: { itemId: ID; rate: number }[], totalTax: number): TaxPart[] {
  if (!members.length) return [];
  const parts = members.map((m) => ({ itemId: m.itemId, rate: m.rate, amount: round2((base * m.rate) / 100) }));
  const sum = round2(parts.reduce((s, p) => s + p.amount, 0));
  parts[parts.length - 1].amount = round2(parts[parts.length - 1].amount + round2(totalTax - sum));
  return parts;
}

/** Total of a purchase form (bills, checks, credit card charges): Σ line amounts. */
export function computePurchaseTotal(lines: TxnLine[]): number {
  return round2(lines.reduce((s, l) => s + (l.amount || 0), 0));
}

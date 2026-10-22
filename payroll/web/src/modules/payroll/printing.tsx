// Pay stub and paycheck printing (Print Paychecks, Print Pay Stubs, the Paycheck window):
//   - voucher paychecks: the check on top and two stubs below (one letter page per paycheck);
//   - pay stubs: one page per paycheck (Employee Pay Stub layout).
// Pay stub data comes from GET /paystubs?ids= (net in words, YTD, PTO, last four SSN digits).
// "Preview" shows the same HTML in a dialog before printing.
import { useRef } from 'react';
import { Printer } from 'lucide-react';
import { api, qs } from '@/api/client';
import { invalidateAll } from '@/api/hooks';
import type { Address, Id, PayStub, PTOSnapshot, StubLine, SyncProblem } from '@/api/types';
import { Button, msgBox, showDialog, toast } from '@/components';
import { fmtDate, fmtMoney } from '@/util/format';
import { BASE_PRINT_CSS, escHtml as esc, printHtml } from '@/util/print';
import { showPostingProblems } from './shared';

/** GET /paystubs?ids= in the order of `ids`. */
export async function fetchPayStubs(ids: Id[]): Promise<PayStub[]> {
  if (!ids.length) return [];
  const list = await api.get<PayStub[]>('/paystubs' + qs({ ids }));
  const byId = new Map(list.map((s) => [s.paycheckId, s]));
  return ids.map((id) => byId.get(id)).filter((s): s is PayStub => !!s);
}

// ---------------------------------------------------------------------------
// HTML pieces

const m = (n: number | null | undefined) => (n === null || n === undefined ? '' : fmtMoney(n));
const neg = (n: number) => (n ? fmtMoney(-n) : fmtMoney(0));
const hrs = (h: number | null | undefined) => (h === null || h === undefined ? '' : h.toFixed(2));

function addressLines(a: Partial<Address> | null | undefined): string[] {
  if (!a) return [];
  const city = [a.city, [a.state, a.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [a.line1, a.line2, city].map((s) => (s ?? '').trim()).filter(Boolean);
}

function companyBlock(st: PayStub): string {
  const lines = addressLines(st.company.address);
  return `<div class="co"><div class="co-name">${esc(st.company.name)}</div>${lines.map((l) => `<div>${esc(l)}</div>`).join('')}${
    st.company.ein ? `<div class="muted">FEIN ${esc(st.company.ein)}</div>` : ''
  }</div>`;
}

function stubTable(title: string, rows: StubLine[], opts: { hours?: boolean; negative?: boolean; totalLabel?: string; total?: number; totalYtd?: number; totalHours?: number } = {}): string {
  if (!rows.length && opts.total === undefined) return '';
  const cols = '<colgroup><col style="width:40%"><col style="width:12%"><col style="width:12%"><col style="width:18%"><col style="width:18%"></colgroup>';
  const head = opts.hours
    ? `<tr><th>${esc(title)}</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Current</th><th class="num">YTD Amount</th></tr>`
    : `<tr><th>${esc(title)}</th><th></th><th></th><th class="num">Current</th><th class="num">YTD Amount</th></tr>`;
  const v = (n: number) => (opts.negative ? neg(n) : m(n));
  const body = rows
    .map(
      (r) =>
        `<tr><td>${esc(r.name)}</td><td class="num">${opts.hours ? hrs(r.hours) : ''}</td><td class="num">${opts.hours && r.rate !== null ? m(r.rate) : ''}</td><td class="num">${v(r.amount)}</td><td class="num">${v(r.ytd)}</td></tr>`,
    )
    .join('');
  const tot =
    opts.total !== undefined
      ? `<tr class="sub"><td>${esc(opts.totalLabel ?? '')}</td><td class="num">${opts.totalHours !== undefined ? hrs(opts.totalHours) : ''}</td><td></td><td class="num">${v(opts.total)}</td><td class="num">${
          opts.totalYtd !== undefined ? v(opts.totalYtd) : ''
        }</td></tr>`
      : '';
  return `<table class="sec">${cols}${head}${body}${tot}</table>`;
}

function ptoTable(sick: PTOSnapshot | null, vac: PTOSnapshot | null): string {
  if (!sick && !vac) return '';
  const row = (name: string, p: PTOSnapshot | null) =>
    p ? `<tr><td>${name}</td><td class="num">${hrs(p.accrued)}</td><td class="num">${hrs(p.used)}</td><td class="num">${hrs(p.availableAfter)}</td></tr>` : '';
  return `<table class="sec"><colgroup><col style="width:40%"><col style="width:20%"><col style="width:20%"><col style="width:20%"></colgroup><tr><th>Paid Time Off</th><th class="num">Earned</th><th class="num">Used</th><th class="num">Available</th></tr>${row('Sick', sick)}${row('Vacation', vac)}</table>`;
}

const sumYtd = (rows: StubLine[]) => rows.reduce((s, r) => s + r.ytd, 0);
const sumHours = (rows: StubLine[]) => rows.reduce((s, r) => s + (r.hours ?? 0), 0);

/** The stub sections (earnings, taxes, deductions, adjustments, net pay, PTO, company items). */
function stubBody(st: PayStub, message: string): string {
  const left = [
    stubTable('Earnings and Hours', st.earnings, { hours: true, totalLabel: 'Total Gross Pay', total: st.gross, totalYtd: st.grossYtd, totalHours: sumHours(st.earnings) }),
    stubTable('Taxes', st.taxes, { negative: true, totalLabel: 'Total Taxes', total: st.totalTaxes, totalYtd: sumYtd(st.taxes) }),
    st.deductions.length ? stubTable('Deductions', st.deductions, { negative: true, totalLabel: 'Total Deductions', total: st.totalDeductions, totalYtd: sumYtd(st.deductions) }) : '',
    st.additions.length ? stubTable('Adjustments to Net Pay', st.additions) : '',
    `<table class="sec net"><colgroup><col style="width:40%"><col style="width:12%"><col style="width:12%"><col style="width:18%"><col style="width:18%"></colgroup><tr><td><b>Net Pay</b></td><td></td><td></td><td class="num"><b>${m(st.net)}</b></td><td class="num"><b>${m(st.netYtd)}</b></td></tr></table>`,
    st.directDeposit ? `<div class="dd">Direct deposit to account ${esc(st.depositAccount || '')}: ${m(st.net)}</div>` : '',
  ].join('');
  const right = [ptoTable(st.sick, st.vacation), st.contributions.length ? stubTable('Non-taxable Company Items', st.contributions) : ''].join('');
  return `<div class="cols"><div class="left">${left}</div><div class="right">${right}</div></div>${message ? `<div class="msg">${esc(message)}</div>` : ''}`;
}

function stubHeader(st: PayStub): string {
  const num = st.directDeposit ? 'Direct deposit' : st.checkNumber || 'To print';
  const emp = [st.employeeName, ...addressLines(st.employeeAddress)].join(', ');
  return `<table class="hd"><tr><td><b>Employee Pay Stub</b></td><td>Check number: ${esc(num)}</td><td>Pay Period: ${fmtDate(st.periodStart)} - ${fmtDate(st.periodEnd)}</td><td class="num">Pay Date: ${fmtDate(
    st.checkDate,
  )}</td></tr></table><table class="emp"><tr><th>Employee</th><th>SSN</th><th>Employee #</th></tr><tr><td>${esc(emp)}</td><td>${st.ssnLast4 ? `***-**-${esc(st.ssnLast4)}` : ''}</td><td>${esc(
    st.employeeNumber,
  )}</td></tr></table>`;
}

/** CSS of pay stubs and voucher checks. */
export const STUB_CSS = `
  @page { size: letter; margin: 0.4in; }
  body { font-size: 10px; }
  .page { page-break-after: always; }
  .page:last-child { page-break-after: auto; }
  .stubpage { min-height: 9.6in; }
  .top { display: flex; justify-content: space-between; margin-bottom: 18px; }
  .co { line-height: 1.35; }
  .co-name { font-weight: bold; font-size: 12px; }
  .mailto { margin: 6px 0 22px 0.6in; font-size: 11px; line-height: 1.35; white-space: pre-line; }
  table.hd, table.emp { width: 100%; margin-bottom: 6px; }
  table.hd td { border-top: 1.5px solid #000; border-bottom: 1px solid #000; padding: 3px 4px; }
  table.emp th { border-bottom: 1px solid #888; font-size: 9px; text-transform: uppercase; }
  table.emp td { padding: 2px 4px 6px; }
  .cols { display: flex; gap: 18px; align-items: flex-start; }
  .left { flex: 1.7; }
  .right { flex: 1; }
  table.sec { width: 100%; margin-bottom: 7px; table-layout: fixed; }
  table.sec td:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
  table { font-size: inherit; }
  table.sec th { font-size: 9.5px; border-bottom: 1px solid #000; padding: 1px 4px; }
  table.sec td { padding: 1px 4px; }
  table.sec tr.sub td { border-top: 1px solid #888; font-weight: bold; }
  table.sec.net td { border-top: 1.5px solid #000; border-bottom: 1.5px solid #000; padding: 3px 4px; font-size: 11px; }
  .dd { margin: 4px 0; }
  .msg { margin-top: 10px; padding-top: 4px; border-top: 1px dashed #999; font-style: italic; }
  .voucher { height: 10.1in; display: flex; flex-direction: column; }
  .check { height: 3.45in; position: relative; padding: 0.15in 0.25in; border-bottom: 1px dashed #999; }
  .check .co { font-size: 10px; }
  .ckno { position: absolute; right: 0.25in; top: 0.15in; font-size: 13px; font-weight: bold; }
  .ckdate { position: absolute; right: 0.25in; top: 0.7in; font-size: 12px; }
  .payto { position: absolute; left: 0.25in; right: 0.25in; top: 1.1in; display: flex; align-items: baseline; gap: 8px; }
  .payto .lbl { font-size: 8px; width: 0.75in; line-height: 1.1; }
  .payto .name { flex: 1; border-bottom: 1px solid #000; font-size: 12px; padding-left: 4px; }
  .payto .amt { width: 1.6in; border: 1px solid #000; padding: 2px 6px; text-align: right; font-size: 13px; font-weight: bold; }
  .words { position: absolute; left: 0.25in; right: 0.25in; top: 1.55in; border-bottom: 1px solid #000; font-size: 11.5px; overflow: hidden; white-space: nowrap; }
  .words .dl { float: right; font-size: 8px; background: #fff; padding-left: 4px; }
  .ckaddr { position: absolute; left: 1in; top: 1.9in; font-size: 11px; white-space: pre-line; line-height: 1.3; }
  .ckmemo { position: absolute; left: 0.25in; bottom: 0.2in; font-size: 10px; }
  .sig { position: absolute; right: 0.25in; bottom: 0.2in; width: 2.6in; border-top: 1px solid #000; font-size: 8px; text-align: center; padding-top: 2px; }
  .vstub { flex: 1; padding: 0.15in 0.25in 0; border-bottom: 1px dashed #999; font-size: 8.5px; overflow: hidden; }
  .vstub:last-child { border-bottom: 0; }
  .vstub table.sec { margin-bottom: 4px; }
  .vstub table.sec th { font-size: 8px; }
  .vstub table.sec td { padding: 0 4px; }
  .vstub table.hd td { padding: 2px 4px; }
  .vstub table.emp td { padding: 1px 4px 3px; }
  .vstub .msg { margin-top: 4px; }
`;

/** One pay stub page (Print Pay Stubs). */
export function payStubPage(st: PayStub, message = ''): string {
  const mail = [st.employeeName, ...addressLines(st.employeeAddress)].join('\n');
  return `<div class="page stubpage"><div class="top">${companyBlock(st)}</div><div class="mailto">${esc(mail)}</div>${stubHeader(st)}${stubBody(st, message)}</div>`;
}

/** One voucher paycheck page: the check with `number`, then two stubs. */
export function voucherPage(st: PayStub, number: string, message = ''): string {
  const payee = st.printAs || st.employeeName;
  const addr = [payee, ...addressLines(st.employeeAddress)].join('\n');
  const words = `${st.netInWords} ${'*'.repeat(Math.max(4, 70 - st.netInWords.length))}`;
  const memo = `Pay Period: ${fmtDate(st.periodStart)} - ${fmtDate(st.periodEnd)}${st.memo ? ' ' + st.memo.replace(/^VOID: /, '') : ''}`;
  const stub = `<div class="vstub">${stubHeader({ ...st, checkNumber: number })}${stubBody(st, message)}</div>`;
  return `<div class="page voucher"><div class="check">${companyBlock(st)}<div class="ckno">${esc(number)}</div><div class="ckdate">${fmtDate(st.checkDate)}</div><div class="payto"><span class="lbl">PAY TO THE ORDER OF</span><span class="name">${esc(
    payee,
  )}</span><span class="amt">**${m(st.net)}</span></div><div class="words">${esc(words)}<span class="dl">DOLLARS</span></div><div class="ckaddr">${esc(addr)}</div><div class="ckmemo">MEMO: ${esc(
    memo,
  )}</div><div class="sig">AUTHORIZED SIGNATURE</div></div>${stub}${stub}</div>`;
}

/** Increments the number at the end of a check number ("1009" → "1010"). */
export function incNumber(n: string): string {
  const x = /^(.*?)(\d+)$/.exec(n.trim());
  if (!x) return n;
  return x[1] + String(Number(x[2]) + 1).padStart(x[2].length, '0');
}

// ---------------------------------------------------------------------------
// Preview

function PreviewBody({ title, html, onPrint, close }: { title: string; html: string; onPrint?: () => void; close: (v: boolean) => void }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const doc = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${BASE_PRINT_CSS}${STUB_CSS} body{background:#fff;padding:0.3in;} .page{border-bottom:2px solid #cbd5e1;margin-bottom:0.3in;padding-bottom:0.2in;}</style></head><body>${html}</body></html>`;
  return (
    <div className="py-preview">
      <iframe ref={ref} className="py-preview-frame" title={title} srcDoc={doc} />
      <div className="sx-dlg-buttons">
        {onPrint && (
          <Button
            variant="primary"
            icon={Printer}
            label="&Print"
            onClick={() => {
              close(true);
              onPrint();
            }}
          />
        )}
        <Button label="Close" onClick={() => close(false)} />
      </div>
    </div>
  );
}

/** Shows printable HTML in a dialog (Preview); `onPrint` adds a Print button. */
export function previewHtml(title: string, html: string, onPrint?: () => void): Promise<boolean> {
  return showDialog<boolean>({ title, width: 900, cancelValue: false, render: (close) => <PreviewBody title={title} html={html} onPrint={onPrint} close={close} /> });
}

// ---------------------------------------------------------------------------
// Printing

/** Prints the pay stubs of the paychecks (one page each). */
export async function printPayStubs(ids: Id[], message = ''): Promise<void> {
  const stubs = await fetchPayStubs(ids);
  if (!stubs.length) return;
  await printHtml(stubs.length === 1 ? 'Pay Stub' : 'Pay Stubs', stubs.map((s) => payStubPage(s, message)).join(''), STUB_CSS);
}

/** Voucher pages of paychecks numbered from `firstNumber` in the given order. */
export async function voucherHtml(ids: Id[], firstNumber: string, message = ''): Promise<{ html: string; numbers: string[] }> {
  const stubs = await fetchPayStubs(ids);
  let n = firstNumber.trim();
  const numbers: string[] = [];
  const pages = stubs.map((s) => {
    const num = n;
    numbers.push(num);
    n = incNumber(n);
    return voucherPage(s, num, message);
  });
  return { html: pages.join(''), numbers };
}

/**
 * Asks whether the paychecks printed correctly; on Yes assigns the check numbers from
 * `firstNumber` (POST /paychecks/mark-printed, which also re-posts the SerieX Books checks).
 */
export async function confirmPaychecksPrinted(ids: Id[], firstNumber: string): Promise<boolean> {
  if (!ids.length) return false;
  const many = ids.length > 1;
  const r = await msgBox({
    title: 'Print Paychecks - Confirmation',
    message: many
      ? `Did all ${ids.length} paychecks print correctly?\n\nYes assigns check numbers ${firstNumber} to ${(() => {
          let x = firstNumber;
          for (let i = 1; i < ids.length; i++) x = incNumber(x);
          return x;
        })()} and removes them from the list of paychecks to print. No keeps them in the list so you can print them again.`
      : `Did the paycheck print correctly?\n\nYes assigns check number ${firstNumber} and removes it from the list of paychecks to print. No keeps it to print again.`,
    buttons: ['Yes', 'No'],
    icon: 'question',
  });
  if (r !== 'Yes') return false;
  const res = await api.post<{ updated: number; posted: number; problems: SyncProblem[] }>('/paychecks/mark-printed', { ids, firstNumber });
  await invalidateAll();
  toast(`${res.updated} paycheck${res.updated === 1 ? '' : 's'} numbered from ${firstNumber}`, { kind: 'success' });
  if (res.problems?.length) await showPostingProblems(res.problems, 'The check numbers are saved, but SerieX Books reported problems:');
  return true;
}

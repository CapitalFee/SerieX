// Form 940 (Employer's Annual Federal Unemployment (FUTA) Tax Return) for a year, with
// Schedule A (multi-state employers and credit reduction) and the tax balance adjustment the
// credit reduction needs (it is not accrued on the paychecks).
import { useState } from 'react';
import { Info, MapPinned, Scale } from 'lucide-react';
import type { TaxForm } from '@/api/types';
import { Button, ToolbarButton } from '@/components';
import { openWindow } from '@/windows/windowStore';
import { escHtml } from '@/util/print';
import { fmtDate, fmtMoney, fmtPercent } from '@/util/format';
import { TaxFormFrame } from './TaxFormFrame';
import { YearSelect, useFormYears, usePeriodSwitch } from './period';

export interface Form940WindowProps {
  /** Year. */
  year: number;
}

interface SaRow {
  state: string;
  futaWages: number;
  reductionRate: number;
  creditReduction: number;
}
interface CrAdj {
  amount: number;
  adjusted: number;
  needed: number;
  itemId: number;
  effectiveDate: string;
}

const saRows = (form: TaxForm): SaRow[] => (Array.isArray(form.extra?.scheduleA) ? (form.extra.scheduleA as SaRow[]) : []);

export default function Form940Window(props: Form940WindowProps) {
  const now = new Date();
  const def = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
  const years = useFormYears([props.year ?? def]);
  const { period, change } = usePeriodSwitch('form940', { year: props.year || def });
  const [showA, setShowA] = useState(true);
  const year = period.year;
  return (
    <TaxFormFrame
      key={year}
      kind="940"
      year={year}
      periodControls={<YearSelect value={year} years={years} onChange={(y) => void change({ year: y })} />}
      extraTools={(form) =>
        form && saRows(form).length ? <ToolbarButton label="Schedule A" icon={MapPinned} pressed={showA} title="Show or hide Schedule A (state unemployment)" onClick={() => setShowA((s) => !s)} /> : null
      }
      notes={(form) => (
        <>
          <CreditReduction form={form} />
          <CreditReductionStates form={form} />
        </>
      )}
      hideWarning={(form, w) => needsAdjustment(form) && /^Credit reduction of /.test(w)}
      after={(form) => (showA && saRows(form).length > 0 ? <ScheduleA form={form} /> : null)}
      printExtra={(form) => (form.extra?.scheduleARequired ? scheduleAHtml(form) : '')}
    />
  );
}

const crAdj = (form: TaxForm) => form.extra?.creditReductionAdjustment as CrAdj | undefined;
const needsAdjustment = (form: TaxForm) => (crAdj(form)?.needed ?? 0) > 0;

/** Line 11 (credit reduction) is not accrued on paychecks: offer the company tax balance adjustment that records it. */
function CreditReduction({ form }: { form: TaxForm }) {
  const cr = crAdj(form);
  if (!cr || !(cr.needed > 0)) return null;
  return (
    <div className="fx-note fx-warn">
      <Scale size={15} aria-hidden="true" />
      <span>
        The credit reduction of {fmtMoney(cr.amount)} (line 11) is not in what you owe for federal unemployment yet ({fmtMoney(cr.adjusted)} adjusted). Add a company tax balance adjustment of
        Federal Unemployment for {fmtMoney(cr.needed)} effective {fmtDate(cr.effectiveDate)} so you can pay it.
      </span>
      <Button
        small
        label="Adjust tax balance"
        onClick={() => openWindow('adjustLiabilities', { itemId: cr.itemId, amount: cr.needed, effectiveDate: cr.effectiveDate, memo: `FUTA credit reduction ${form.year} (Form 940 line 11)` })}
      />
    </div>
  );
}

/**
 * The credit reduction states of a year are announced by the Department of Labor in November:
 * until the tax tables have them, line 11 shows no credit reduction for the year being paid.
 */
function CreditReductionStates({ form }: { form: TaxForm }) {
  const thisYear = new Date().getFullYear();
  if (form.year < thisYear || form.status === 'filed') return null;
  if (saRows(form).some((r) => r.reductionRate > 0) || crAdj(form)) return null;
  return (
    <div className="fx-note">
      <Info size={15} aria-hidden="true" />
      <span>
        The FUTA credit reduction states for {form.year} are published in November. When they are announced, enter them in Tax Tables (federal, credit reduction) so line 11 and
        Schedule A include them.
      </span>
      <Button small label="Open Tax Tables" onClick={() => openWindow('taxTables', { year: form.year })} />
    </div>
  );
}

function ScheduleA({ form }: { form: TaxForm }) {
  const rows = saRows(form);
  const total = rows.reduce((s, r) => s + r.creditReduction, 0);
  return (
    <section className="fx-sched" aria-label="Schedule A">
      <h2>Schedule A (Form 940) for {form.year}: Multi-State Employer and Credit Reduction Information</h2>
      <div className="fx-sched-sub">States where you paid state unemployment tax, with the FUTA taxable wages and the credit reduction rate of each state.</div>
      <table className="fx-table">
        <thead>
          <tr>
            <th>STATE</th>
            <th className="fx-num">FUTA TAXABLE WAGES</th>
            <th className="fx-num">REDUCTION RATE</th>
            <th className="fx-num">CREDIT REDUCTION</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.state}>
              <td>{r.state}</td>
              <td className="fx-num">{fmtMoney(r.futaWages)}</td>
              <td className="fx-num">{r.reductionRate ? fmtPercent(r.reductionRate) : '—'}</td>
              <td className="fx-num">{fmtMoney(r.creditReduction)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={3}>Total credit reduction (Form 940, line 11)</td>
            <td className="fx-num">{fmtMoney(total)}</td>
          </tr>
        </tfoot>
      </table>
    </section>
  );
}

function scheduleAHtml(form: TaxForm): string {
  const rows = saRows(form);
  const trs = rows
    .map((r) => `<tr><td>${escHtml(r.state)}</td><td class="v">${fmtMoney(r.futaWages)}</td><td class="v">${r.reductionRate ? fmtPercent(r.reductionRate) : ''}</td><td class="v">${fmtMoney(r.creditReduction)}</td></tr>`)
    .join('');
  const total = rows.reduce((s, r) => s + r.creditReduction, 0);
  return `<div class="pf"><div class="pf-title"><b>Schedule A (Form 940) for ${form.year}:</b><span>Multi-State Employer and Credit Reduction Information</span></div>
    <div class="pf-box" style="margin:6px 0"><div><label>Employer identification number (EIN)</label><b>${escHtml(form.company.ein)}</b></div><div><label>Name (not your trade name)</label>${escHtml(form.company.name)}</div></div>
    <table class="pf-sched"><tr><th>State</th><th>FUTA taxable wages</th><th>Reduction rate</th><th>Credit reduction</th></tr>${trs}<tr><td colspan="3"><b>Total credit reduction</b></td><td class="v"><b>${fmtMoney(total)}</b></td></tr></table></div>`;
}

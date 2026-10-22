// Form 941 (Employer's Quarterly Federal Tax Return) for a quarter, with Schedule B (Report of
// Tax Liability for Semiweekly Schedule Depositors) when the company deposits semiweekly.
import { Fragment, useState } from 'react';
import { CalendarDays } from 'lucide-react';
import type { TaxForm } from '@/api/types';
import { ToolbarButton } from '@/components';
import { escHtml } from '@/util/print';
import { fmtMoney } from '@/util/format';
import { MONTH_NAMES } from '@/util/dates';
import { TaxFormFrame } from './TaxFormFrame';
import { QuarterSelect, YearSelect, useFormYears, usePeriodSwitch } from './period';

export interface Form941WindowProps {
  /** Year. */
  year: number;
  /** Quarter (1-4). */
  quarter: number;
}

interface SbRow {
  date: string;
  month: number;
  day: number;
  amount: number;
}

/** Last quarter that ended (the quarter a 941 is usually prepared for). */
export function lastEndedQuarter(d = new Date()): { year: number; quarter: number } {
  const q = Math.floor(d.getMonth() / 3) + 1;
  return q === 1 ? { year: d.getFullYear() - 1, quarter: 4 } : { year: d.getFullYear(), quarter: q - 1 };
}

const sbRows = (form: TaxForm): SbRow[] | null => (Array.isArray(form.extra?.scheduleB) ? (form.extra.scheduleB as SbRow[]) : null);
const monthName = (form: TaxForm, m: number) => MONTH_NAMES[(+form.period.slice(1) - 1) * 3 + m - 1];

export default function Form941Window(props: Form941WindowProps) {
  const lq = lastEndedQuarter();
  const years = useFormYears([props.year ?? lq.year]);
  const { period, change } = usePeriodSwitch('form941', { year: props.year || lq.year, quarter: props.quarter || lq.quarter });
  const [showB, setShowB] = useState(true);
  const year = period.year;
  const quarter = period.quarter ?? 1;
  return (
    <TaxFormFrame
      key={`${year}-${quarter}`}
      kind="941"
      year={year}
      quarter={quarter}
      periodControls={
        <>
          <YearSelect value={year} years={years} onChange={(y) => void change({ year: y, quarter })} />
          <QuarterSelect value={quarter} onChange={(q) => void change({ year, quarter: q })} />
        </>
      }
      extraTools={(form) =>
        form && sbRows(form) ? (
          <ToolbarButton label="Schedule B" icon={CalendarDays} pressed={showB} title="Show or hide Schedule B (semiweekly depositors)" onClick={() => setShowB((s) => !s)} />
        ) : null
      }
      after={(form) => (showB && sbRows(form) ? <ScheduleB form={form} /> : null)}
      printExtra={(form) => (sbRows(form) && (showB || form.extra?.scheduleBRequired) ? scheduleBHtml(form) : '')}
    />
  );
}

function ScheduleB({ form }: { form: TaxForm }) {
  const rows = sbRows(form) ?? [];
  const months = (form.extra?.scheduleBMonths as number[] | undefined) ?? [0, 0, 0];
  const total = Number(form.extra?.scheduleBTotal ?? 0);
  return (
    <section className="fx-sched" aria-label="Schedule B">
      <h2>Schedule B (Form 941): Report of Tax Liability for Semiweekly Schedule Depositors</h2>
      <div className="fx-sched-sub">
        Calendar year {form.year}, quarter {form.period.slice(1)}. Liabilities by the date of the paychecks (federal income tax withheld plus employee and employer social security and Medicare).
        {!form.extra?.scheduleBRequired && ' Line 16 does not have box 3 checked: attach Schedule B only if you are a semiweekly depositor.'}
      </div>
      <div className="fx-sched-months">
        {[1, 2, 3].map((m) => {
          const byDay = new Map(rows.filter((r) => r.month === m).map((r) => [r.day, r.amount]));
          return (
            <table key={m} className="fx-days">
              <caption>
                Month {m} ({monthName(form, m)})
              </caption>
              <tbody>
                {Array.from({ length: 8 }, (_, r) => (
                  <tr key={r}>
                    {[0, 1, 2, 3].map((c) => {
                      const day = c * 8 + r + 1;
                      if (day > 31)
                        return (
                          <td key={c} colSpan={2}>
                            {' '}
                          </td>
                        );
                      const v = byDay.get(day);
                      return (
                        <Fragment key={c}>
                          <td className="fx-day">{day}</td>
                          <td className="fx-amt">{v ? fmtMoney(v) : ''}</td>
                        </Fragment>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={6}>Tax liability for Month {m}</td>
                  <td colSpan={2} className="fx-amt">
                    {fmtMoney(months[m - 1] ?? 0)}
                  </td>
                </tr>
              </tfoot>
            </table>
          );
        })}
      </div>
      <div className="fx-w2-tot" style={{ marginTop: 10 }}>
        <b>Total liability for the quarter</b>
        <span className="fx-spacer" />
        <b className="fx-num">{fmtMoney(total)}</b>
        <span className="fx-muted">(must equal line 12 of Form 941)</span>
      </div>
    </section>
  );
}

function scheduleBHtml(form: TaxForm): string {
  const rows = sbRows(form) ?? [];
  const months = (form.extra?.scheduleBMonths as number[] | undefined) ?? [0, 0, 0];
  const tables = [1, 2, 3]
    .map((m) => {
      const byDay = new Map(rows.filter((r) => r.month === m).map((r) => [r.day, r.amount]));
      const trs = Array.from({ length: 8 }, (_, r) =>
        [0, 1, 2, 3]
          .map((c) => {
            const day = c * 8 + r + 1;
            if (day > 31) return '<td></td><td></td>';
            const v = byDay.get(day);
            return `<td>${day}</td><td class="v">${v ? fmtMoney(v) : ''}</td>`;
          })
          .join(''),
      )
        .map((t) => `<tr>${t}</tr>`)
        .join('');
      return `<table class="pf-sched pf-days"><colgroup>${'<col style="width:5%"><col style="width:20%">'.repeat(4)}</colgroup><tr><th colspan="8">Month ${m} (${escHtml(monthName(form, m))})</th></tr>${trs}<tr><td colspan="6"><b>Tax liability for Month ${m}</b></td><td colspan="2" class="v"><b>${fmtMoney(months[m - 1] ?? 0)}</b></td></tr></table>`;
    })
    .join('');
  return `<div class="pf"><div class="pf-title"><b>Schedule B (Form 941):</b><span>Report of Tax Liability for Semiweekly Schedule Depositors</span><span class="ag">Calendar year ${form.year} · Quarter ${form.period.slice(1)}</span></div>
    <div class="pf-box" style="margin:6px 0"><div><label>Employer identification number (EIN)</label><b>${escHtml(form.company.ein)}</b></div><div><label>Name (not your trade name)</label>${escHtml(form.company.name)}</div></div>
    ${tables}<div class="pf-row"><span></span><span class="lbl"><b>Total liability for the quarter</b> (must equal line 12 of Form 941)</span><span class="v">${fmtMoney(Number(form.extra?.scheduleBTotal ?? 0))}</span></div></div>`;
}

// State settings editor shared by Company Payroll Information and Payroll Setup: the state
// withholding and unemployment account numbers, and the company rates of each year (the
// unemployment (SUI) rate and the rates of the state programs: disability, family leave,
// training tax...). Blank rates use the standard rates of the tax tables, shown in gray.
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import type { StateSettings, StateTax } from '@/api/types';
import { Field, FieldRow, NumberField, Spinner, TextField } from '@/components';
import { pct } from './shared';

/** Account numbers and rates by year of one state. */
export function StateRatesEditor({ s, years, ro, onChange }: { s: StateSettings; years: number[]; ro: boolean; onChange: (p: Partial<StateSettings>) => void }) {
  const year = new Date().getFullYear();
  const tq = useQuery({
    queryKey: ['tax-tables', year, 'state', s.state],
    queryFn: ({ signal }) => api.get<StateTax>(`/tax-tables/${year}/states/${s.state}`, { signal }),
    staleTime: 5 * 60_000,
  });
  const st = tq.data;
  const cols = useMemo(() => {
    const out: { key: string; label: string; table: number }[] = [];
    for (const p of st?.programs ?? []) {
      if (p.employeeRate > 0) out.push({ key: `${p.key}:EE`, label: `${p.name} (employee)`, table: p.employeeRate });
      if (p.employerRate > 0 || p.employeeRate === 0) out.push({ key: `${p.key}:ER`, label: `${p.name} (company)`, table: p.employerRate });
    }
    return out;
  }, [st]);
  const allYears = useMemo(() => {
    const ys = new Set<number>(years);
    for (const k of Object.keys(s.uiRates)) ys.add(Number(k));
    for (const k of Object.keys(s.otherRates)) ys.add(Number(k));
    return Array.from(ys)
      .filter((y) => y > 1999)
      .sort();
  }, [years, s.uiRates, s.otherRates]);

  const setUi = (y: number, v: number | null) => {
    const n = { ...s.uiRates };
    if (v === null) delete n[String(y)];
    else n[String(y)] = v;
    onChange({ uiRates: n });
  };
  const setOther = (y: number, key: string, v: number | null) => {
    const n: Record<string, Record<string, number>> = {};
    for (const [k, m] of Object.entries(s.otherRates)) n[k] = { ...m };
    const row = n[String(y)] ?? {};
    if (v === null) delete row[key];
    else row[key] = v;
    if (Object.keys(row).length) n[String(y)] = row;
    else delete n[String(y)];
    onChange({ otherRates: n });
  };

  return (
    <div className="cx-stack" style={{ gap: 10 }}>
      <div className="cx-h2" style={{ margin: 0 }}>
        {s.stateName || s.state}
      </div>
      <FieldRow>
        <Field label="State withholding account number" width={240} help="Withholding account number">
          <TextField name="withholdingId" value={s.withholdingId} onChange={(v) => onChange({ withholdingId: v })} readOnly={ro} placeholder={st && !st.income.has ? 'No state income tax' : ''} />
        </Field>
        <Field label="Unemployment account number" width={240} help="Unemployment account number">
          <TextField name="uiId" value={s.uiId} onChange={(v) => onChange({ uiId: v })} readOnly={ro} />
        </Field>
      </FieldRow>
      <div className="cx-section-title" style={{ marginBottom: 0 }}>
        Company rates by year
      </div>
      <div className="cx-hint" style={{ marginTop: 0 }}>
        Enter the rates on the notice the state sends you each year. A blank rate uses the standard rate shown in gray
        {st ? ` (new employer unemployment rate ${pct(st.sui.newEmployerRate)} on the first $${st.sui.wageBase.toLocaleString('en-US')} of wages)` : ''}.
      </div>
      {tq.isLoading ? (
        <Spinner />
      ) : (
        <div className="pc-ratetable-wrap" data-field="uiRates">
          <table className="pc-ratetable">
            <thead>
              <tr>
                <th>Rate</th>
                {allYears.map((y) => (
                  <th key={y} className="cx-right">
                    {y} %
                  </th>
                ))}
                <th className="cx-right">Standard</th>
              </tr>
            </thead>
            <tbody>
              <tr data-rate="ui">
                <td>Unemployment (SUI)</td>
                {allYears.map((y) => (
                  <td key={y} data-year={y}>
                    <NumberField
                      name={`ui.${y}`}
                      aria-label={`${y} unemployment rate`}
                      value={s.uiRates[String(y)] ?? null}
                      decimals={4}
                      placeholder={st ? String(st.sui.newEmployerRate) : ''}
                      onChange={(v) => setUi(y, v)}
                      readOnly={ro}
                      width={92}
                    />
                  </td>
                ))}
                <td className="cx-right cx-muted">{st ? pct(st.sui.newEmployerRate) : ''}</td>
              </tr>
              {cols.map((c) => (
                <tr key={c.key} data-rate={c.key}>
                  <td>{c.label}</td>
                  {allYears.map((y) => (
                    <td key={y} data-year={y}>
                      <NumberField
                        name={`other.${y}.${c.key}`}
                        aria-label={`${y} ${c.label} rate`}
                        value={s.otherRates[String(y)]?.[c.key] ?? null}
                        decimals={4}
                        placeholder={String(c.table)}
                        onChange={(v) => setOther(y, c.key, v)}
                        readOnly={ro}
                        width={92}
                      />
                    </td>
                  ))}
                  <td className="cx-right cx-muted">{pct(c.table)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {st?.sui.notes && <div className="cx-hint">{st.sui.notes}</div>}
    </div>
  );
}

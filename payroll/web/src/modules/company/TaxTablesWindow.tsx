// Tax Tables (Employees > Tax Tables): the federal and state tax tables payroll uses for a year,
// read from GET /tax-tables. Federal: social security, Medicare, FUTA (with the credit reduction
// states), supplemental rates, Pub 15-T amounts, benefit limits and the withholding bracket tables.
// States: income tax method and rates, unemployment (SUI) wage base and rates, state programs,
// agencies and sources. SerieX Books administrators can correct a table (PUT, stored as the
// company's change) and go back to the built-in table (Restore built-in, DELETE).
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Pencil, Plus, RotateCcw, Save, Trash2, X } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import type { Bracket, FederalTax, StateProgram, StateStatus, StateTax, StateTaxSummary } from '@/api/types';
import { invalidateAll, queryClient, useMeta } from '@/api/hooks';
import {
  Badge,
  Button,
  Checkbox,
  ErrorBanner,
  FormErrorsProvider,
  ListView,
  MoneyField,
  NumberField,
  SearchBox,
  Select,
  Spinner,
  StatePicker,
  Tabs,
  TextArea,
  TextField,
  confirmBox,
  toast,
  useFormErrors,
  type ListColumn,
} from '@/components';
import { HelpTip } from '@/components/HelpTip';
import { useWindow } from '@/windows/WindowContext';
import { useSession } from '@/state/session';
import { fmtMoney } from '@/util/format';
import { errText, pct, useTaxTableInfo } from './shared';
import './company.css';

export interface TaxTablesWindowProps {
  /** Tax year to show. */
  year?: number;
  /** State code to show. */
  state?: string;
}

const STATUS_LABELS: Record<string, string> = { single: 'Single or Married filing separately', mfj: 'Married filing jointly', hoh: 'Head of household', married: 'Married' };
const TABLE_LABELS: Record<string, string> = {
  standard: 'Standard withholding (W-4 2020 or later)',
  checkbox: 'Step 2 checkbox (W-4 2020 or later)',
  pre2020: 'W-4 2019 or earlier',
};
const LIMIT_LABELS: Record<string, string> = {
  elective401k: '401(k), 403(b) elective deferrals',
  gov457b: '457(b) deferrals',
  catchUp50: 'Catch-up, age 50 and over',
  catchUp6063: 'Catch-up, ages 60 to 63',
  simple: 'SIMPLE IRA deferrals',
  simpleCatchUp: 'SIMPLE catch-up, age 50 and over',
  simpleCatchUp6063: 'SIMPLE catch-up, ages 60 to 63',
  hsaSelf: 'HSA, self-only coverage',
  hsaFamily: 'HSA, family coverage',
  hsaCatchUp: 'HSA catch-up, age 55 and over',
  healthFsa: 'Health FSA',
  dependentCare: 'Dependent care FSA',
  dependentCareMfs: 'Dependent care FSA, married filing separately',
  transit: 'Transit (per month)',
  parking: 'Parking (per month)',
  rothCatchUpWageThreshold: 'Roth catch-up wage threshold',
};
const METHOD_LABELS: Record<string, string> = { none: 'No income tax', flat: 'Flat rate', brackets: 'Brackets', special: 'State formula' };

const money0 = (n: number | null | undefined) => (n === null || n === undefined ? '' : '$' + fmtMoney(n).replace(/\.00$/, ''));

/** The agencies to check a state's built-in rates with (withholding and unemployment). */
function checkWith(st: Pick<StateTax, 'name' | 'agencyWithholding' | 'agencyUnemployment'>): string {
  const names = [...new Set([st.agencyWithholding, st.agencyUnemployment].map((a) => (a || '').trim()).filter(Boolean))];
  return names.length ? names.join(' and ') : `the ${st.name} tax agencies`;
}

export default function TaxTablesWindow(props: TaxTablesWindowProps) {
  const w = useWindow();
  const meta = useMeta().data;
  const isAdmin = useSession((s) => s.isAdmin);
  const [year, setYear] = useState<number>(props.year ?? new Date().getFullYear());
  const [tab, setTab] = useState<'federal' | 'states'>(props.state ? 'states' : 'federal');
  const primaryState = useSession((s) => s.company?.primaryState ?? '');
  const [state, setState] = useState<string>(props.state ?? primaryState);
  const info = useTaxTableInfo(year);
  // a federal or state table is being edited: leaving it asks first
  const [editing, setEditing] = useState(false);
  const editingRef = useRef(false);
  editingRef.current = editing;
  const leaveEdit = async () => !editingRef.current || (await confirmBox('Discard the changes you made to the tax table?', 'Tax Tables'));

  useEffect(() => {
    if (props.year) setYear(props.year);
  }, [props.year]);
  useEffect(() => {
    if (props.state) {
      setState(props.state);
      setTab('states');
    }
  }, [props.state]);
  useEffect(() => {
    w.setTitle(`Tax Tables - ${year}`);
  }, [year]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    w.setDirty(editing);
  }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    w.setBeforeClose(leaveEdit);
    return () => w.setBeforeClose(null);
  }, [w.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const years = useMemo(() => {
    const ys = new Set<number>([...(meta?.taxYears ?? []), year, new Date().getFullYear()]);
    return Array.from(ys).sort((a, b) => b - a);
  }, [meta, year]);
  const data = info.data;
  const builtIn = meta?.taxYears?.includes(year);

  return (
    <div className="pc-tax">
      <div className="pc-tax-head">
        <span className="cx-muted">
          Tax year <HelpTip term="Tax table" size={13} />
        </span>
        <Select
          value={year}
          width={90}
          aria-label="Tax year"
          onChange={(v) => {
            void leaveEdit().then((ok) => {
              if (!ok) return;
              setEditing(false);
              setYear(Number(v));
            });
          }}
          options={years.map((y) => ({ value: y, label: String(y) }))}
        />
        {data && (
          <span className="cx-small cx-muted">
            Tables {data.version}
            {!builtIn && ' (no built-in tables for this year: the closest earlier year is used)'}
          </span>
        )}
        <span className="cx-spacer" />
        {data && data.overrides.length > 0 && (
          <span className="cx-small">
            Changed by your company:{' '}
            {data.overrides.map((o) => (
              <Badge key={o} tone="warning">
                {o === 'federal' ? 'Federal' : o}
              </Badge>
            ))}
          </span>
        )}
      </div>
      {info.isLoading ? (
        <Spinner center label="Loading the tax tables..." />
      ) : info.error ? (
        <div className="cx-note cx-bad" style={{ margin: 16 }}>
          {errText(info.error)}
        </div>
      ) : data ? (
        <Tabs
          variant="strip"
          fill
          active={tab}
          onChange={(k) => {
            void leaveEdit().then((ok) => {
              if (!ok) return;
              setEditing(false);
              setTab(k as 'federal' | 'states');
            });
          }}
          tabs={[
            { key: 'federal', label: 'Federal' },
            { key: 'states', label: `States (${data.states.length})` },
          ]}
          aria-label="Tax tables"
        >
          {tab === 'federal' ? (
            <FederalPanel year={year} fed={data.federal} overridden={data.overrides.includes('federal')} isAdmin={isAdmin} onEditing={setEditing} />
          ) : (
            <StatesPanel
              year={year}
              states={data.states}
              sel={state}
              onSel={(code) => {
                void leaveEdit().then((ok) => {
                  if (!ok) return;
                  setEditing(false);
                  setState(code);
                });
              }}
              isAdmin={isAdmin}
              onEditing={setEditing}
            />
          )}
        </Tabs>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared bits

function Kv({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <dl className="cx-kv pc-taxkv">
      {rows.map(([k, v], i) => (
        <div key={i} style={{ display: 'contents' }}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Bracket table (Over / But not over / Tax is base + rate% of the amount over). */
function BracketTable({ rows, edit, onChange }: { rows: Bracket[]; edit?: boolean; onChange?: (rows: Bracket[]) => void }) {
  const set = (i: number, p: Partial<Bracket>) => onChange?.(rows.map((r, j) => (j === i ? { ...r, ...p } : r)).map((r) => ({ ...r, base: 0 })));
  return (
    <table className="pc-brackets">
      <thead>
        <tr>
          <th className="cx-right">Wages over</th>
          <th className="cx-right">But not over</th>
          <th className="cx-right">Tax is</th>
          <th className="cx-right">Plus</th>
          <th>of the amount over</th>
          {edit && <th />}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            <td className="cx-right cx-num">{edit ? <MoneyField value={r.over} onChange={(v) => set(i, { over: v ?? 0 })} width={110} aria-label={`Row ${i + 1} wages over`} /> : money0(r.over)}</td>
            <td className="cx-right cx-num cx-muted">{rows[i + 1] ? money0(rows[i + 1].over) : '—'}</td>
            <td className="cx-right cx-num">{edit ? <span className="cx-muted cx-small">computed</span> : fmtMoney(r.base)}</td>
            <td className="cx-right cx-num">
              {edit ? <NumberField value={r.rate} decimals={4} suffix="%" onChange={(v) => set(i, { rate: v ?? 0 })} width={90} aria-label={`Row ${i + 1} rate`} /> : pct(r.rate)}
            </td>
            <td className="cx-num cx-muted">{money0(r.over)}</td>
            {edit && (
              <td>
                <button type="button" className="sx-iconbtn" title="Remove this row" aria-label={`Remove row ${i + 1}`} disabled={rows.length <= 1} onClick={() => onChange?.(rows.filter((_, j) => j !== i).map((x) => ({ ...x, base: 0 })))}>
                  <Trash2 size={13} />
                </button>
              </td>
            )}
          </tr>
        ))}
        {edit && (
          <tr>
            <td colSpan={6}>
              <button
                type="button"
                className="sx-linkbtn cx-small"
                onClick={() => {
                  const last = rows[rows.length - 1];
                  onChange?.([...rows.map((x) => ({ ...x, base: 0 })), { over: last ? last.over + 10000 : 0, base: 0, rate: last ? last.rate : 0 }]);
                }}
              >
                <Plus size={12} style={{ verticalAlign: '-2px' }} /> Add a bracket
              </button>
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Federal

function FederalPanel({
  year,
  fed,
  overridden,
  isAdmin,
  onEditing,
}: {
  year: number;
  fed: FederalTax;
  overridden: boolean;
  isAdmin: boolean;
  onEditing: (on: boolean) => void;
}) {
  const [table, setTable] = useState<'standard' | 'checkbox' | 'pre2020'>('standard');
  const statuses = Object.keys(fed[table] ?? {});
  const [status, setStatus] = useState('single');
  const st = statuses.includes(status) ? status : (statuses[0] ?? '');
  const [edit, setEdit] = useState<FederalTax | null>(null);
  const [busy, setBusy] = useState(false);
  const fe = useFormErrors();
  const f = edit ?? fed;
  const setF = (p: Partial<FederalTax>) => setEdit((cur) => (cur ? { ...cur, ...p } : cur));
  useEffect(() => {
    onEditing(!!edit);
  }, [!!edit]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onEditing(false), []); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    if (!edit) return;
    fe.clearAll();
    setBusy(true);
    try {
      await api.put<FederalTax>(`/tax-tables/${year}/federal`, edit);
      await queryClient.invalidateQueries({ queryKey: ['tax-tables'] });
      void invalidateAll();
      setEdit(null);
      toast(`The ${year} federal tax table was changed for this company`);
    } catch (e) {
      fe.fromError(e);
    } finally {
      setBusy(false);
    }
  };
  const restore = async () => {
    if (!(await confirmBox(`Go back to the built-in ${year} federal tax table? The changes your company made to it are removed.`, 'Tax Tables'))) return;
    setBusy(true);
    try {
      await api.del(`/tax-tables/${year}/federal`);
      await queryClient.invalidateQueries({ queryKey: ['tax-tables'] });
      void invalidateAll();
      setEdit(null);
      toast(`The built-in ${year} federal tax table is used again`);
    } catch (e) {
      fe.fromError(e);
    } finally {
      setBusy(false);
    }
  };

  const num = (key: keyof FederalTax, opts: { money?: boolean } = {}) => {
    const v = f[key] as number;
    if (!edit) return opts.money ? money0(v) : pct(v);
    return opts.money ? (
      <MoneyField name={key} value={v} width={130} onChange={(x) => setF({ [key]: x ?? 0 } as Partial<FederalTax>)} aria-label={key} />
    ) : (
      <NumberField name={key} value={v} decimals={4} suffix="%" width={100} onChange={(x) => setF({ [key]: x ?? 0 } as Partial<FederalTax>)} aria-label={key} />
    );
  };

  const credit = Object.entries(f.creditReduction ?? {}).sort((a, b) => a[0].localeCompare(b[0]));

  return (
    <FormErrorsProvider value={fe}>
      <div className="pc-tax-body">
        <div className="pc-tax-toolbar">
          {overridden && <Badge tone="warning">Changed by your company</Badge>}
          <span className="cx-spacer" />
          {edit ? (
            <>
              <Button icon={X} label="Cancel" onClick={() => setEdit(null)} disabled={busy} />
              <Button variant="primary" icon={Save} label="Save changes" onClick={() => void save()} busy={busy} />
            </>
          ) : (
            isAdmin && (
              <>
                <Button icon={RotateCcw} label="Restore built-in" onClick={() => void restore()} disabled={!overridden || busy} />
                <Button icon={Pencil} label="Edit" onClick={() => setEdit(JSON.parse(JSON.stringify(fed)))} />
              </>
            )
          )}
        </div>
        {(fe.message || fe.hasErrors) && <ErrorBanner errors={fe.errors} message={fe.message} onDismiss={() => fe.clearAll()} />}
        <div className="pc-tax-cols">
          <div className="pc-tax-col">
            <div className="cx-section-title">Social security and Medicare</div>
            <Kv
              rows={[
                ['Social security rate (each)', num('ssRate')],
                ['Social security wage base', num('ssWageBase', { money: true })],
                ['Medicare rate (each)', num('medicareRate')],
                ['Additional Medicare rate', num('addlMedicareRate')],
                ['Additional Medicare over', num('addlMedicareThreshold', { money: true })],
              ]}
            />
            <div className="cx-section-title">Federal unemployment (FUTA)</div>
            <Kv
              rows={[
                ['Gross rate', num('futaGrossRate')],
                ['Rate after state credit', num('futaRate')],
                ['Wage base', num('futaWageBase', { money: true })],
                [
                  <>
                    Credit reduction states <HelpTip term="Credit reduction" size={13} />
                  </>,
                  edit ? (
                    <CreditEditor value={edit.creditReduction ?? {}} onChange={(m) => setF({ creditReduction: m })} />
                  ) : credit.length ? (
                    credit.map(([s, r]) => `${s} ${pct(r)}`).join(', ')
                  ) : (
                    <span className="cx-muted">None</span>
                  ),
                ],
              ]}
            />
            {!edit && credit.length === 0 && (
              <div className="cx-hint pc-credit-note">
                The Department of Labor names the credit reduction states of a year after November 10 (California, for example, owes a federal loan).
                {isAdmin
                  ? ' When they are published, click Edit and add each state with its rate (for example 1.2%): Form 940 Schedule A and the liability balances use them.'
                  : ' A SerieX Books administrator can enter them here when they are published.'}
              </div>
            )}
            <div className="cx-section-title">Federal income tax withholding (Pub 15-T)</div>
            <Kv
              rows={[
                ['Supplemental wages (bonus) rate', num('supplementalRate')],
                ['Supplemental wages over $1 million', num('supplementalOver1MRate')],
                ['Step 1(g) amount, married filing jointly', num('line1gMfj', { money: true })],
                ['Step 1(g) amount, other', num('line1gOther', { money: true })],
                ['Allowance (W-4 2019 or earlier)', num('allowanceAmount', { money: true })],
                ['Nonresident alien amount (2020+ W-4)', num('nra2020', { money: true })],
                ['Nonresident alien amount (2019 W-4)', num('nraPre2020', { money: true })],
              ]}
            />
            <div className="cx-section-title">Benefit limits</div>
            <Kv rows={Object.entries(f.limits ?? {}).map(([k, v]) => [LIMIT_LABELS[k] ?? k, money0(v)])} />
            {(fed.sources?.length ?? 0) > 0 && (
              <>
                <div className="cx-section-title">Sources</div>
                <ul className="pc-sources">
                  {fed.sources.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              </>
            )}
            {fed.verified && <div className="cx-hint">{fed.verified}</div>}
          </div>
          <div className="pc-tax-col">
            <div className="cx-section-title">Withholding tables (annual percentage method)</div>
            <div className="cx-row" style={{ gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
              <Select
                value={table}
                width={290}
                aria-label="Table"
                onChange={(v) => setTable(v as typeof table)}
                options={(['standard', 'checkbox', 'pre2020'] as const).map((k) => ({ value: k, label: TABLE_LABELS[k] }))}
              />
              <Select value={st} width={250} aria-label="Filing status" onChange={setStatus} options={statuses.map((s) => ({ value: s, label: STATUS_LABELS[s] ?? s }))} />
            </div>
            <BracketTable rows={fed[table]?.[st] ?? []} />
            <div className="cx-hint">Annual amounts. The federal tables are the official IRS tables and cannot be edited here.</div>
          </div>
        </div>
      </div>
    </FormErrorsProvider>
  );
}

function CreditEditor({ value, onChange }: { value: Record<string, number>; onChange: (m: Record<string, number>) => void }) {
  const rows = Object.entries(value).sort((a, b) => a[0].localeCompare(b[0]));
  return (
    <div className="cx-stack" style={{ gap: 4 }}>
      {rows.map(([s, r]) => (
        <div key={s} className="cx-row" style={{ gap: 6 }}>
          <b style={{ width: 28 }}>{s}</b>
          <NumberField value={r} decimals={4} suffix="%" width={90} aria-label={`${s} credit reduction`} onChange={(v) => onChange({ ...value, [s]: v ?? 0 })} />
          <button
            type="button"
            className="sx-iconbtn"
            title="Remove"
            aria-label={`Remove ${s}`}
            onClick={() => {
              const n = { ...value };
              delete n[s];
              onChange(n);
            }}
          >
            <Trash2 size={13} />
          </button>
        </div>
      ))}
      <StatePicker value={null} width={110} placeholder="Add state" aria-label="Add a credit reduction state" onChange={(c) => c && onChange({ ...value, [c]: value[c] ?? 0.3 })} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// States

function StatesPanel({
  year,
  states,
  sel,
  onSel,
  isAdmin,
  onEditing,
}: {
  year: number;
  states: StateTaxSummary[];
  sel: string;
  onSel: (s: string) => void;
  isAdmin: boolean;
  onEditing: (on: boolean) => void;
}) {
  const [q, setQ] = useState('');
  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    return states.filter((s) => !t || s.state.toLowerCase() === t || s.name.toLowerCase().includes(t));
  }, [states, q]);
  const cur = sel || rows[0]?.state || '';
  const columns: ListColumn<StateTaxSummary>[] = [
    {
      key: 'name',
      label: 'State',
      width: 150,
      grow: true,
      render: (s) => (
        <span className="pc-taxstate-name">
          <b>{s.state}</b> {s.name}
          {s.overridden && (
            <Badge tone="warning" title="Changed by your company">
              Changed
            </Badge>
          )}
        </span>
      ),
      sortValue: (s) => s.name,
    },
    {
      key: 'method',
      label: 'Income tax',
      width: 104,
      render: (s) => (s.method === 'flat' ? `Flat ${pct(s.flatRate)}` : (METHOD_LABELS[s.method] ?? s.method)),
    },
    { key: 'suiWageBase', label: 'SUI base', width: 92, align: 'right', render: (s) => money0(s.suiWageBase) },
    { key: 'suiNewRate', label: 'New SUI', width: 84, align: 'right', render: (s) => pct(s.suiNewRate) },
  ];
  return (
    <div className="pc-taxstates">
      <div className="pc-taxstates-list">
        <SearchBox value={q} onChange={setQ} placeholder="Find a state" aria-label="Find a state" />
        <ListView<StateTaxSummary>
          columns={columns}
          rows={rows}
          getKey={(s) => s.state}
          selectedKey={cur}
          onSelect={(k) => onSel(String(k))}
          persistKey="taxStates"
          aria-label="States"
          className="pc-taxstates-lv"
        />
      </div>
      <div className="pc-taxstates-detail">{cur ? <StateDetail key={`${year}:${cur}`} year={year} code={cur} isAdmin={isAdmin} overridden={!!states.find((s) => s.state === cur)?.overridden} onEditing={onEditing} /> : null}</div>
    </div>
  );
}

function StateDetail({ year, code, isAdmin, overridden, onEditing }: { year: number; code: string; isAdmin: boolean; overridden: boolean; onEditing: (on: boolean) => void }) {
  const q = useQuery({
    queryKey: ['tax-tables', year, 'state', code],
    queryFn: ({ signal }) => api.get<StateTax>(`/tax-tables/${year}/states/${code}`, { signal }),
  });
  const [edit, setEdit] = useState<StateTax | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const fe = useFormErrors();
  const st = edit ?? q.data;
  useEffect(() => {
    onEditing(!!edit);
  }, [!!edit]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onEditing(false), []); // eslint-disable-line react-hooks/exhaustive-deps
  if (q.isLoading) return <Spinner label="Loading..." />;
  if (q.error || !st) return <div className="cx-note cx-bad">{errText(q.error)}</div>;

  const statuses = Object.keys(st.income.statuses ?? {});
  const curStatus = statuses.includes(status) ? status : (statuses.includes(st.income.defaultStatus) ? st.income.defaultStatus : statuses[0]) ?? '';
  const ss: StateStatus | undefined = st.income.statuses?.[curStatus];

  const setInc = (p: Partial<StateTax['income']>) => setEdit((c) => (c ? { ...c, income: { ...c.income, ...p } } : c));
  const setSui = (p: Partial<StateTax['sui']>) => setEdit((c) => (c ? { ...c, sui: { ...c.sui, ...p } } : c));
  const setStatusRow = (p: Partial<StateStatus>) =>
    setEdit((c) => (c ? { ...c, income: { ...c.income, statuses: { ...c.income.statuses, [curStatus]: { ...c.income.statuses[curStatus], ...p } } } } : c));
  const setProg = (i: number, p: Partial<StateProgram>) => setEdit((c) => (c ? { ...c, programs: c.programs.map((x, j) => (j === i ? { ...x, ...p } : x)) } : c));

  const save = async () => {
    if (!edit) return;
    fe.clearAll();
    setBusy(true);
    try {
      const saved = await api.put<StateTax>(`/tax-tables/${year}/states/${code}`, edit);
      queryClient.setQueryData(['tax-tables', year, 'state', code], saved);
      await queryClient.invalidateQueries({ queryKey: ['tax-tables'] });
      void invalidateAll();
      setEdit(null);
      toast(`The ${year} ${st.name} tax table was changed for this company`);
    } catch (e) {
      fe.fromError(e);
    } finally {
      setBusy(false);
    }
  };
  const restore = async () => {
    if (!(await confirmBox(`Go back to the built-in ${year} ${st.name} tax table? The changes your company made to it are removed.`, 'Tax Tables'))) return;
    setBusy(true);
    try {
      const saved = await api.del<StateTax>(`/tax-tables/${year}/states/${code}`);
      if (saved) queryClient.setQueryData(['tax-tables', year, 'state', code], saved);
      await queryClient.invalidateQueries({ queryKey: ['tax-tables'] });
      void invalidateAll();
      setEdit(null);
      toast(`The built-in ${year} ${st.name} tax table is used again`);
    } catch (e) {
      fe.fromError(e);
    } finally {
      setBusy(false);
    }
  };

  const ed = !!edit;
  const pctCell = (v: number | null, on: (v: number | null) => void, label: string, nullable = false) =>
    ed ? <NumberField value={v} nullable={nullable} decimals={4} suffix="%" width={100} onChange={on} aria-label={label} /> : v === null ? <span className="cx-muted">—</span> : pct(v);
  const moneyCell = (v: number | null, on: (v: number | null) => void, label: string, nullable = false) =>
    ed ? <MoneyField value={v} nullable={nullable} width={120} onChange={on} aria-label={label} /> : v === null ? <span className="cx-muted">no limit</span> : money0(v);
  const textCell = (v: string, on: (v: string) => void, label: string) => (ed ? <TextField value={v} onChange={on} aria-label={label} /> : v || <span className="cx-muted">—</span>);

  return (
    <FormErrorsProvider value={fe}>
      <div className="pc-statedet" data-state={code}>
        <div className="pc-tax-toolbar">
          <div className="cx-h2" style={{ margin: 0 }}>
            {st.name} ({code})
          </div>
          {overridden && <Badge tone="warning">Changed by your company</Badge>}
          <span className="cx-spacer" />
          {ed ? (
            <>
              <Button icon={X} label="Cancel" onClick={() => setEdit(null)} disabled={busy} />
              <Button variant="primary" icon={Save} label="Save changes" onClick={() => void save()} busy={busy} />
            </>
          ) : (
            isAdmin && (
              <>
                <Button icon={RotateCcw} label="Restore built-in" onClick={() => void restore()} disabled={!overridden || busy} />
                <Button icon={Pencil} label="Edit" onClick={() => setEdit(JSON.parse(JSON.stringify(q.data)))} />
              </>
            )
          )}
        </div>
        {(fe.message || fe.hasErrors) && <ErrorBanner errors={fe.errors} message={fe.message} onDismiss={() => fe.clearAll()} />}
        {st.confidence && st.confidence !== 'high' && (
          <div className="cx-note cx-warn cx-small" role="note">
            Check these rates with {checkWith(st)} before relying on them.
          </div>
        )}

        <div className="cx-section-title">Income tax withholding</div>
        <Kv
          rows={[
            [
              'State income tax',
              ed ? <Checkbox checked={st.income.has} onChange={(v) => setInc({ has: v })} label="This state taxes wages" /> : st.income.has ? 'Yes' : 'No income tax on wages',
            ],
            ...(st.income.has
              ? ([
                  [
                    'Method',
                    ed ? (
                      <Select
                        value={st.income.method}
                        width={160}
                        aria-label="Method"
                        onChange={(v) => setInc({ method: v as StateTax['income']['method'] })}
                        options={(['flat', 'brackets', 'special'] as const).map((m) => ({ value: m, label: METHOD_LABELS[m] }))}
                      />
                    ) : (
                      (METHOD_LABELS[st.income.method] ?? st.income.method) + (st.income.special ? ` (${st.income.special})` : '')
                    ),
                  ],
                  ...(st.income.method === 'flat' ? ([['Flat rate', pctCell(st.income.flatRate, (v) => setInc({ flatRate: v ?? 0 }), 'Flat rate')]] as [ReactNode, ReactNode][]) : []),
                  ['Supplemental (bonus) rate', pctCell(st.income.supplementalRate, (v) => setInc({ supplementalRate: v }), 'Supplemental rate', true)],
                  ['Employee form', st.income.stateForm || (st.income.usesFederalW4 ? 'Federal Form W-4' : '—')],
                  [
                    'Allowances',
                    st.income.allowance.kind === 'none'
                      ? 'Not used'
                      : `${st.income.allowance.kind === 'credit' ? 'Credit' : st.income.allowance.kind === 'deduction' ? 'Deduction' : 'Deduction and credit'}: ${
                          st.income.allowance.deductionPerAllowance ? money0(st.income.allowance.deductionPerAllowance) + ' deduction' : ''
                        }${st.income.allowance.deductionPerAllowance && st.income.allowance.creditPerAllowance ? ', ' : ''}${
                          st.income.allowance.creditPerAllowance ? '$' + st.income.allowance.creditPerAllowance + ' credit' : ''
                        } per allowance per year`,
                  ],
                ] as [ReactNode, ReactNode][])
              : []),
          ]}
        />
        {st.income.has && statuses.length > 0 && (
          <div className="pc-statusbox">
            <div className="cx-row" style={{ gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
              <Select value={curStatus} width={300} aria-label="Filing status" onChange={setStatus} options={statuses.map((k) => ({ value: k, label: st.income.statuses[k].label || k }))} />
              <span className="cx-small cx-muted">Standard deduction</span>
              {ss && moneyCell(ss.standardDeduction, (v) => setStatusRow({ standardDeduction: v ?? 0 }), 'Standard deduction')}
              {ss && (ss.lowIncomeExemption > 0 || ed) && <span className="cx-small cx-muted">Low income exemption</span>}
              {ss && (ss.lowIncomeExemption > 0 || ed) && moneyCell(ss.lowIncomeExemption, (v) => setStatusRow({ lowIncomeExemption: v ?? 0 }), 'Low income exemption')}
            </div>
            {ss && st.income.method !== 'flat' && <BracketTable rows={ss.brackets} edit={ed} onChange={(rows) => setStatusRow({ brackets: rows })} />}
            {ed && <div className="cx-hint">The “Tax is” column is recomputed from the brackets when you save.</div>}
          </div>
        )}
        {st.income.formula && <div className="cx-hint">Formula: {st.income.formula}</div>}

        <div className="cx-section-title">Unemployment (SUI)</div>
        <Kv
          rows={[
            ['Wage base', moneyCell(st.sui.wageBase, (v) => setSui({ wageBase: v ?? 0 }), 'SUI wage base')],
            ['New employer rate', pctCell(st.sui.newEmployerRate, (v) => setSui({ newEmployerRate: v ?? 0 }), 'New employer rate')],
            ['Rate range', ed ? <span className="cx-row">{pctCell(st.sui.minRate, (v) => setSui({ minRate: v ?? 0 }), 'Minimum rate')} to {pctCell(st.sui.maxRate, (v) => setSui({ maxRate: v ?? 0 }), 'Maximum rate')}</span> : `${pct(st.sui.minRate)} to ${pct(st.sui.maxRate)}`],
            ['Employee rate', pctCell(st.sui.employeeRate, (v) => setSui({ employeeRate: v ?? 0 }), 'Employee rate')],
            ...(st.sui.employeeRate > 0 || ed ? ([['Employee wage base', moneyCell(st.sui.employeeWageBase, (v) => setSui({ employeeWageBase: v }), 'Employee wage base', true)]] as [ReactNode, ReactNode][]) : []),
            ['Agency', textCell(st.sui.agency, (v) => setSui({ agency: v }), 'SUI agency')],
          ]}
        />
        {st.sui.notes && <div className="cx-hint">{st.sui.notes}</div>}

        {(st.programs.length > 0 || ed) && (
          <>
            <div className="cx-section-title">Other state taxes (disability, family leave, training...)</div>
            <table className="pc-programs">
              <thead>
                <tr>
                  <th>Key</th>
                  <th>Name</th>
                  <th className="cx-right">Employee</th>
                  <th className="cx-right">Company</th>
                  <th className="cx-right">Wage base</th>
                  <th className="cx-right">Employee maximum</th>
                  {ed && <th />}
                </tr>
              </thead>
              <tbody>
                {st.programs.map((p, i) => (
                  <tr key={i} title={p.notes}>
                    <td>{ed ? <TextField value={p.key} onChange={(v) => setProg(i, { key: v.toUpperCase() })} width={70} aria-label="Program key" /> : <b>{p.key}</b>}</td>
                    <td>{ed ? <TextField value={p.name} onChange={(v) => setProg(i, { name: v })} width={190} aria-label="Program name" /> : p.name}</td>
                    <td className="cx-right">{pctCell(p.employeeRate, (v) => setProg(i, { employeeRate: v ?? 0 }), `${p.key} employee rate`)}</td>
                    <td className="cx-right">{pctCell(p.employerRate, (v) => setProg(i, { employerRate: v ?? 0 }), `${p.key} company rate`)}</td>
                    <td className="cx-right">{moneyCell(p.wageBase, (v) => setProg(i, { wageBase: v }), `${p.key} wage base`, true)}</td>
                    <td className="cx-right">{moneyCell(p.maxEmployee, (v) => setProg(i, { maxEmployee: v }), `${p.key} employee maximum`, true)}</td>
                    {ed && (
                      <td>
                        <button
                          type="button"
                          className="sx-iconbtn"
                          title="Remove this program"
                          aria-label={`Remove ${p.key}`}
                          onClick={() => setEdit((c) => (c ? { ...c, programs: c.programs.filter((_, j) => j !== i) } : c))}
                        >
                          <Trash2 size={13} />
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
                {ed && (
                  <tr>
                    <td colSpan={7}>
                      <button
                        type="button"
                        className="sx-linkbtn cx-small"
                        onClick={() =>
                          setEdit((c) => (c ? { ...c, programs: [...c.programs, { key: 'NEW', name: 'New program', employeeRate: 0, employerRate: 0, wageBase: null, maxEmployee: null, notes: '' }] } : c))
                        }
                      >
                        <Plus size={12} style={{ verticalAlign: '-2px' }} /> Add a program
                      </button>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </>
        )}

        <div className="cx-section-title">Agencies and filing</div>
        <Kv
          rows={[
            ['Withholding agency', textCell(st.agencyWithholding, (v) => setEdit((c) => (c ? { ...c, agencyWithholding: v } : c)), 'Withholding agency')],
            ['Unemployment agency', textCell(st.agencyUnemployment, (v) => setEdit((c) => (c ? { ...c, agencyUnemployment: v } : c)), 'Unemployment agency')],
            ['Deposits', st.deposit || '—'],
            ['Quarterly report', st.quarterlyReport || '—'],
            ['Annual reconciliation', st.annualReconciliation || '—'],
            ['Local taxes', st.income.localTaxes || '—'],
          ]}
        />
        {ed ? (
          <>
            <div className="cx-section-title">Notes</div>
            <TextArea value={st.notes} onChange={(v) => setEdit((c) => (c ? { ...c, notes: v } : c))} height={60} aria-label="Notes" />
          </>
        ) : (
          st.notes && <div className="cx-hint">{st.notes}</div>
        )}
        {st.sources.length > 0 && (
          <>
            <div className="cx-section-title">Sources</div>
            <ul className="pc-sources">
              {st.sources.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </>
        )}
      </div>
    </FormErrorsProvider>
  );
}

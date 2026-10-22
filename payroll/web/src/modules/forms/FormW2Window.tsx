// W-2/W-3 for a year: the employees paid in the year (✓ selected for printing, EMPLOYEE, SSN,
// REVIEWED, boxes 1-6), the review panel of the highlighted employee drawn like Form W-2 (every
// box, box 14b tipped occupation codes editable), the W-3 totals, Print W-2s (Copies B, C, 2,
// D, 1 with full SSNs fetched with reveal=1 for administrators), Print W-3, Export EFW2 (SSA
// electronic file with the submitter fields), Save (reviewed marks) and Mark as Filed.
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCheck, ChevronLeft, ChevronRight, FileDown, FileText, Printer, ShieldCheck, Square } from 'lucide-react';
import { ApiError, api, qs } from '@/api/client';
import { queryClient } from '@/api/hooks';
import type { Box12, FormCompany, W2, W2Result, W3 } from '@/api/types';
import {
  Button,
  Checkbox,
  EmptyState,
  Field,
  Grid,
  Select,
  Spinner,
  StatusPill,
  Tabs,
  TextField,
  ToolSeparator,
  ToolbarButton,
  ToolbarSpacer,
  alertBox,
  confirmBox,
  showDialog,
  toast,
  type GridColumn,
} from '@/components';
import { useSession } from '@/state/session';
import { useWindow } from '@/windows/WindowContext';
import { getCompanyId } from '@/api/client';
import { escHtml, printHtml } from '@/util/print';
import { fmtDate, fmtMoney } from '@/util/format';
import { YearSelect, stampDate, useFormYears, usePeriodSwitch } from './period';
import './forms.css';

export interface FormW2WindowProps {
  /** Year. */
  year: number;
}

interface Row {
  id: number;
  sel: boolean;
  reviewed: boolean;
  w: W2;
}

const isCancel = (e: unknown) => e instanceof ApiError && e.code === 'cancelled';

/** Last code of each group of the Treasury Tipped Occupation Code list (101-110, 201-211, ... 801-810). */
const TTOC_LAST: Record<string, number> = { '1': 10, '2': 11, '3': 4, '4': 9, '5': 10, '6': 11, '7': 6, '8': 10 };

/** "000" (not a qualifying occupation) or a code of the Treasury Tipped Occupation Code list. */
export function validTTOC(cd: string): boolean {
  if (!/^\d{3}$/.test(cd)) return false;
  if (cd === '000') return true;
  const n = +cd.slice(1);
  return n >= 1 && n <= (TTOC_LAST[cd[0]] ?? 0);
}

/** Employer signature PIN of SSA Business Services Online: S-123456-7. */
const PIN_RE = /^S-\d{6}-\d$/;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function FormW2Window(props: FormW2WindowProps) {
  const win = useWindow();
  const now = new Date();
  const def = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
  const years = useFormYears([props.year ?? def]);
  const { period, change } = usePeriodSwitch('formW2', { year: props.year || def });
  const year = period.year;
  const isAdmin = useSession((s) => s.isAdmin);
  const q = useQuery({
    queryKey: ['w2', year],
    queryFn: ({ signal }) => api.get<W2Result>('/forms/w2' + qs({ year }), { signal }),
    staleTime: 0,
  });
  const data = q.data;
  const [reviewed, setReviewed] = useState<Set<number>>(new Set());
  const [notSel, setNotSel] = useState<Set<number>>(new Set());
  const [cur, setCur] = useState<number | null>(null);
  const [tab, setTab] = useState<'w2' | 'w3'>('w2');
  const [busy, setBusy] = useState(false);
  const saving = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    if (!data) return;
    setReviewed(new Set(data.employees.filter((e) => e.reviewed).map((e) => e.employeeId)));
    setCur((c) => (c && data.employees.some((e) => e.employeeId === c) ? c : (data.employees[0]?.employeeId ?? null)));
  }, [data]);

  const rows: Row[] = useMemo(() => (data?.employees ?? []).map((w) => ({ id: w.employeeId, sel: !notSel.has(w.employeeId), reviewed: reviewed.has(w.employeeId), w })), [data, reviewed, notSel]);
  const selected = rows.filter((r) => r.sel);
  const curRow = rows.find((r) => r.id === cur) ?? null;
  const curIdx = curRow ? rows.indexOf(curRow) : -1;

  /** Saves the review marks (and optionally the status / box 14b codes). */
  const put = (body: { reviewed: number[]; status?: string; occupationCodes?: Record<string, string[]> }) => {
    const p = saving.current.then(() => api.put<W2Result>('/forms/w2' + qs({ year }), body));
    saving.current = p.catch(() => undefined);
    return p;
  };
  const setReviewedAndSave = async (next: Set<number>) => {
    setReviewed(next);
    try {
      const res = await put({ reviewed: [...next] });
      queryClient.setQueryData(['w2', year], res);
      void queryClient.invalidateQueries({ queryKey: ['filings'] });
    } catch (e) {
      if (!isCancel(e)) await alertBox(msg(e), 'W-2/W-3', 'error');
      void q.refetch();
    }
  };

  const onRows = (list: Row[]) => {
    const ns = new Set(notSel);
    const rv = new Set(reviewed);
    let rvChanged = false;
    for (const r of list) {
      if (r.sel) ns.delete(r.id);
      else ns.add(r.id);
      if (r.reviewed !== reviewed.has(r.id)) {
        rvChanged = true;
        if (r.reviewed) rv.add(r.id);
        else rv.delete(r.id);
      }
    }
    setNotSel(ns);
    if (rvChanged) void setReviewedAndSave(rv);
  };

  const markAll = (on: boolean) => void setReviewedAndSave(on ? new Set(rows.map((r) => r.id)) : new Set());

  const markFiled = async () => {
    if (!data) return;
    const missing = rows.filter((r) => !r.reviewed);
    const warn = rows.filter((r) => r.w.warnings.length);
    const text =
      (missing.length ? `${missing.length} W-2${missing.length === 1 ? ' is' : 's are'} not marked as reviewed. ` : '') +
      (warn.length ? `${warn.length} W-2${warn.length === 1 ? ' has' : 's have'} warnings. ` : '') +
      `Mark the ${year} W-2s and W-3 as filed?\n\nSerieX Payroll keeps a copy of the forms as filed.`;
    if (!(await confirmBox(text, 'Mark as Filed'))) return;
    setBusy(true);
    try {
      const res = await put({ reviewed: [...reviewed], status: 'filed' });
      queryClient.setQueryData(['w2', year], res);
      void queryClient.invalidateQueries({ queryKey: ['filings'] });
      toast(`W-2/W-3 ${year} marked as filed`);
    } catch (e) {
      if (!isCancel(e)) await alertBox(msg(e), 'W-2/W-3', 'error');
    } finally {
      setBusy(false);
    }
  };

  const saveCodes = async (id: number, codes: string[]) => {
    if (!data) return;
    const clean = codes.map((c) => c.trim()).filter(Boolean);
    const bad = clean.find((c) => !validTTOC(c));
    if (bad) return void alertBox(`${bad} is not a Treasury Tipped Occupation Code. Enter a 3-digit code of the Treasury list (101 to 810, for example 102 Wait staff), or 000 for an occupation that does not qualify.`, 'Box 14b', 'warning');
    if (clean.length === 2 && clean[0] === clean[1]) return void alertBox('Enter two different occupation codes in box 14b (or only one).', 'Box 14b', 'warning');
    const occ: Record<string, string[]> = {};
    for (const e of data.employees) occ[String(e.employeeId)] = e.box14b ?? [];
    occ[String(id)] = codes.map((c) => c.trim()).filter(Boolean);
    try {
      const res = await put({ reviewed: [...reviewed], occupationCodes: occ });
      queryClient.setQueryData(['w2', year], res);
      toast('Box 14b codes saved');
    } catch (e) {
      if (!isCancel(e)) await alertBox(msg(e), 'Box 14b', 'error');
    }
  };

  // ---- printing
  /** W-2 data with full SSNs (administrators); masked SSNs otherwise. */
  const revealed = async (): Promise<{ res: W2Result; masked: boolean } | null> => {
    try {
      return { res: await api.get<W2Result>('/forms/w2' + qs({ year, reveal: 1 }), { noPrompt: true }), masked: false };
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'forbidden' || e.status === 403)) {
        await alertBox(`${e.message}\n\nThe forms print with masked social security numbers (only the last four digits).`, 'Print W-2', 'warning');
        return data ? { res: data, masked: true } : null;
      }
      await alertBox(msg(e), 'Print W-2', 'error');
      return null;
    }
  };

  const printW2s = async () => {
    if (!data) return;
    if (!selected.length) return void alertBox('Check the employees whose W-2s you want to print (✓ column).', 'Print W-2');
    const opts = await showDialog<PrintOpts | null>({ title: 'Print W-2 and W-3 Forms', width: 520, cancelValue: null, render: (close) => <PrintBody count={selected.length} close={close} /> });
    if (!opts) return;
    const r = await revealed();
    if (!r) return;
    const ids = new Set(selected.map((s) => s.id));
    const list = r.res.employees.filter((e) => ids.has(e.employeeId));
    let html = '';
    if (opts.list) html += listHtml(year, list);
    for (const w of list) {
      const copies = COPIES.filter((c) => opts.copies.includes(c.key));
      html += copies.map((c) => `<div class="w2page">${w2Html(w, r.res.company, c.title, c.key)}</div>`).join('');
    }
    if (opts.w3) html += `<div class="w2page">${w3Html(r.res.w3, r.res.company)}</div>`;
    await printHtml(`W-2 ${year}`, html, W2_CSS);
  };
  const printW3 = async () => {
    if (!data) return;
    const r = await revealed();
    if (!r) return;
    await printHtml(`W-3 ${year}`, `<div class="w2page">${w3Html(r.res.w3, r.res.company)}</div>`, W2_CSS);
  };

  const exportEfw2 = async () => {
    if (!data) return;
    const p = await showDialog<Efw2Params | null>({ title: 'Export W-2 Electronic File (EFW2)', width: 560, cancelValue: null, render: (close) => <Efw2Body company={data.company} close={close} /> });
    if (!p) return;
    try {
      await api.download(
        '/forms/w2/efw2' +
          qs({
            year,
            submitterId: p.submitterId,
            submitterName: p.submitterName,
            contact: p.contact,
            phone: p.phone,
            ext: p.ext,
            email: p.email,
            fax: p.fax,
            preparer: p.preparer,
            resub: p.resub ? 1 : undefined,
            wfid: p.resub ? p.wfid : undefined,
            terminating: p.terminating ? 1 : undefined,
            pin: p.pin || undefined,
          }),
        `W2REPORT_${year}.txt`,
      );
      toast(`EFW2 file W2REPORT_${year}.txt created for ${data.employees.length} employee${data.employees.length === 1 ? '' : 's'}`);
    } catch (e) {
      if (!isCancel(e)) await alertBox(msg(e), 'Export EFW2', 'error');
    }
  };

  const columns: GridColumn<Row>[] = [
    { key: 'sel', label: '✓', width: 36, editor: 'checkbox', title: 'Print the W-2 of this employee' },
    { key: 'name', label: 'EMPLOYEE', width: 170, grow: true, render: (r) => `${r.w.lastName}, ${r.w.firstName}${r.w.middleInitial ? ' ' + r.w.middleInitial : ''}` },
    { key: 'ssn', label: 'SSN', width: 110, render: (r) => r.w.ssn || <span className="fx-danger">missing</span> },
    { key: 'reviewed', label: 'REVIEWED?', width: 86, editor: 'checkbox', title: 'You reviewed this W-2' },
    { key: 'b1', label: 'BOX 1 WAGES', width: 112, align: 'right', render: (r) => fmtMoney(r.w.box1), title: 'Box 1: wages, tips, other compensation' },
    { key: 'b2', label: 'BOX 2 FED. W/H', width: 120, align: 'right', render: (r) => fmtMoney(r.w.box2), title: 'Box 2: federal income tax withheld' },
    { key: 'b3', label: 'BOX 3 SS WAGES', width: 126, align: 'right', render: (r) => fmtMoney(r.w.box3), title: 'Box 3: social security wages' },
    { key: 'b4', label: 'BOX 4 SS TAX', width: 108, align: 'right', render: (r) => fmtMoney(r.w.box4), title: 'Box 4: social security tax withheld' },
    { key: 'b5', label: 'BOX 5 MED. WAGES', width: 138, align: 'right', render: (r) => fmtMoney(r.w.box5), title: 'Box 5: Medicare wages and tips' },
    { key: 'b6', label: 'BOX 6 MED. TAX', width: 122, align: 'right', render: (r) => fmtMoney(r.w.box6), title: 'Box 6: Medicare tax withheld' },
    { key: 'warn', label: '', width: 30, render: (r) => (r.w.warnings.length ? <AlertTriangle size={14} className="lx-warn-ico" aria-label={r.w.warnings.join(' ')} /> : null) },
  ];

  const status = data?.status === 'filed' ? 'Filed' : data?.status === 'draft' ? 'Draft' : 'New';
  return (
    <div className="fx-window">
      <div className="sx-txnbar fx-toolbar" role="toolbar" aria-label="W-2/W-3">
        <YearSelect value={year} years={years} onChange={(y) => void change({ year: y })} />
        <ToolSeparator />
        <ToolbarButton label="Mark All Reviewed" icon={CheckCheck} disabled={!rows.length} onClick={() => markAll(true)} />
        <ToolbarButton label="Unmark All" icon={Square} disabled={!reviewed.size} onClick={() => markAll(false)} />
        <ToolSeparator />
        <ToolbarButton label="Print W-2s..." icon={Printer} disabled={!rows.length} onClick={() => void printW2s()} />
        <ToolbarButton label="Print W-3" icon={FileText} disabled={!rows.length} onClick={() => void printW3()} />
        <ToolbarButton label="Export EFW2..." icon={FileDown} disabled={!rows.length || !isAdmin} title={isAdmin ? 'Create the SSA electronic W-2 file' : 'Only a SerieX Books administrator can create the W-2 file'} onClick={() => void exportEfw2()} />
        <ToolbarSpacer />
        {data && <StatusPill status={status} tone={data.status === 'filed' ? 'success' : data.status === 'draft' ? 'warning' : 'info'} detail={data.status === 'filed' && data.filedAt ? stampDate(data.filedAt) : undefined} />}
      </div>
      {q.isLoading ? (
        <Spinner center label="Preparing the W-2s..." />
      ) : q.isError || !data ? (
        <EmptyState icon={AlertTriangle} title="Could not prepare the W-2s" message={msg(q.error)} action={{ label: 'Try again', onClick: () => void q.refetch() }} />
      ) : !rows.length ? (
        <EmptyState icon={FileText} title={`No W-2s for ${year}`} message={`No employee was paid in ${year}.`} />
      ) : (
        <div className="fx-w2">
          <div className="fx-muted">
            Employees with last names A through Z ({selected.length} of {rows.length} selected for printing, {reviewed.size} reviewed). Click a row to review the W-2 below.
          </div>
          <div className="fx-w2-grid">
            <Grid<Row>
              aria-label="W-2 employees"
              columns={columns}
              rows={rows}
              onChange={onRows}
              newRow={() => rows[0]}
              allowAdd={false}
              allowInsertDelete={false}
              minRows={4}
              persistKey="w2list"
              onActiveRowChange={(i) => i !== null && rows[i] && setCur(rows[i].id)}
              rowClassName={(r) => (r.id === cur ? 'lx-row-sel' : undefined)}
            />
          </div>
          <div className="fx-w2-tot">
            <b>W-3 totals</b>
            <span className="fx-muted">({data.w3.count} forms)</span>
            <span className="fx-spacer" />
            <span>Box 1 {fmtMoney(data.w3.box1)}</span>
            <span>· Box 2 {fmtMoney(data.w3.box2)}</span>
            <span>· Box 3 {fmtMoney(data.w3.box3)}</span>
            <span>· Box 4 {fmtMoney(data.w3.box4)}</span>
            <span>· Box 5 {fmtMoney(data.w3.box5)}</span>
            <span>· Box 6 {fmtMoney(data.w3.box6)}</span>
          </div>
          <div className="fx-w2-panel">
            <Tabs
              active={tab}
              onChange={(k) => setTab(k as 'w2' | 'w3')}
              tabs={[
                { key: 'w2', label: 'Form W-2 (review)' },
                { key: 'w3', label: 'Form W-3 (transmittal)' },
              ]}
            >
              {tab === 'w2' && curRow ? (
                <div style={{ padding: 10 }}>
                  <div className="fx-w2-nav">
                    <Button small icon={ChevronLeft} label="Previous" disabled={curIdx <= 0} onClick={() => setCur(rows[curIdx - 1].id)} />
                    <Button small icon={ChevronRight} label="Next" disabled={curIdx >= rows.length - 1} onClick={() => setCur(rows[curIdx + 1].id)} />
                    <span className="fx-muted">
                      Displaying: <b>{`${curRow.w.lastName}, ${curRow.w.firstName}`.toUpperCase()}</b> · Employee {curIdx + 1} of {rows.length}
                    </span>
                    <span className="fx-spacer" />
                    <Checkbox
                      label="I reviewed this W-2"
                      checked={curRow.reviewed}
                      onChange={(v) => {
                        const n = new Set(reviewed);
                        if (v) n.add(curRow.id);
                        else n.delete(curRow.id);
                        void setReviewedAndSave(n);
                      }}
                    />
                  </div>
                  <W2Paper w={curRow.w} company={data.company} onSaveCodes={(codes) => void saveCodes(curRow.id, codes)} />
                  {curRow.w.warnings.length > 0 && (
                    <div className="fx-note fx-warn fx-w2-warn">
                      <AlertTriangle size={15} aria-hidden="true" />
                      <ul>
                        {curRow.w.warnings.map((x, i) => (
                          <li key={i}>{x}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              ) : tab === 'w3' ? (
                <div style={{ padding: 10 }}>
                  <W3Paper w3={data.w3} company={data.company} />
                </div>
              ) : null}
            </Tabs>
          </div>
        </div>
      )}
      <div className="fx-bottom">
        <span className="fx-muted">
          W-2 Copy A and the W-3 are due to the Social Security Administration by January 31, {year + 1} (file electronically with the EFW2 file). Give employees Copies B, C and 2 by the same date.
        </span>
        <span className="fx-spacer" />
        <Button variant="primary" icon={ShieldCheck} label="Mark as &Filed" busy={busy} disabled={!rows.length || busy} onClick={() => void markFiled()} />
        <Button label="Close" onClick={() => void win.close()} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Review panel (W-2 drawn like the paper form)

/** W-3 box b "Kind of Employer" text. */
function employerKind(k: string): string {
  const m: Record<string, string> = { none: 'None apply', '': 'None apply', '501c': '501c non-govt.', state: 'State/local non-501c', state501c: 'State/local 501c', federal: 'Federal govt.' };
  return m[k] ?? k;
}

function money(v: number) {
  return v ? fmtMoney(v) : '';
}

function W2Paper({ w, company, onSaveCodes }: { w: W2; company: FormCompany; onSaveCodes?: (codes: string[]) => void }) {
  const [codes, setCodes] = useState<string[]>([w.box14b?.[0] ?? '', w.box14b?.[1] ?? '']);
  useEffect(() => setCodes([w.box14b?.[0] ?? '', w.box14b?.[1] ?? '']), [w]);
  const co = company;
  const coAddr = [co.name, [co.address.line1, co.address.line2].filter(Boolean).join(', '), [co.address.city, co.address.state, co.address.zip].filter(Boolean).join(' ')].filter(Boolean).join('\n');
  const empAddr = [[w.address.line1, w.address.line2].filter(Boolean).join(', '), [w.address.city, w.address.state, w.address.zip].filter(Boolean).join(' ')].filter(Boolean).join('\n');
  const b12 = (i: number): Box12 | undefined => w.box12[i];
  const codesChanged = (codes[0] || '') !== (w.box14b?.[0] ?? '') || (codes[1] || '') !== (w.box14b?.[1] ?? '');
  return (
    <div className="fx-wform" aria-label={`Form W-2 of ${w.employeeName}`}>
      <div className="fx-wform-title">
        <b>Form W-2</b>
        <span>Wage and Tax Statement {w.year}</span>
        <span className="fx-spacer" />
        <span className="fx-muted">Department of the Treasury — Internal Revenue Service</span>
      </div>
      <div className="fx-wgrid">
        <Cell label="a  Employee's social security number" value={w.ssn || '(missing)'} />
        <Cell label="1  Wages, tips, other compensation" value={money(w.box1)} num />
        <Cell label="2  Federal income tax withheld" value={money(w.box2)} num />
        <Cell label="b  Employer identification number (EIN)" value={co.ein} />
        <Cell label="3  Social security wages" value={money(w.box3)} num />
        <Cell label="4  Social security tax withheld" value={money(w.box4)} num />
        <div className="fx-wcell fx-tall">
          <span className="fx-wlbl">c  Employer's name, address, and ZIP code</span>
          <span className="fx-wval">{coAddr}</span>
        </div>
        <Cell label="5  Medicare wages and tips" value={money(w.box5)} num />
        <Cell label="6  Medicare tax withheld" value={money(w.box6)} num />
        <Cell label="7  Social security tips" value={money(w.box7)} num />
        <Cell label="8  Allocated tips" value={money(w.box8)} num />
        <Cell label="d  Control number" value={w.controlNumber} />
        <Cell label="9" value="" />
        <Cell label="10  Dependent care benefits" value={money(w.box10)} num />
        <div className="fx-wcell">
          <span className="fx-wlbl">e  Employee's first name and initial · Last name · Suff.</span>
          <span className="fx-wval">{`${w.firstName}${w.middleInitial ? ' ' + w.middleInitial : ''} ${w.lastName}${w.suffix ? ' ' + w.suffix : ''}`}</span>
        </div>
        <Cell label="11  Nonqualified plans" value={money(w.box11)} num />
        <div className="fx-wcell fx-tall">
          <span className="fx-wlbl">12a-d  See instructions for box 12</span>
          <div className="fx-w12">
            {[0, 1, 2, 3].map((i) => (
              <Fragment key={i}>
                <span>{b12(i)?.code ?? ''}</span>
                <span className="fx-num">{b12(i) ? fmtMoney(b12(i)!.amount) : ''}</span>
              </Fragment>
            ))}
          </div>
          {w.box12.length > 4 && <span className="fx-danger">{w.box12.length - 4} more code(s): a second W-2 is needed.</span>}
        </div>
        <div className="fx-wcell">
          <span className="fx-wlbl">f  Employee's address and ZIP code</span>
          <span className="fx-wval">{empAddr}</span>
        </div>
        <div className="fx-wcell">
          <span className="fx-wlbl">13</span>
          <div className="fx-w13">
            <span>{w.statutory ? '☒' : '☐'} Statutory employee</span>
            <span>{w.retirementPlan ? '☒' : '☐'} Retirement plan</span>
            <span>{w.thirdPartySick ? '☒' : '☐'} Third-party sick pay</span>
          </div>
        </div>
        <div className="fx-wcell fx-span2">
          <span className="fx-wlbl">14a  Other</span>
          <span className="fx-wval">{w.box14.map((b) => `${b.label}  ${fmtMoney(b.amount)}`).join('\n') || ' '}</span>
        </div>
        <div className="fx-wcell">
          <span className="fx-wlbl">14b  Treasury tipped occupation code(s)</span>
          {onSaveCodes ? (
            <div className="fx-14b">
              <TextField aria-label="Box 14b first code" value={codes[0]} width={56} maxLength={3} onChange={(v) => setCodes([v.replace(/\D/g, ''), codes[1]])} />
              <TextField aria-label="Box 14b second code" value={codes[1]} width={56} maxLength={3} onChange={(v) => setCodes([codes[0], v.replace(/\D/g, '')])} />
              {codesChanged && <Button small label="Save codes" onClick={() => onSaveCodes(codes)} />}
            </div>
          ) : (
            <span className="fx-wval">{(w.box14b ?? []).join('  ')}</span>
          )}
        </div>
      </div>
      <div className="fx-wstate">
        <div>
          <span className="fx-wlbl">15  State</span>
        </div>
        <div>
          <span className="fx-wlbl">Employer's state ID number</span>
        </div>
        <div>
          <span className="fx-wlbl">16  State wages, tips, etc.</span>
        </div>
        <div>
          <span className="fx-wlbl">17  State income tax</span>
        </div>
        <div>
          <span className="fx-wlbl">18  Local wages, tips, etc.</span>
        </div>
        <div>
          <span className="fx-wlbl">19  Local income tax</span>
        </div>
        <div>
          <span className="fx-wlbl">20  Locality name</span>
        </div>
        {Array.from({ length: Math.max(1, w.states.length, w.locals.length) }, (_, i) => {
          const s = w.states[i];
          const l = w.locals[i];
          return (
            <Fragment key={i}>
              <div className="fx-wval">{s?.state ?? ''}</div>
              <div className="fx-wval">{s ? s.stateId || <span className="fx-danger">missing</span> : ''}</div>
              <div className="fx-wval fx-num">{s ? fmtMoney(s.wages) : ''}</div>
              <div className="fx-wval fx-num">{s ? fmtMoney(s.tax) : ''}</div>
              <div className="fx-wval fx-num">{l ? fmtMoney(l.wages) : ''}</div>
              <div className="fx-wval fx-num">{l ? fmtMoney(l.tax) : ''}</div>
              <div className="fx-wval">{l?.name ?? ''}</div>
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

function Cell({ label, value, num }: { label: string; value: string; num?: boolean }) {
  return (
    <div className="fx-wcell">
      <span className="fx-wlbl">{label}</span>
      <span className={'fx-wval' + (num ? ' fx-num' : '')}>{value || ' '}</span>
    </div>
  );
}

function W3Paper({ w3, company }: { w3: W3; company: FormCompany }) {
  const co = company;
  const coAddr = [co.name, [co.address.line1, co.address.line2].filter(Boolean).join(', '), [co.address.city, co.address.state, co.address.zip].filter(Boolean).join(' ')].filter(Boolean).join('\n');
  return (
    <div className="fx-wform" aria-label="Form W-3">
      <div className="fx-wform-title">
        <b>Form W-3</b>
        <span>Transmittal of Wage and Tax Statements {w3.year}</span>
      </div>
      <div className="fx-wgrid">
        <Cell label="a  Control number" value="" />
        <Cell label="1  Wages, tips, other compensation" value={money(w3.box1)} num />
        <Cell label="2  Federal income tax withheld" value={money(w3.box2)} num />
        <Cell label={`b  Kind of payer: ${w3.kindOfPayer || '941'} · Kind of employer: ${employerKind(w3.kindOfEmployer)}`} value="" />
        <Cell label="3  Social security wages" value={money(w3.box3)} num />
        <Cell label="4  Social security tax withheld" value={money(w3.box4)} num />
        <Cell label="c  Total number of Forms W-2" value={String(w3.count)} />
        <Cell label="5  Medicare wages and tips" value={money(w3.box5)} num />
        <Cell label="6  Medicare tax withheld" value={money(w3.box6)} num />
        <Cell label="e  Employer identification number (EIN)" value={co.ein} />
        <Cell label="7  Social security tips" value={money(w3.box7)} num />
        <Cell label="8  Allocated tips" value={money(w3.box8)} num />
        <div className="fx-wcell fx-tall">
          <span className="fx-wlbl">f  Employer's name · g  Employer's address and ZIP code</span>
          <span className="fx-wval">{coAddr}</span>
        </div>
        <Cell label="10  Dependent care benefits" value={money(w3.box10)} num />
        <Cell label="11  Nonqualified plans" value={money(w3.box11)} num />
        <Cell label="12a  Deferred compensation" value={money(w3.box12a)} num />
        <Cell label="14  Income tax withheld by payer of third-party sick pay" value={money(w3.box14)} num />
        <div className="fx-wcell fx-span3">
          <span className="fx-wlbl">15 State · Employer's state ID number · 16 State wages · 17 State income tax · 18 Local wages · 19 Local income tax</span>
          <span className="fx-wval">
            {w3.states.map((s) => `${s.state}  ${s.stateId || '(no ID)'}  ${fmtMoney(s.wages)}  ${fmtMoney(s.tax)}`).join('\n')}
            {w3.locals.map((l) => `\n${l.name}  ${fmtMoney(l.wages)}  ${fmtMoney(l.tax)}`).join('')}
          </span>
        </div>
        <Cell label="Contact person" value={co.contactName} />
        <Cell label="Telephone number" value={co.contactPhone} />
        <Cell label="Prepared with SerieX Payroll" value="" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Print dialog and printed forms

interface PrintOpts {
  copies: string[];
  w3: boolean;
  list: boolean;
}

const COPIES = [
  { key: 'B', title: "Copy B—To Be Filed With Employee's FEDERAL Tax Return", label: "Copy B: for the employee's federal tax return", def: true },
  { key: 'C', title: "Copy C—For EMPLOYEE'S RECORDS", label: "Copy C: for the employee's records", def: true },
  { key: '2', title: "Copy 2—To Be Filed With Employee's State, City, or Local Income Tax Return", label: "Copy 2: for the employee's state, city or local return", def: true },
  { key: 'D', title: 'Copy D—For Employer', label: 'Copy D: for your records', def: false },
  { key: '1', title: 'Copy 1—For State, City, or Local Tax Department', label: 'Copy 1: for your state, city or local tax department', def: false },
];

function PrintBody({ count, close }: { count: number; close: (v: PrintOpts | null) => void }) {
  const [copies, setCopies] = useState<string[]>(COPIES.filter((c) => c.def).map((c) => c.key));
  const [w3, setW3] = useState(false);
  const [list, setList] = useState(false);
  const toggle = (k: string, on: boolean) => setCopies((c) => (on ? [...c, k] : c.filter((x) => x !== k)));
  return (
    <div className="fx-dlg">
      <div>
        Print the W-2s of the <b>{count}</b> selected employee{count === 1 ? '' : 's'} on blank paper. Copy A for the Social Security Administration is filed electronically (Export EFW2).
      </div>
      <Field label="For employees">
        <div className="fx-dlg-checks">
          {COPIES.filter((c) => ['B', 'C', '2'].includes(c.key)).map((c) => (
            <Checkbox key={c.key} label={c.label} checked={copies.includes(c.key)} onChange={(v) => toggle(c.key, v)} />
          ))}
        </div>
      </Field>
      <Field label="For employer and government">
        <div className="fx-dlg-checks">
          {COPIES.filter((c) => ['D', '1'].includes(c.key)).map((c) => (
            <Checkbox key={c.key} label={c.label} checked={copies.includes(c.key)} onChange={(v) => toggle(c.key, v)} />
          ))}
          <Checkbox label="W-3 transmittal (1 per page)" checked={w3} onChange={setW3} />
          <Checkbox label="Print the list of selected employees" checked={list} onChange={setList} />
        </div>
      </Field>
      <div className="sx-dlg-buttons">
        <Button variant="primary" icon={Printer} label="Print" disabled={!copies.length && !w3 && !list} onClick={() => close({ copies, w3, list })} />
        <Button label="Cancel" onClick={() => close(null)} />
      </div>
    </div>
  );
}

const W2_CSS = `
  .w2page { page-break-after: always; padding: 0.1in 0; }
  .w2page:last-child { page-break-after: auto; }
  .w2 { border: 2px solid #000; margin-bottom: 0.18in; font-size: 9px; }
  .w2 .hd { display: flex; justify-content: space-between; padding: 3px 6px; border-bottom: 1px solid #000; }
  .w2 .hd b { font-size: 13px; }
  .w2 table { border-collapse: collapse; width: 100%; }
  .w2 td { border: 1px solid #000; vertical-align: top; padding: 2px 4px; height: 0.32in; }
  .w2 .l { display: block; font-size: 7.5px; color: #222; }
  .w2 .v { display: block; font-family: 'Courier New', monospace; font-size: 11px; font-weight: bold; white-space: pre-line; }
  .w2 .n { text-align: right; }
  .w2 .copy { padding: 2px 6px; font-weight: bold; border-top: 1px solid #000; }
  .lst td, .lst th { border-bottom: 1px solid #999; padding: 2px 4px; }
`;

const td = (label: string, value: string, opts: { num?: boolean; rows?: number; cols?: number } = {}) =>
  `<td${opts.rows ? ` rowspan="${opts.rows}"` : ''}${opts.cols ? ` colspan="${opts.cols}"` : ''}><span class="l">${escHtml(label)}</span><span class="v${opts.num ? ' n' : ''}">${escHtml(value) || '&nbsp;'}</span></td>`;

function w2Html(w: W2, co: FormCompany, copyTitle: string, copyKey: string): string {
  const m = (v: number) => (v ? fmtMoney(v) : '');
  const coAddr = [co.name, [co.address.line1, co.address.line2].filter(Boolean).join(', '), [co.address.city, co.address.state, co.address.zip].filter(Boolean).join(' ')].filter(Boolean).join('\n');
  const empAddr = [
    `${w.firstName}${w.middleInitial ? ' ' + w.middleInitial : ''} ${w.lastName}${w.suffix ? ' ' + w.suffix : ''}`,
    [w.address.line1, w.address.line2].filter(Boolean).join(', '),
    [w.address.city, w.address.state, w.address.zip].filter(Boolean).join(' '),
  ]
    .filter(Boolean)
    .join('\n');
  const b12 = [0, 1, 2, 3].map((i) => (w.box12[i] ? `${w.box12[i].code}  ${fmtMoney(w.box12[i].amount)}` : '')).join('\n');
  const states = w.states.map((s) => `${s.state}  ${s.stateId}`).join('\n');
  const stWages = w.states.map((s) => fmtMoney(s.wages)).join('\n');
  const stTax = w.states.map((s) => fmtMoney(s.tax)).join('\n');
  return `<div class="w2"><div class="hd"><span><b>Form W-2</b> Wage and Tax Statement</span><b>${w.year}</b><span>Copy ${escHtml(copyKey)}</span></div>
    <table>
    <tr>${td("a Employee's social security number", w.ssn)}${td('1 Wages, tips, other compensation', m(w.box1), { num: true })}${td('2 Federal income tax withheld', m(w.box2), { num: true })}</tr>
    <tr>${td('b Employer identification number (EIN)', co.ein)}${td('3 Social security wages', m(w.box3), { num: true })}${td('4 Social security tax withheld', m(w.box4), { num: true })}</tr>
    <tr>${td("c Employer's name, address, and ZIP code", coAddr, { rows: 2 })}${td('5 Medicare wages and tips', m(w.box5), { num: true })}${td('6 Medicare tax withheld', m(w.box6), { num: true })}</tr>
    <tr>${td('7 Social security tips', m(w.box7), { num: true })}${td('8 Allocated tips', m(w.box8), { num: true })}</tr>
    <tr>${td('d Control number', w.controlNumber)}${td('9', '')}${td('10 Dependent care benefits', m(w.box10), { num: true })}</tr>
    <tr>${td("e/f Employee's name, address, and ZIP code", empAddr, { rows: 2 })}${td('11 Nonqualified plans', m(w.box11), { num: true })}${td('12a-d See instructions for box 12', b12, { rows: 2 })}</tr>
    <tr>${td('13 Statutory employee / Retirement plan / Third-party sick pay', `${w.statutory ? '☒' : '☐'} Stat  ${w.retirementPlan ? '☒' : '☐'} Ret  ${w.thirdPartySick ? '☒' : '☐'} 3rd`)}</tr>
    <tr>${td('14a Other', w.box14.map((b) => `${b.label} ${fmtMoney(b.amount)}`).join('\n'), { cols: 2 })}${td('14b Treasury tipped occupation code(s)', (w.box14b ?? []).join('  '))}</tr>
    <tr>${td("15 State / Employer's state ID number", states)}${td('16 State wages, tips, etc.', stWages, { num: true })}${td('17 State income tax', stTax, { num: true })}</tr>
    <tr>${td('18 Local wages, tips, etc.', w.locals.map((l) => fmtMoney(l.wages)).join('\n'), { num: true })}${td('19 Local income tax', w.locals.map((l) => fmtMoney(l.tax)).join('\n'), { num: true })}${td('20 Locality name', w.locals.map((l) => l.name).join('\n'))}</tr>
    </table><div class="copy">${escHtml(copyTitle)} · Department of the Treasury—Internal Revenue Service</div></div>`;
}

function w3Html(w3: W3, co: FormCompany): string {
  const m = (v: number) => (v ? fmtMoney(v) : '');
  const coAddr = [co.name, [co.address.line1, co.address.line2].filter(Boolean).join(', '), [co.address.city, co.address.state, co.address.zip].filter(Boolean).join(' ')].filter(Boolean).join('\n');
  return `<div class="w2"><div class="hd"><span><b>Form W-3</b> Transmittal of Wage and Tax Statements</span><b>${w3.year}</b><span>DO NOT STAPLE</span></div><table>
    <tr>${td('a Control number', '')}${td('1 Wages, tips, other compensation', m(w3.box1), { num: true })}${td('2 Federal income tax withheld', m(w3.box2), { num: true })}</tr>
    <tr>${td('b Kind of Payer / Kind of Employer', `${w3.kindOfPayer || '941'} / ${employerKind(w3.kindOfEmployer)}`)}${td('3 Social security wages', m(w3.box3), { num: true })}${td('4 Social security tax withheld', m(w3.box4), { num: true })}</tr>
    <tr>${td('c Total number of Forms W-2', String(w3.count))}${td('5 Medicare wages and tips', m(w3.box5), { num: true })}${td('6 Medicare tax withheld', m(w3.box6), { num: true })}</tr>
    <tr>${td('e Employer identification number (EIN)', co.ein)}${td('7 Social security tips', m(w3.box7), { num: true })}${td('8 Allocated tips', m(w3.box8), { num: true })}</tr>
    <tr>${td("f/g Employer's name, address and ZIP code", coAddr, { rows: 2 })}${td('10 Dependent care benefits', m(w3.box10), { num: true })}${td('11 Nonqualified plans', m(w3.box11), { num: true })}</tr>
    <tr>${td('12a Deferred compensation', m(w3.box12a), { num: true })}${td('14 Income tax withheld by payer of third-party sick pay', m(w3.box14), { num: true })}</tr>
    <tr>${td("15 State / Employer's state ID number", w3.states.map((s) => `${s.state}  ${s.stateId}`).join('\n'))}${td('16 State wages, tips, etc.', w3.states.map((s) => fmtMoney(s.wages)).join('\n'), { num: true })}${td('17 State income tax', w3.states.map((s) => fmtMoney(s.tax)).join('\n'), { num: true })}</tr>
    <tr>${td('Employer contact person', co.contactName)}${td('Employer telephone number', co.contactPhone)}${td('18/19 Local wages / income tax', w3.locals.map((l) => `${fmtMoney(l.wages)} / ${fmtMoney(l.tax)}`).join('\n'))}</tr>
    </table><div class="copy">Send this form to the Social Security Administration with Copy A of the W-2s (not needed when you file electronically).</div></div>`;
}

function listHtml(year: number, list: W2[]): string {
  const rows = list.map((w) => `<tr><td>${escHtml(`${w.lastName}, ${w.firstName}`)}</td><td>${escHtml(w.ssn)}</td><td class="num">${fmtMoney(w.box1)}</td><td class="num">${fmtMoney(w.box2)}</td></tr>`).join('');
  return `<div class="w2page"><h1>W-2 ${year}: list of selected employees</h1><table class="lst"><tr><th>Employee</th><th>SSN</th><th class="num">Box 1</th><th class="num">Box 2</th></tr>${rows}</table></div>`;
}

// ---------------------------------------------------------------------------
// EFW2 export

interface Efw2Params {
  submitterId: string;
  submitterName: string;
  contact: string;
  phone: string;
  ext: string;
  email: string;
  fax: string;
  preparer: string;
  resub: boolean;
  wfid: string;
  terminating: boolean;
  pin: string;
}

const efwKey = () => `sxp.efw2.${getCompanyId() ?? 'none'}`;

function Efw2Body({ company, close }: { company: FormCompany; close: (v: Efw2Params | null) => void }) {
  const [p, setP] = useState<Efw2Params>(() => {
    let saved: Partial<Efw2Params> = {};
    try {
      saved = JSON.parse(localStorage.getItem(efwKey()) ?? '{}') ?? {};
    } catch {
      /* ignore */
    }
    return {
      submitterId: saved.submitterId ?? '',
      submitterName: saved.submitterName ?? company.name,
      contact: saved.contact ?? company.contactName,
      phone: saved.phone ?? company.contactPhone,
      ext: saved.ext ?? '',
      email: saved.email ?? '',
      fax: saved.fax ?? '',
      preparer: saved.preparer ?? 'L',
      resub: false,
      wfid: '',
      terminating: false,
      pin: '',
    };
  });
  const [err, setErr] = useState<string | null>(null);
  const set = (patch: Partial<Efw2Params>) => setP((x) => ({ ...x, ...patch }));
  const ok = () => {
    const id = p.submitterId.trim().toUpperCase();
    if (!/^[A-Z0-9]{8}$/.test(id)) return setErr('Enter the 8-character User ID (letters and numbers) of your SSA Business Services Online (BSO) account.');
    if (p.resub && !/^[A-Za-z0-9]{6}$/.test(p.wfid.trim())) return setErr('A resubmission needs the 6-character Wage File Identifier (WFID) from the SSA notice.');
    const pin = p.pin.trim().toUpperCase();
    if (pin && !PIN_RE.test(pin)) return setErr('The employer signature PIN has the form S-123456-7 (from SSA Business Services Online). Leave it empty if you do not sign the file with a PIN.');
    try {
      // the PIN is a signature: it is never kept in the browser
      const { resub, wfid, terminating, pin: _pin, ...keep } = p;
      localStorage.setItem(efwKey(), JSON.stringify({ ...keep, submitterId: id }));
    } catch {
      /* ignore */
    }
    close({ ...p, submitterId: id, wfid: p.wfid.trim().toUpperCase(), pin });
  };
  return (
    <div className="fx-dlg">
      <div>
        The EFW2 file holds every W-2 of the year with full social security numbers; upload it to the SSA Business Services Online (BSO) site. The submitter is the person or company
        that sends the file.
      </div>
      {err && <div className="fx-note fx-warn">{err}</div>}
      <div className="fx-dlg-grid">
        <Field label="BSO User ID (submitter ID)" htmlFor="fx-ef-id" required>
          <TextField id="fx-ef-id" value={p.submitterId} maxLength={8} onChange={(v) => set({ submitterId: v.toUpperCase() })} />
        </Field>
        <Field label="Submitter name" htmlFor="fx-ef-name">
          <TextField id="fx-ef-name" value={p.submitterName} onChange={(v) => set({ submitterName: v })} />
        </Field>
        <Field label="Contact name" htmlFor="fx-ef-contact">
          <TextField id="fx-ef-contact" value={p.contact} onChange={(v) => set({ contact: v })} />
        </Field>
        <Field label="Contact phone" htmlFor="fx-ef-phone">
          <TextField id="fx-ef-phone" value={p.phone} onChange={(v) => set({ phone: v })} />
        </Field>
        <Field label="Phone extension" htmlFor="fx-ef-ext">
          <TextField id="fx-ef-ext" value={p.ext} onChange={(v) => set({ ext: v })} />
        </Field>
        <Field label="Contact e-mail" htmlFor="fx-ef-email">
          <TextField id="fx-ef-email" value={p.email} onChange={(v) => set({ email: v })} />
        </Field>
        <Field label="Fax" htmlFor="fx-ef-fax">
          <TextField id="fx-ef-fax" value={p.fax} onChange={(v) => set({ fax: v })} />
        </Field>
        <Field label="Employer signature PIN" htmlFor="fx-ef-pin" hint="Optional, format S-123456-7">
          <TextField id="fx-ef-pin" value={p.pin} maxLength={10} placeholder="S-123456-7" autoComplete="off" onChange={(v) => set({ pin: v.toUpperCase() })} />
        </Field>
        <Field label="Preparer code" htmlFor="fx-ef-prep">
          <Select
            id="fx-ef-prep"
            value={p.preparer}
            onChange={(v) => set({ preparer: v })}
            options={[
              { value: 'L', label: 'L - Self-prepared' },
              { value: 'A', label: 'A - Accounting firm' },
              { value: 'S', label: 'S - Service bureau' },
              { value: 'P', label: 'P - Parent company' },
              { value: 'O', label: 'O - Other' },
            ]}
          />
        </Field>
      </div>
      <div className="fx-dlg-checks">
        <Checkbox label="This file replaces a file SSA rejected (resubmission)" checked={p.resub} onChange={(v) => set({ resub: v })} />
        {p.resub && (
          <Field label="Wage File Identifier (WFID)" htmlFor="fx-ef-wfid" width={220}>
            <TextField id="fx-ef-wfid" value={p.wfid} maxLength={6} onChange={(v) => set({ wfid: v.toUpperCase() })} />
          </Field>
        )}
        <Checkbox label="Terminating business (final return)" checked={p.terminating} onChange={(v) => set({ terminating: v })} />
      </div>
      <div className="sx-dlg-buttons">
        <Button variant="primary" icon={FileDown} label="Create file" onClick={ok} />
        <Button label="Cancel" onClick={() => close(null)} />
      </div>
    </div>
  );
}

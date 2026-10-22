// Create Statements: statement date, period (From/To) or "All open transactions as of statement
// date", which customers (all / several / one / of a type), "Do not create statements with a zero
// balance"; Preview shows the printable statements on screen, Print sends them to the printer.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Eye, Printer } from 'lucide-react';
import { api, qs } from '@/api/client';
import { useCompanyInfo } from '@/api/hooks';
import type { ID, Statement } from '@/api/types';
import { Button, Checkbox, DateField, EmptyState, ErrorBanner, ListPicker, NamePicker, Radio, SearchBox, Spinner, toast } from '@/components';
import { useWindow } from '@/windows/WindowContext';
import { addDays, startOfMonth, todayIso } from '@/util/dates';
import { fmtMoney } from '@/util/format';
import { printStatements, STATEMENT_PREVIEW_CSS, statementsHtml } from './printing';
import { money$, useCustomers } from './shared';
import './customers.css';

export interface CreateStatementsProps {
  customerIds?: number[];
}

type Who = 'all' | 'multiple' | 'one' | 'type';

export default function CreateStatements(props: CreateStatementsProps) {
  const win = useWindow();
  const today = todayIso();
  const customers = useCustomers().data ?? [];
  const company = useCompanyInfo().data ?? null;
  const [stmtDate, setStmtDate] = useState(today);
  const [mode, setMode] = useState<'range' | 'open'>('range');
  const [from, setFrom] = useState(startOfMonth(addDays(startOfMonth(today), -1)));
  const [to, setTo] = useState(today);
  const [who, setWho] = useState<Who>(props.customerIds?.length ? (props.customerIds.length === 1 ? 'one' : 'multiple') : 'all');
  const [chosen, setChosen] = useState<Set<ID>>(new Set(props.customerIds ?? []));
  const [one, setOne] = useState<ID | null>(props.customerIds?.length === 1 ? props.customerIds[0] : null);
  const [typeId, setTypeId] = useState<ID | null>(null);
  const [noZero, setNoZero] = useState(true);
  const [search, setSearch] = useState('');
  const [preview, setPreview] = useState<Statement[] | null>(null);
  const [busy, setBusy] = useState<false | 'preview' | 'print'>(false);
  const [err, setErr] = useState<string | null>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);

  // a job chosen elsewhere is shown on its customer's statement
  const topOf = (id: ID): ID => {
    let n = customers.find((c) => c.id === id);
    for (let i = 0; n?.parentId && i < 10; i++) n = customers.find((c) => c.id === n!.parentId);
    return n?.id ?? id;
  };
  useEffect(() => {
    if (props.customerIds?.length) {
      setChosen(new Set(props.customerIds));
      setWho(props.customerIds.length === 1 ? 'one' : 'multiple');
      setOne(props.customerIds.length === 1 ? props.customerIds[0] : null);
      setPreview(null);
    }
  }, [props.customerIds?.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    win.setTitle('Create Statements');
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const tops = useMemo(() => customers.filter((c) => !c.parentId && c.active), [customers]);
  const listed = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? tops.filter((c) => c.fullName.toLowerCase().includes(q) || c.companyName.toLowerCase().includes(q)) : tops;
  }, [tops, search]);

  const ids = (): ID[] | null => {
    if (who === 'all') return [];
    if (who === 'one') return one ? [topOf(one)] : null;
    if (who === 'multiple') return chosen.size ? [...new Set([...chosen].map(topOf))] : null;
    const list = tops.filter((c) => c.typeId === typeId).map((c) => c.id);
    return typeId ? list : null;
  };

  const load = async (): Promise<Statement[] | null> => {
    setErr(null);
    const list = ids();
    if (list === null) {
      setErr(who === 'type' ? 'Choose the customer type.' : who === 'one' ? 'Choose the customer.' : 'Check at least one customer.');
      return null;
    }
    if (who === 'type' && list.length === 0) {
      setErr('No active customers have this customer type.');
      return null;
    }
    if (mode === 'range' && from && to && from > to) {
      setErr('The "From" date must be on or before the "To" date.');
      return null;
    }
    const params = { customerIds: list.length ? list.join(',') : undefined, statementDate: stmtDate, mode, from: mode === 'range' ? from : undefined, to: mode === 'range' ? to : undefined, includeZero: noZero ? 0 : 1 };
    try {
      return await api.get<Statement[]>('/statements' + qs(params));
    } catch (e) {
      setErr((e as Error).message);
      return null;
    }
  };
  const doPreview = async () => {
    setBusy('preview');
    const r = await load();
    setBusy(false);
    if (r) setPreview(r);
  };
  const doPrint = async () => {
    setBusy('print');
    const r = preview ?? (await load());
    setBusy(false);
    if (!r) return;
    if (!r.length) {
      setErr('There are no statements to print with these choices (customers with a zero balance are skipped).');
      return;
    }
    await printStatements(r);
    toast(`${r.length} ${r.length === 1 ? 'statement' : 'statements'} sent to the printer`, { kind: 'success' });
  };

  // render the preview in an isolated frame with the print styles
  useEffect(() => {
    const f = frameRef.current;
    if (!f || !preview) return;
    const doc = f.contentDocument;
    if (!doc) return;
    doc.open();
    doc.write(
      `<!doctype html><html><head><meta charset="utf-8"><style>body{font:11px 'Segoe UI',Tahoma,Arial,sans-serif;margin:0;padding:16px;background:#e5e9ef}.page-break,.pg{background:#fff;padding:28px 32px;margin:0 auto 16px;max-width:760px;box-shadow:0 1px 4px rgba(0,0,0,.15)}table{border-collapse:collapse;width:100%}th,td{padding:2px 6px;vertical-align:top}th{text-align:left}.num{text-align:right;white-space:nowrap}h1{font-size:18px;margin:0 0 6px}${STATEMENT_PREVIEW_CSS}</style></head><body>${statementsHtml(preview, company).replace(/<div class="">/g, '<div class="pg">')}</body></html>`,
    );
    doc.close();
  }, [preview, company]);

  const totalDue = preview ? preview.reduce((s, x) => s + x.amountDue, 0) : 0;
  const changed = () => setPreview(null);

  return (
    <div className="sx-cust-cs">
      <div className="sx-cust-cs-left">
        {err && <ErrorBanner message={err} onDismiss={() => setErr(null)} />}
        <section>
          <h3>Statement date</h3>
          <DateField
            name="statementDate"
            value={stmtDate}
            onChange={(d) => {
              // the period normally ends on the statement date: keep them together
              if (to === stmtDate) setTo(d);
              setStmtDate(d);
              changed();
            }}
            width={150}
            aria-label="Statement date"
          />
        </section>
        <section>
          <h3>Statement period</h3>
          <Radio name="cs-mode" checked={mode === 'range'} onChange={() => (setMode('range'), changed())} label="Transactions in this period" />
          <div className="sx-cust-cs-indent sx-cust-inline">
            <DateField value={from} onChange={(d) => (setFrom(d), changed())} width={130} aria-label="From" disabled={mode !== 'range'} />
            <span className="sx-muted">to</span>
            <DateField value={to} onChange={(d) => (setTo(d), changed())} width={130} aria-label="To" disabled={mode !== 'range'} />
          </div>
          <Radio name="cs-mode" checked={mode === 'open'} onChange={() => (setMode('open'), changed())} label="All open transactions as of the statement date" />
        </section>
        <section>
          <h3>Select customers</h3>
          <Radio name="cs-who" checked={who === 'all'} onChange={() => (setWho('all'), changed())} label="All customers" />
          <Radio name="cs-who" checked={who === 'multiple'} onChange={() => (setWho('multiple'), changed())} label={`Multiple customers${chosen.size ? ` (${chosen.size} chosen)` : ''}`} />
          {who === 'multiple' && (
            <div className="sx-cust-cs-indent sx-cust-cs-multi">
              <SearchBox value={search} onChange={setSearch} placeholder="Find a customer" />
              <div className="sx-cust-cs-checklist">
                {listed.map((c) => (
                  <Checkbox
                    key={c.id}
                    checked={chosen.has(c.id)}
                    onChange={(v) => {
                      const n = new Set(chosen);
                      if (v) n.add(c.id);
                      else n.delete(c.id);
                      setChosen(n);
                      changed();
                    }}
                    label={
                      <span className="sx-cust-cs-cust">
                        <span>{c.fullName}</span>
                        <span className="sx-muted">{c.balance ? fmtMoney(c.balance) : ''}</span>
                      </span>
                    }
                  />
                ))}
              </div>
              <div className="sx-cust-inline">
                <button type="button" className="sx-linkbtn" onClick={() => (setChosen(new Set(listed.map((c) => c.id))), changed())}>
                  Select all
                </button>
                <button type="button" className="sx-linkbtn" onClick={() => (setChosen(new Set(listed.filter((c) => Math.abs(c.balance) > 0.004).map((c) => c.id))), changed())}>
                  With a balance
                </button>
                <button type="button" className="sx-linkbtn" onClick={() => (setChosen(new Set()), changed())}>
                  Clear
                </button>
              </div>
            </div>
          )}
          <Radio name="cs-who" checked={who === 'one'} onChange={() => (setWho('one'), changed())} label="One customer" />
          {who === 'one' && (
            <div className="sx-cust-cs-indent">
              <NamePicker kinds={['customer']} value={one} onChange={(id) => (setOne(id), changed())} width={260} aria-label="Customer" addNew={false} />
            </div>
          )}
          <Radio name="cs-who" checked={who === 'type'} onChange={() => (setWho('type'), changed())} label="Customers of type" />
          {who === 'type' && (
            <div className="sx-cust-cs-indent">
              <ListPicker list="customer_type" value={typeId} onChange={(id) => (setTypeId(id), changed())} width={220} aria-label="Customer type" />
            </div>
          )}
        </section>
        <section>
          <h3>Options</h3>
          <Checkbox checked={noZero} onChange={(v) => (setNoZero(v), changed())} label="Do not create statements with a zero balance" />
        </section>
        <div className="sx-cust-cs-buttons">
          <Button icon={Eye} label="Pre&view" onClick={() => void doPreview()} busy={busy === 'preview'} />
          <Button variant="primary" icon={Printer} label="&Print" onClick={() => void doPrint()} busy={busy === 'print'} />
          <Button variant="ghost" label="Close" onClick={() => void win.close()} />
        </div>
      </div>
      <div className="sx-cust-cs-right">
        {busy === 'preview' ? (
          <Spinner center label="Preparing statements..." />
        ) : preview ? (
          preview.length ? (
            <>
              <div className="sx-cust-cs-summary">
                <b>
                  {preview.length} {preview.length === 1 ? 'statement' : 'statements'}
                </b>{' '}
                · Total amount due {money$(totalDue)}
              </div>
              <iframe ref={frameRef} className="sx-cust-cs-frame" title="Statement preview" />
            </>
          ) : (
            <EmptyState title="No statements" message="None of the chosen customers has activity or a balance for these choices. Clear “Do not create statements with a zero balance” to see them anyway." />
          )
        ) : (
          <EmptyState icon={Eye} title="Preview your statements" message="Choose the statement date, period and customers on the left, then click Preview to see the statements before printing them." />
        )}
      </div>
    </div>
  );
}

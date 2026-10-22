// "No Company Open" start screen (not an MDI window: App shows it on the empty work area), in the
// look of the SerieX Books welcome page: the SerieX Books companies with their payroll status,
// "Open" for a company with payroll, "Set Up Payroll" for one without, and a banner with the
// SerieX Books address and Retry when SerieX Books cannot be reached.
import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, BookOpen, Building2, CircleHelp, RefreshCw, WandSparkles } from 'lucide-react';
import { api, ApiError } from '@/api/client';
import type { AppInfo, PayrollCompanyFile } from '@/api/types';
import { Badge, Button, EmptyState, SearchBox, Spinner, toast } from '@/components';
import { openWindow } from '@/windows/windowStore';
import { getLastCompanyId, getRecentCompanies, setUpPayroll } from '@/state/session';
import { openSerieXBooks } from '@/shell/booksLink';
import { AppIcon } from '@/shell/glyphs';
import { fmtDateTime, timeAgo } from './shared';
import './company.css';

export interface NoCompanyOpenProps {
  /** Open this company (the shell handles login and closing the current one). */
  onOpened(companyId: string): void;
}

function statusOf(c: PayrollCompanyFile): { label: string; tone: 'success' | 'warning' | 'neutral'; action: string } {
  if (!c.payrollSetUp) return { label: 'No payroll yet', tone: 'neutral', action: 'Set Up Payroll' };
  if (!c.setupDone) return { label: 'Setup not finished', tone: 'warning', action: 'Open' };
  return { label: 'Payroll set up', tone: 'success', action: 'Open' };
}

export default function NoCompanyOpen({ onOpened }: NoCompanyOpenProps) {
  const [list, setList] = useState<PayrollCompanyFile[] | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [ver, setVer] = useState(0);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const last = getLastCompanyId();

  useEffect(() => {
    let alive = true;
    setLoading(true);
    Promise.allSettled([api.global.get<AppInfo>('/info', { noPrompt: true }), api.global.get<PayrollCompanyFile[]>('/companies', { noPrompt: true })]).then(([i, c]) => {
      if (!alive) return;
      setInfo(i.status === 'fulfilled' ? i.value : null);
      if (c.status === 'fulfilled') {
        setList(c.value ?? []);
        setError(null);
      } else {
        setList(null);
        setError(c.reason instanceof Error ? c.reason : new Error(String(c.reason)));
      }
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [ver]);

  const recentOrder = useMemo(() => getRecentCompanies().map((r) => r.id), [list]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (list ?? [])
      .filter((c) => !term || c.name.toLowerCase().includes(term) || c.id.toLowerCase().includes(term))
      .sort((a, b) => {
        const ra = recentOrder.indexOf(a.id);
        const rb = recentOrder.indexOf(b.id);
        if (ra !== rb) return (ra < 0 ? 999 : ra) - (rb < 0 ? 999 : rb);
        if (a.payrollSetUp !== b.payrollSetUp) return a.payrollSetUp ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  }, [list, q, recentOrder]);

  useEffect(() => {
    if (!rows.length) setSel(null);
    else if (!sel || !rows.some((r) => r.id === sel)) setSel(rows[0].id);
  }, [rows, sel]);

  // The payroll server itself cannot be reached: the request failed without an answer, or a proxy
  // answered for it (an error without the server's JSON error body).
  const serverDown =
    !info && !!error && (!(error instanceof ApiError) || error.status === 0 || (error.code === `http_${error.status}` && error.status >= 500));
  const booksDown = !serverDown && ((info && !info.booksReachable) || (error instanceof ApiError && (error.code === 'books_unavailable' || error.status === 503)));
  const booksUrl = info?.booksUrl ?? '';

  const act = async (c: PayrollCompanyFile) => {
    if (busy) return;
    if (c.payrollSetUp) {
      onOpened(c.id);
      return;
    }
    setBusy(c.id);
    try {
      await setUpPayroll(c.id, c.name);
    } finally {
      setBusy(null);
      setVer((v) => v + 1);
    }
  };

  const setUpFirst = () => {
    const cur = rows.find((r) => r.id === sel);
    const target = cur && !cur.payrollSetUp ? cur : rows.find((r) => !r.payrollSetUp);
    if (target) void act(target);
    else if (rows.length) toast('Every SerieX Books company already has payroll. Create a new company in SerieX Books first.', { kind: 'info' });
    else toast('There is no SerieX Books company yet. Create one in SerieX Books first.', { kind: 'info' });
  };

  const onListKey = (e: React.KeyboardEvent) => {
    if (!rows.length) return;
    const i = Math.max(
      0,
      rows.findIndex((r) => r.id === sel),
    );
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      setSel(n.id);
      listRef.current?.querySelector(`[data-id="${CSS.escape(n.id)}"]`)?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && sel) {
      e.preventDefault();
      const c = rows.find((r) => r.id === sel);
      if (c) void act(c);
    }
  };

  return (
    <div className="cx-welcome pc-welcome">
      <div className="cx-welcome-head">
        <AppIcon size={44} />
        <div>
          <h1 className="cx-welcome-title">Welcome to SerieX Payroll</h1>
          <div className="cx-muted">Run payroll for a SerieX Books company. Open a company that has payroll, or set up payroll for one that does not.</div>
        </div>
      </div>

      {booksDown && (
        <div className="cx-note cx-warn pc-banner" role="alert">
          <AlertTriangle size={16} />
          <div className="cx-grow">
            <b>SerieX Books is not running or cannot be reached{booksUrl ? ` at ${booksUrl}` : ''}.</b>
            <div>Payroll reads its companies, accounts and users from SerieX Books. Start SerieX Books, then click Retry.</div>
          </div>
          <Button size="sm" icon={RefreshCw} label="Retry" onClick={() => setVer((v) => v + 1)} busy={loading} />
        </div>
      )}
      {serverDown && !booksDown && (
        <div className="cx-note cx-bad pc-banner" role="alert">
          <AlertTriangle size={16} />
          <div className="cx-grow">
            <b>SerieX Payroll is not running or cannot be reached.</b>
            <div>Start the SerieX Payroll server (or check the network connection), then click Retry.</div>
          </div>
          <Button size="sm" icon={RefreshCw} label="Retry" onClick={() => setVer((v) => v + 1)} busy={loading} />
        </div>
      )}

      <div className="cx-welcome-actions">
        <button type="button" className="cx-action-card" onClick={setUpFirst} disabled={!!busy || !list}>
          <span className="cx-action-icon" style={{ background: '#e0ecff', color: '#1d4ed8' }}>
            {busy ? <Spinner size={18} /> : <WandSparkles size={20} />}
          </span>
          <span className="cx-action-text">
            <b>Set up payroll</b>
            <span>For a SerieX Books company that has no payroll yet. A short interview creates the payroll file.</span>
          </span>
        </button>
        <button type="button" className="cx-action-card" onClick={openSerieXBooks}>
          <span className="cx-action-icon" style={{ background: '#e7f6ee', color: '#15803d' }}>
            <BookOpen size={20} />
          </span>
          <span className="cx-action-text">
            <b>Open SerieX Books</b>
            <span>Create a company file, add bank accounts or users. Payroll posts its checks there.</span>
          </span>
        </button>
        <button type="button" className="cx-action-card" onClick={() => openWindow('about', { help: true })}>
          <span className="cx-action-icon" style={{ background: '#fdf0e1', color: '#c2410c' }}>
            <CircleHelp size={20} />
          </span>
          <span className="cx-action-text">
            <b>How payroll works</b>
            <span>Set up, pay employees, pay payroll taxes and file the tax forms, step by step.</span>
          </span>
        </button>
      </div>

      <div className="cx-welcome-listhead">
        <span className="cx-section-title" style={{ margin: 0 }}>
          SerieX Books companies
        </span>
        <span className="cx-spacer" />
        <SearchBox value={q} onChange={setQ} placeholder="Find a company" width={200} aria-label="Find a company" />
      </div>
      <div className="cx-filelist" ref={listRef} tabIndex={0} role="listbox" aria-label="SerieX Books companies" onKeyDown={onListKey}>
        {loading && !list ? (
          <div style={{ padding: 30, display: 'grid', placeItems: 'center' }}>
            <Spinner label="Loading the SerieX Books companies..." />
          </div>
        ) : !list ? (
          <EmptyState
            compact
            icon={AlertTriangle}
            title={serverDown ? 'SerieX Payroll is not running' : booksDown ? 'SerieX Books is not running' : 'The companies could not be loaded'}
            message={
              serverDown
                ? 'The list of companies comes from the SerieX Payroll server. Start it, then click Retry.'
                : booksDown
                  ? `Start SerieX Books${booksUrl ? ` (${booksUrl})` : ''}, then click Retry.`
                  : (error?.message ?? '')
            }
            action={{ label: 'Retry', onClick: () => setVer((v) => v + 1) }}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            compact
            icon={Building2}
            title={list.length ? 'No company matches' : 'No SerieX Books companies yet'}
            message={list.length ? 'Try another name.' : 'Create your company in SerieX Books first, then come back and set up payroll for it.'}
            action={list.length ? undefined : { label: 'Open SerieX Books', onClick: openSerieXBooks }}
          />
        ) : (
          <table className="cx-filetable pc-cotable">
            <thead>
              <tr>
                <th>Company</th>
                <th>Payroll</th>
                <th>Last changed</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const s = statusOf(c);
                return (
                  <tr
                    key={c.id}
                    data-id={c.id}
                    data-company={c.id}
                    role="option"
                    aria-selected={c.id === sel}
                    className={c.id === sel ? 'cx-sel' : ''}
                    onMouseDown={() => setSel(c.id)}
                    onDoubleClick={() => void act(c)}
                  >
                    <td>
                      <div className="cx-file-name">
                        <Building2 size={15} className="cx-muted" />
                        <span>{c.name}</span>
                        {c.id === last && <Badge tone="accent">Last opened</Badge>}
                      </div>
                      <div className="cx-muted cx-small">{c.id}</div>
                    </td>
                    <td>
                      <Badge tone={s.tone} dot>
                        {s.label}
                      </Badge>
                    </td>
                    <td title={fmtDateTime(c.booksModified)}>{timeAgo(c.booksModified)}</td>
                    <td className="cx-right" style={{ whiteSpace: 'nowrap' }}>
                      <Button
                        size="sm"
                        variant={c.id === sel ? 'primary' : 'secondary'}
                        label={s.action}
                        busy={busy === c.id}
                        disabled={!!busy && busy !== c.id}
                        onClick={() => void act(c)}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <div className="cx-welcome-foot">
        <span className="cx-muted cx-small">
          {booksUrl ? (
            <>
              SerieX Books: {booksUrl}{' '}
              {info && (
                <Badge tone={info.booksReachable ? 'success' : 'danger'} dot>
                  {info.booksReachable ? 'Running' : 'Not reachable'}
                </Badge>
              )}
            </>
          ) : null}
        </span>
        <span className="cx-spacer" />
        <button type="button" className="sx-linkbtn cx-small" onClick={() => setVer((v) => v + 1)} disabled={loading}>
          <RefreshCw size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />
          Refresh the list
        </button>
      </div>
    </div>
  );
}

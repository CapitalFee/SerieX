// Report Center (ported from the SerieX Books Report Center): searchable list of every payroll
// report grouped by category (Payroll and Employees, Tax Forms) with plain-English
// descriptions, favorites (★) and recently run reports. Each report runs with one click.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Clock, FileBarChart, Play, Star } from 'lucide-react';
import type { ReportInfo } from '@/api/types';
import { useReportCatalog } from '@/api/hooks';
import { EmptyState, SearchBox, Spinner, Tabs } from '@/components';
import { STATIC_REPORTS } from '@/state/catalog';
import { openWindow } from '@/windows/windowStore';
import { useWindow } from '@/windows/WindowContext';
import { CATEGORY_HELP, CATEGORY_ORDER, isListedReport } from './reportMeta';
import { clearRecentReports, timeAgo, toggleFavorite, useReportPrefs } from './reportStore';
import './reports.css';

export interface ReportCenterProps {
  /** Category to show first. */
  category?: string;
}

type Tab = 'standard' | 'favorites' | 'recent';
type Info = Pick<ReportInfo, 'key' | 'title' | 'category'> & Partial<ReportInfo>;

const run = (key: string) => openWindow('report', { key });

/** Moves focus between report rows with the arrow keys. */
function onListKey(e: React.KeyboardEvent<HTMLElement>) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const rows = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[data-rc-row]'));
  const i = rows.indexOf(document.activeElement as HTMLElement);
  const n = rows[e.key === 'ArrowDown' ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1)];
  if (n) {
    n.focus();
    n.scrollIntoView({ block: 'nearest' });
    e.preventDefault();
  }
}

function ReportRow({ r, fav, extra }: { r: Info; fav: boolean; extra?: ReactNode }) {
  return (
    <div
      className="rc-row"
      data-rc-row=""
      data-report={r.key}
      tabIndex={0}
      role="button"
      aria-label={`Run ${r.title}`}
      onClick={() => run(r.key)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          run(r.key);
        } else if (e.key === '*') {
          e.preventDefault();
          toggleFavorite(r.key);
        }
      }}
    >
      <button
        type="button"
        tabIndex={-1}
        className={'rc-star' + (fav ? ' rc-on' : '')}
        title={fav ? 'Remove from favorites' : 'Add to favorites'}
        aria-label={fav ? `Remove ${r.title} from favorites` : `Add ${r.title} to favorites`}
        aria-pressed={fav}
        onClick={(e) => {
          e.stopPropagation();
          toggleFavorite(r.key);
        }}
      >
        <Star size={15} fill={fav ? 'currentColor' : 'none'} />
      </button>
      <div className="rc-main">
        <div className="rc-title">{r.title}</div>
        {r.description && <div className="rc-desc">{r.description}</div>}
      </div>
      {extra && <div className="rc-extra">{extra}</div>}
      <span className="rc-run" aria-hidden="true">
        <Play size={12} fill="currentColor" /> Run
      </span>
    </div>
  );
}

export default function ReportCenter(props: ReportCenterProps) {
  const w = useWindow();
  const catalogQ = useReportCatalog();
  const { favorites, recent } = useReportPrefs();
  const [tab, setTab] = useState<Tab>('standard');
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<string | null>(props.category ?? null);
  const listRef = useRef<HTMLDivElement>(null);

  const catalog: Info[] = useMemo(() => (catalogQ.data?.length ? catalogQ.data : STATIC_REPORTS), [catalogQ.data]);
  const listed = useMemo(() => catalog.filter((r) => isListedReport(r)), [catalog]);
  const byKey = useMemo(() => new Map(catalog.map((r) => [r.key, r])), [catalog]);
  const favSet = useMemo(() => new Set(favorites), [favorites]);

  const search = q.trim().toLowerCase();
  const matches = (r: Info) =>
    !search || r.title.toLowerCase().includes(search) || (r.description ?? '').toLowerCase().includes(search) || r.category.toLowerCase().includes(search);

  const groups = useMemo(() => {
    const m = new Map<string, Info[]>();
    for (const r of listed) {
      if (!matches(r)) continue;
      if (!m.has(r.category)) m.set(r.category, []);
      m.get(r.category)!.push(r);
    }
    const rank = (c: string) => (CATEGORY_ORDER.indexOf(c) < 0 ? 99 : CATEGORY_ORDER.indexOf(c));
    return [...m.entries()].sort((a, b) => rank(a[0]) - rank(b[0]));
  }, [listed, search]); // eslint-disable-line react-hooks/exhaustive-deps

  // a category asked for by the caller: scroll to it once the list is shown
  useEffect(() => {
    if (props.category) setCat(props.category);
  }, [props.category]);
  useEffect(() => {
    if (!cat || tab !== 'standard') return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-cat="${CSS.escape(cat)}"]`);
    el?.scrollIntoView({ block: 'start' });
  }, [cat, tab, groups.length]);

  useEffect(() => {
    w.setTitle('Report Center');
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const favReports = favorites.map((k) => byKey.get(k)).filter((r): r is Info => !!r && matches(r));
  const recentReports = recent.filter((x) => byKey.has(x.key) && matches(byKey.get(x.key)!));

  const tabs = [
    { key: 'standard', label: 'Standard' },
    { key: 'favorites', label: `Favorites${favorites.length ? ` (${favorites.length})` : ''}` },
    { key: 'recent', label: 'Recent' },
  ];

  let body: ReactNode;
  if (tab === 'standard') {
    body = (
      <div className="rc-split">
        <nav className="rc-cats" aria-label="Report categories">
          {groups.map(([c, reports]) => (
            <button
              key={c}
              type="button"
              className={'rc-cat' + (cat === c ? ' rc-on' : '')}
              onClick={() => {
                setCat(c);
                listRef.current?.querySelector<HTMLElement>(`[data-cat="${CSS.escape(c)}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
              }}
            >
              {c}
              <span className="rc-cat-n">{reports.length}</span>
            </button>
          ))}
        </nav>
        <div className="rc-list" ref={listRef} onKeyDown={onListKey}>
          {catalogQ.isLoading && <Spinner label="Loading reports…" />}
          {groups.map(([c, reports]) => (
            <section key={c} className="rc-group" data-cat={c} aria-label={c}>
              <header className="rc-group-head">
                <h3>{c}</h3>
                {CATEGORY_HELP[c] && <p>{CATEGORY_HELP[c]}</p>}
              </header>
              {reports.map((r) => (
                <ReportRow key={r.key} r={r} fav={favSet.has(r.key)} />
              ))}
            </section>
          ))}
          {!catalogQ.isLoading && groups.length === 0 && (
            <EmptyState
              icon={FileBarChart}
              title="No reports match your search"
              message={`Nothing is called or described as "${q}". Try another word, such as "summary", "liability" or "941".`}
            />
          )}
        </div>
      </div>
    );
  } else if (tab === 'favorites') {
    body = (
      <div className="rc-list rc-list-full" onKeyDown={onListKey}>
        {favReports.length ? (
          favReports.map((r) => <ReportRow key={r.key} r={r} fav />)
        ) : (
          <EmptyState
            icon={Star}
            title={favorites.length ? 'No favorites match your search' : 'No favorite reports yet'}
            message="Click the star next to a report to keep it here, so the reports you use most are one click away."
            action={favorites.length ? undefined : { label: 'Browse reports', onClick: () => setTab('standard') }}
          />
        )}
      </div>
    );
  } else {
    body = (
      <div className="rc-list rc-list-full" onKeyDown={onListKey}>
        {recentReports.length ? (
          <>
            {recentReports.map((x) => (
              <ReportRow key={x.key} r={byKey.get(x.key)!} fav={favSet.has(x.key)} extra={<span className="rc-when">{timeAgo(x.at)}</span>} />
            ))}
            <div className="rc-foot">
              <button type="button" className="sx-linkbtn" onClick={clearRecentReports}>
                Clear this list
              </button>
            </div>
          </>
        ) : (
          <EmptyState
            icon={Clock}
            title="No reports run yet"
            message="Reports you run show up here, so you can run them again quickly."
            action={{ label: 'Browse reports', onClick: () => setTab('standard') }}
          />
        )}
      </div>
    );
  }

  return (
    <div className="rc-win">
      <div className="rc-head">
        <h2 className="rc-h">Reports</h2>
        <SearchBox
          value={q}
          onChange={setQ}
          placeholder="Find a report by name or what it shows"
          width={360}
          autoFocus
          aria-label="Find a report"
          onKeyDown={(e) => {
            // Down arrow / Enter: go to the first report shown
            if (e.key !== 'ArrowDown' && !(e.key === 'Enter' && q.trim())) return;
            const first = (e.currentTarget.closest('.rc-win') as HTMLElement | null)?.querySelector<HTMLElement>('[data-rc-row]');
            if (!first) return;
            e.preventDefault();
            if (e.key === 'Enter') first.click();
            else first.focus();
          }}
        />
        <span className="rc-spacer" />
      </div>
      <Tabs variant="strip" tabs={tabs} active={tab} onChange={(k) => setTab(k as Tab)} fill aria-label="Report lists">
        {body}
      </Tabs>
    </div>
  );
}

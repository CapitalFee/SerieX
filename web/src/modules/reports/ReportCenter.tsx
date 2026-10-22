// Report Center: searchable list of every report grouped by
// category with plain-English descriptions, favorites (★), recently run reports and the
// memorized reports. Each report runs with one click.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BookmarkCheck, Clock, FileBarChart, Pencil, Play, Star, Trash2 } from 'lucide-react';
import type { MemorizedReport, ReportInfo } from '@/api/types';
import { usePrefValues, useReportsCatalog } from '@/api/hooks';
import { Button, EmptyState, SearchBox, Spinner, Tabs } from '@/components';
import { STATIC_REPORTS } from '@/state/catalog';
import { openWindow } from '@/windows/windowStore';
import { useWindow } from '@/windows/WindowContext';
import { presetLabel } from '@/util/dates';
import { deleteMemorizedReport, editMemorizedReport, runMemorizedReport, useMemorizedReports } from './memorized';
import { CATEGORY_HELP, CATEGORY_ORDER, isListedReport, reportEnabled } from './reportMeta';
import { clearRecentReports, timeAgo, toggleFavorite, useReportPrefs } from './reportStore';
import './reports.css';

export interface ReportCenterProps {
  category?: string;
}

type Tab = 'standard' | 'favorites' | 'recent' | 'memorized';
type Info = Pick<ReportInfo, 'key' | 'title' | 'category'> & Partial<ReportInfo>;

const run = (key: string) => openWindow('report', { key });

/** Other words people use for a report (abbreviations, accountant terms, plain phrases). */
const PL = 'p&l pl p & l p and l profit and loss income statement net income earnings';
const BS = 'bs balance sheet statement of financial position net worth assets liabilities equity';
const AR = 'ar a/r accounts receivable receivables who owes me owed to me unpaid invoices overdue late customers';
const AP = 'ap a/p accounts payable payables bills to pay what i owe unpaid bills overdue vendors';
const KEYWORDS: Record<string, string> = {
  profit_loss: PL,
  profit_loss_detail: PL,
  profit_loss_ytd: PL + ' year to date ytd',
  profit_loss_prev_year: PL + ' last year compare comparison',
  profit_loss_prev_period: PL + ' last month previous period compare comparison',
  profit_loss_by_job: PL + ' job customer',
  profit_loss_by_class: PL + ' class department location',
  profit_loss_unclassified: PL + ' class',
  balance_sheet: BS,
  balance_sheet_detail: BS,
  balance_sheet_summary: BS,
  balance_sheet_prev_year: BS + ' last year compare comparison',
  balance_sheet_prev_period: BS + ' previous period compare comparison',
  cash_flows: 'cash flow scf statement of cash flows cash in cash out',
  trial_balance: 'tb debits credits',
  general_ledger: 'gl ledger',
  journal: 'je journal entries debits credits',
  transaction_detail_by_account: 'gl ledger transactions',
  transaction_list_by_date: 'transactions list',
  audit_trail: 'history changes who changed edited deleted log',
  ar_aging_summary: AR + ' aging',
  ar_aging_detail: AR + ' aging',
  open_invoices: AR,
  collections: AR + ' collect phone',
  customer_balance_summary: AR,
  customer_balance_detail: AR,
  ap_aging_summary: AP + ' aging',
  ap_aging_detail: AP + ' aging',
  unpaid_bills_detail: AP,
  vendor_balance_summary: AP,
  vendor_balance_detail: AP,
  sales_tax_liability: 'sales tax owed tax due tax payable',
  sales_tax_revenue_summary: 'sales tax taxable revenue',
  inventory_valuation_summary: 'stock value inventory worth',
  inventory_valuation_detail: 'stock value inventory worth',
  inventory_stock_status_by_item: 'stock reorder on hand',
  inventory_stock_status_by_vendor: 'stock reorder on hand',
  open_purchase_orders: 'po pos purchase orders',
  open_purchase_orders_detail: 'po pos purchase orders',
  budget_overview: 'forecast',
  budget_vs_actual: 'bva forecast compare',
  profit_loss_budget_performance: 'forecast',
  missing_checks: 'check numbers gaps',
};

/** The words of a text, lower case ("A/R" stays one word, punctuation splits the rest). */
const wordsOf = (s: string) => s.toLowerCase().split(/[^a-z0-9&/]+/).filter(Boolean);

/** A searchable text and its words. */
interface Field {
  text: string;
  words: string[];
}
const field = (s: string): Field => {
  const text = s.toLowerCase();
  return { text, words: wordsOf(text) };
};

/** What a report is found by: its title, its keywords, its description and category, all of them together, and the category help. */
interface Haystack {
  title: Field;
  keys: Field;
  desc: Field;
  all: Field;
  help: string;
}
const hayCache = new WeakMap<Info, Haystack>();
function haystack(r: Info): Haystack {
  let h = hayCache.get(r);
  if (!h) {
    const keys = KEYWORDS[r.key] ?? '';
    h = {
      title: field(r.title),
      keys: field(keys),
      desc: field([r.description ?? '', r.category].join(' | ')),
      all: field([r.title, r.description ?? '', r.category, keys].join(' | ')),
      help: (CATEGORY_HELP[r.category] ?? '').toLowerCase(),
    };
    hayCache.set(r, h);
  }
  return h;
}

/**
 * True when every word of the search is found in the text. Short words must start a word, so "gl"
 * or "ar" do not match the middle of "single" or "year"; a two-letter word that is a known
 * abbreviation (in `exact`) must match a whole word, so "ar" finds the A/R reports, not "are".
 */
function fieldMatches(f: Field, search: string, terms: string[], exact: Set<string>): boolean {
  if (!terms.length) return f.text.includes(search);
  if (search.length > 3 && f.text.includes(search)) return true;
  return terms.every((t) => (exact.has(t) ? f.words.includes(t) : t.length <= 3 ? f.words.some((w) => w.startsWith(t)) : f.text.includes(t)));
}

/** Rank of a report found only through its category's help text: listed after every other match. */
const HELP_RANK = 4;

/**
 * How well a report matches a search, best first: 0 its title starts with the search, 1 its title
 * has it, 2 its keywords have it ("p&l", "who owes"), 3 its description or category has it (or the
 * words are spread over all of these), 4 only its category's help says the phrase ("how your
 * business is doing"; used only for categories where no report matched otherwise); -1 when it
 * does not match.
 */
function matchRank(r: Info, search: string, exact: Set<string>): number {
  if (!search) return 0;
  const h = haystack(r);
  const terms = wordsOf(search);
  if (h.title.text.startsWith(search)) return 0;
  if (fieldMatches(h.title, search, terms, exact)) return 1;
  if (fieldMatches(h.keys, search, terms, exact)) return 2;
  if (fieldMatches(h.desc, search, terms, exact) || fieldMatches(h.all, search, terms, exact)) return 3;
  if (/\s/.test(search) && h.help.includes(search)) return HELP_RANK;
  return -1;
}

/** Two-letter search words that some report has as a whole word (abbreviations such as "gl", "ar", "tb"). */
function exactTerms(reports: Info[], search: string): Set<string> {
  const short = wordsOf(search).filter((t) => t.length <= 2);
  const out = new Set<string>();
  if (!short.length) return out;
  for (const r of reports) {
    const { words } = haystack(r).all;
    for (const t of short) if (words.includes(t)) out.add(t);
  }
  return out;
}

const categoryRank = (c: string) => (CATEGORY_ORDER.indexOf(c) < 0 ? 99 : CATEGORY_ORDER.indexOf(c));

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

function ReportRow({ r, fav, extra, showCategory }: { r: Info; fav: boolean; extra?: ReactNode; showCategory?: boolean }) {
  return (
    <div
      className="rc-row"
      data-rc-row=""
      data-cat={showCategory ? r.category : undefined}
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
        <div className="rc-title">
          {r.title}
          {showCategory && <span className="rc-incat">{r.category}</span>}
        </div>
        {r.description && <div className="rc-desc">{r.description}</div>}
      </div>
      {extra && <div className="rc-extra">{extra}</div>}
      <span className="rc-run" aria-hidden="true">
        <Play size={12} fill="currentColor" /> Run
      </span>
    </div>
  );
}

/** Short description of a memorized report's dates. */
function memDates(m: MemorizedReport): string {
  const p = m.params ?? {};
  if (p.dates && p.dates !== 'custom') return presetLabel(p.dates);
  if (p.from || p.to) return [p.from, p.to].filter(Boolean).join(' – ');
  if (p.asOf) return `As of ${p.asOf}`;
  return 'Standard dates';
}

export default function ReportCenter(props: ReportCenterProps) {
  const w = useWindow();
  const prefs = usePrefValues();
  const catalogQ = useReportsCatalog();
  const memQ = useMemorizedReports();
  const { favorites, recent } = useReportPrefs();
  const [tab, setTab] = useState<Tab>('standard');
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<string | null>(props.category ?? null);
  const listRef = useRef<HTMLDivElement>(null);

  const catalog: Info[] = useMemo(() => (catalogQ.data?.length ? catalogQ.data : STATIC_REPORTS), [catalogQ.data]);
  const listed = useMemo(() => catalog.filter((r) => isListedReport(r) && reportEnabled(r, prefs)), [catalog, prefs]);
  const byKey = useMemo(() => new Map(catalog.map((r) => [r.key, r])), [catalog]);
  const favSet = useMemo(() => new Set(favorites), [favorites]);

  const search = q.trim().toLowerCase();
  const exact = useMemo(() => exactTerms(catalog, search), [catalog, search]);

  // no search: every report by category
  const groups = useMemo(() => {
    const m = new Map<string, Info[]>();
    for (const r of listed) {
      if (!m.has(r.category)) m.set(r.category, []);
      m.get(r.category)!.push(r);
    }
    return [...m.entries()].sort((a, b) => categoryRank(a[0]) - categoryRank(b[0]));
  }, [listed]);

  // a search: the matching reports best first (title, then keywords, then description); after them,
  // the reports of a category whose help text says the phrase ("how your business is doing") when
  // none of that category's reports matched by itself
  const found = useMemo(() => {
    if (!search) return null;
    let hits: { r: Info; rank: number; i: number }[] = [];
    listed.forEach((r, i) => {
      const rank = matchRank(r, search, exact);
      if (rank >= 0) hits.push({ r, rank, i });
    });
    const direct = new Set(hits.filter((h) => h.rank < HELP_RANK).map((h) => h.r.category));
    hits = hits.filter((h) => h.rank < HELP_RANK || !direct.has(h.r.category));
    hits.sort((a, b) => a.rank - b.rank || categoryRank(a.r.category) - categoryRank(b.r.category) || a.i - b.i);
    const best = hits.filter((h) => h.rank < HELP_RANK).map((h) => h.r);
    const m = new Map<string, Info[]>();
    for (const h of hits) {
      if (h.rank < HELP_RANK) continue;
      if (!m.has(h.r.category)) m.set(h.r.category, []);
      m.get(h.r.category)!.push(h.r);
    }
    const related = [...m.entries()].sort((a, b) => categoryRank(a[0]) - categoryRank(b[0]));
    // categories of the left list: how many reports each one has among the results
    const n = new Map<string, number>();
    for (const h of hits) n.set(h.r.category, (n.get(h.r.category) ?? 0) + 1);
    const cats = [...n.entries()].sort((a, b) => categoryRank(a[0]) - categoryRank(b[0]));
    return { best, related, cats, total: hits.length, direct };
  }, [listed, search, exact]);
  /** True when a report is found by the search (the same rule as the Standard list). */
  const matches = (r: Info) => {
    if (!found) return true;
    const rank = matchRank(r, search, exact);
    return rank >= 0 && (rank < HELP_RANK || !found.direct.has(r.category));
  };
  const navCats: [string, number][] = found ? found.cats : groups.map(([c, rs]) => [c, rs.length]);

  const memorized = useMemo(() => {
    const list = (memQ.data ?? []).filter((m) => !search || m.name.toLowerCase().includes(search) || (byKey.get(m.reportKey)?.title ?? '').toLowerCase().includes(search));
    const g = new Map<string, MemorizedReport[]>();
    for (const m of list) {
      const k = m.groupName || '';
      if (!g.has(k)) g.set(k, []);
      g.get(k)!.push(m);
    }
    return [...g.entries()].sort((a, b) => (a[0] === '' ? 1 : b[0] === '' ? -1 : a[0].localeCompare(b[0])));
  }, [memQ.data, search, byKey]);

  // a category asked for by the caller: scroll to it once the list is shown
  useEffect(() => {
    if (!cat || tab !== 'standard' || search) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-cat="${CSS.escape(cat)}"]`);
    el?.scrollIntoView({ block: 'start' });
  }, [cat, tab, groups.length, !!search]); // eslint-disable-line react-hooks/exhaustive-deps

  // a new search shows its best matches from the top
  useEffect(() => {
    if (search && listRef.current) listRef.current.scrollTop = 0;
  }, [search]);

  useEffect(() => {
    w.setTitle('All Reports');
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const favReports = favorites.map((k) => byKey.get(k)).filter((r): r is Info => !!r && matches(r));
  const recentReports = recent.filter((x) => byKey.has(x.key) && matches(byKey.get(x.key)!));
  const memCount = memQ.data?.length ?? 0;

  const tabs = [
    { key: 'standard', label: 'Standard' },
    { key: 'favorites', label: `Favorites${favorites.length ? ` (${favorites.length})` : ''}` },
    { key: 'recent', label: 'Recent' },
    { key: 'memorized', label: `Memorized${memCount ? ` (${memCount})` : ''}` },
  ];

  let body: ReactNode;
  if (tab === 'standard') {
    body = (
      <div className="rc-split">
        <nav className="rc-cats" aria-label="Report categories">
          {navCats.map(([c, n]) => (
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
              <span className="rc-cat-n">{n}</span>
            </button>
          ))}
        </nav>
        <div className="rc-list" ref={listRef} onKeyDown={onListKey}>
          {catalogQ.isLoading && <Spinner label="Loading reports…" />}
          {!found &&
            groups.map(([c, reports]) => (
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
          {found && found.best.length > 0 && (
            <section className="rc-group" aria-label="Matching reports">
              <header className="rc-group-head">
                <h3>
                  {found.best.length === 1 ? '1 report matches' : `${found.best.length} reports match`} "{q.trim()}"
                </h3>
              </header>
              {found.best.map((r) => (
                <ReportRow key={r.key} r={r} fav={favSet.has(r.key)} showCategory />
              ))}
            </section>
          )}
          {found?.related.map(([c, reports]) => (
            <section key={c} className="rc-group" data-cat={c} aria-label={found.best.length ? `Also in ${c}` : c}>
              <header className="rc-group-head">
                <h3>{found.best.length ? `Also in ${c}` : c}</h3>
                {CATEGORY_HELP[c] && <p>{CATEGORY_HELP[c]}</p>}
              </header>
              {reports.map((r) => (
                <ReportRow key={r.key} r={r} fav={favSet.has(r.key)} />
              ))}
            </section>
          ))}
          {!catalogQ.isLoading && (found ? found.total === 0 : groups.length === 0) && (
            <EmptyState
              icon={FileBarChart}
              title="No reports match your search"
              message={`Nothing is called or described as "${q}". Try another word, such as "sales", "aging" or "balance".`}
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
  } else if (tab === 'recent') {
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
  } else {
    body = (
      <div className="rc-list rc-list-full">
        {memQ.isLoading && <Spinner label="Loading memorized reports…" />}
        {memorized.map(([g, list]) => (
          <section key={g || '(none)'} className="rc-group" aria-label={g || 'Not in a group'}>
            <header className="rc-group-head">
              <h3>{g || 'Not in a group'}</h3>
            </header>
            {list.map((m) => (
              <div
                key={m.id}
                className="rc-row"
                data-rc-row=""
                tabIndex={0}
                role="button"
                aria-label={`Run ${m.name}`}
                onClick={() => runMemorizedReport(m)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    runMemorizedReport(m);
                  } else if (e.key === 'Delete') {
                    e.preventDefault();
                    void deleteMemorizedReport(m);
                  }
                }}
              >
                <span className="rc-star rc-memic" aria-hidden="true">
                  <BookmarkCheck size={15} />
                </span>
                <div className="rc-main">
                  <div className="rc-title">{m.name}</div>
                  <div className="rc-desc">
                    {byKey.get(m.reportKey)?.title ?? m.reportKey} · {memDates(m)}
                  </div>
                </div>
                <div className="rc-extra rc-actions">
                  <button
                    type="button"
                    className="sx-iconbtn"
                    title="Rename or change group"
                    aria-label={`Edit ${m.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      void editMemorizedReport(m, memQ.data);
                    }}
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    type="button"
                    className="sx-iconbtn"
                    title="Delete this memorized report"
                    aria-label={`Delete ${m.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      void deleteMemorizedReport(m);
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                <span className="rc-run" aria-hidden="true">
                  <Play size={12} fill="currentColor" /> Run
                </span>
              </div>
            ))}
          </section>
        ))}
        {!memQ.isLoading && memorized.length === 0 && (
          <EmptyState
            icon={BookmarkCheck}
            title={memCount ? 'No memorized reports match your search' : 'No memorized reports yet'}
            message="Open a report, set its dates, filters and columns the way you like, then click Memorize. It is saved here for next time."
            action={memCount ? undefined : { label: 'Browse reports', onClick: () => setTab('standard') }}
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
        <Button label="Memorized Report List" icon={BookmarkCheck} onClick={() => openWindow('memorizedReports')} />
      </div>
      <Tabs variant="strip" tabs={tabs} active={tab} onChange={(k) => setTab(k as Tab)} fill aria-label="Report lists">
        {body}
      </Tabs>
    </div>
  );
}

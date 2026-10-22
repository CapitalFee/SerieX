// Global search box in the top bar. Ctrl+K or "/" focuses it.
// While typing, a grouped drop-down shows customers / vendors / other names,
// transactions (by number, amount, name, memo), products & services, accounts,
// actions and reports. Arrow keys + Enter pick a result; Enter with no choice
// opens the first one; "See all results" opens the Search window.
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Search,
  X,
  User,
  Truck,
  UserRound,
  FileText,
  Package,
  ListTree,
  ChartColumn,
  Clock,
  ArrowRight,
  CornerDownLeft,
  type LucideIcon,
} from 'lucide-react';
import { api, qs } from '@/api/client';
import { queryClient } from '@/api/hooks';
import { BALANCE_SHEET_TYPES, type Account, type Item, type Name, type TxnListResult, type TxnSummary, type Prefs } from '@/api/types';
import { useSession } from '@/state/session';
import { reportCatalog, HIDDEN_REPORT_CATEGORIES } from '@/state/catalog';
import { getActiveWindow, openWindow, openTxn } from '@/windows/windowStore';
import { getRecentTxns } from '@/util/recent';
import { buildActions } from './navItems';
import { shellDate, shellMoney } from './format';
import { recentLabel } from './NewMenu';

/** Apple keyboards show the Command key for the search shortcut. */
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);

type GroupId = 'recent' | 'suggested' | 'names' | 'txns' | 'items' | 'accounts' | 'actions' | 'reports';

const GROUP_TITLES: Record<GroupId, string> = {
  recent: 'Recent transactions',
  suggested: 'Quick actions',
  names: 'Customers & vendors',
  txns: 'Transactions',
  items: 'Products & services',
  accounts: 'Accounts',
  actions: 'Actions',
  reports: 'Reports',
};
/** Tie-break order of the groups (best score first, then this order). */
const GROUP_ORDER: GroupId[] = ['recent', 'suggested', 'names', 'txns', 'actions', 'reports', 'items', 'accounts'];

interface Hit {
  key: string;
  group: GroupId;
  icon: LucideIcon;
  label: string;
  sub?: string;
  right?: ReactNode;
  score: number;
  run(): void;
}

interface Group {
  id: GroupId;
  hits: Hit[];
}

let inputEl: HTMLInputElement | null = null;

/** Put the keyboard focus in the global search box (Ctrl+K, "/"). */
export function focusGlobalSearch(): void {
  if (!inputEl || inputEl.disabled) return;
  inputEl.focus();
  inputEl.select();
}

// ------------------------------------------------------------------ scoring

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** How well `text` matches `term` (0 = no match). */
export function matchScore(text: string | null | undefined, term: string): number {
  if (!text) return 0;
  const t = norm(text);
  const q = norm(term);
  if (!q) return 0;
  if (t === q) return 100;
  if (t.startsWith(q)) return 90;
  const i = t.indexOf(q);
  if (i > 0) return /[\s:/(&.,-]/.test(t[i - 1]) ? 75 : 50;
  const words = q.split(' ');
  if (words.length > 1 && words.every((w) => t.includes(w))) return 40;
  return 0;
}

/** Amount typed in the box ("1,250.00", "$557") or null. */
function parseAmount(term: string): number | null {
  const s = term.replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const KIND_LABEL: Record<string, string> = { customer: 'Customer', vendor: 'Vendor', other: 'Other name' };

function fetchCached<T>(key: string, path: string): Promise<T> {
  return queryClient.fetchQuery({ queryKey: ['shell', 'search', key], queryFn: () => api.get<T>(path, { noPrompt: true }), staleTime: 60_000 });
}

function txnHit(t: TxnSummary, score: number): Hit {
  const label = `${t.typeLabel || t.type}${t.refNumber ? ' #' + t.refNumber : ''}`;
  return {
    key: `t${t.id}`,
    group: 'txns',
    icon: FileText,
    label: t.voided ? `${label} (void)` : label,
    sub: [t.nameFull, shellDate(t.date), t.memo].filter(Boolean).join(' · '),
    right: <b>{shellMoney(t.amount)}</b>,
    score,
    run: () => openTxn(t.type, t.id),
  };
}

/** Run every search for a term; each source fails on its own without hiding the others. */
async function runSearch(term: string, prefs: Prefs | null): Promise<Group[]> {
  const amount = parseAmount(term);
  const [names, txns, txnsByAmount, items, accounts] = await Promise.allSettled([
    api.get<Name[]>('/names' + qs({ q: term }), { noPrompt: true }),
    api.get<TxnListResult>('/txns' + qs({ q: term, limit: 8, sort: '-date' }), { noPrompt: true }),
    amount !== null
      ? api.get<TxnListResult>('/txns' + qs({ amountMin: amount, amountMax: amount, limit: 8, sort: '-date' }), { noPrompt: true })
      : Promise.resolve(null),
    fetchCached<Item[]>('items', '/items'),
    fetchCached<Account[]>('accounts', '/accounts'),
  ]);
  const groups: Group[] = [];

  // Names (customers, jobs, vendors, other names).
  if (names.status === 'fulfilled' && Array.isArray(names.value)) {
    const hits = names.value
      .map<Hit>((n) => {
        const s = Math.max(matchScore(n.fullName || n.name, term), matchScore(n.name, term) - 5, 30);
        const kind = n.kind === 'customer' && n.parentId ? 'Job' : KIND_LABEL[n.kind] ?? n.kind;
        const extra = n.companyName && n.companyName !== n.name ? n.companyName : n.email || n.phone;
        const center = n.kind === 'customer' ? 'customerCenter' : n.kind === 'vendor' ? 'vendorCenter' : 'otherNames';
        return {
          key: `n${n.id}`,
          group: 'names',
          icon: n.kind === 'customer' ? User : n.kind === 'vendor' ? Truck : UserRound,
          label: n.fullName || n.name,
          sub: [kind, extra].filter(Boolean).join(' · '),
          right: n.kind !== 'other' && n.balance ? <b>{shellMoney(n.balance)}</b> : undefined,
          score: s,
          run: () => openWindow(center, { selectId: n.id }),
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);
    if (hits.length) groups.push({ id: 'names', hits });
  }

  // Transactions (text search + exact amount).
  const seen = new Set<number>();
  const tHits: Hit[] = [];
  if (txnsByAmount.status === 'fulfilled' && txnsByAmount.value) {
    for (const t of txnsByAmount.value.rows ?? []) {
      seen.add(t.id);
      tHits.push(txnHit(t, 85));
    }
  }
  if (txns.status === 'fulfilled' && txns.value) {
    for (const t of txns.value.rows ?? []) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      const ref = norm(t.refNumber || '');
      const q = norm(term);
      const s = ref && ref === q ? 95 : ref && ref.startsWith(q) ? 80 : Math.max(45, matchScore(t.nameFull, term) - 10);
      tHits.push(txnHit(t, s));
    }
  }
  if (tHits.length) groups.push({ id: 'txns', hits: tHits.sort((a, b) => b.score - a.score).slice(0, 8) });

  // Products & services (cached list, filtered here).
  if (items.status === 'fulfilled' && Array.isArray(items.value)) {
    const hits = items.value
      .map<Hit | null>((it) => {
        const s = Math.max(matchScore(it.fullName || it.name, term), matchScore(it.description, term) * 0.6, matchScore(it.mpn, term) * 0.8);
        if (s <= 0) return null;
        const price = it.rateIsPercent ? `${it.salesPrice}%` : it.salesPrice ? shellMoney(it.salesPrice) : '';
        return {
          key: `i${it.id}`,
          group: 'items',
          icon: Package,
          label: it.fullName || it.name,
          sub: [it.type, it.description].filter(Boolean).join(' · '),
          right: (
            <>
              {price && <b>{price}</b>}
              {it.type === 'Inventory Part' && <span>{it.qtyOnHand} on hand</span>}
            </>
          ),
          score: s,
          run: () => openWindow('itemEdit', { id: it.id }),
        };
      })
      .filter((h): h is Hit => !!h)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    if (hits.length) groups.push({ id: 'items', hits });
  }

  // Accounts (cached list): balance sheet accounts open the register, income/expense accounts the Account Activity report.
  if (accounts.status === 'fulfilled' && Array.isArray(accounts.value)) {
    const useNumbers = !!prefs?.useAccountNumbers;
    const hits = accounts.value
      .map<Hit | null>((a) => {
        const s = Math.max(matchScore(a.fullName || a.name, term), matchScore(a.name, term), a.number ? matchScore(a.number, term) : 0);
        if (s <= 0) return null;
        const bs = BALANCE_SHEET_TYPES.includes(a.type);
        const name = a.fullName || a.name;
        return {
          key: `a${a.id}`,
          group: 'accounts',
          icon: ListTree,
          label: useNumbers && a.number ? `${a.number} · ${name}` : name,
          sub: bs ? `${a.type} · open register` : `${a.type} · Account Activity`,
          right: bs ? <b>{shellMoney(a.balance)}</b> : undefined,
          score: s,
          run: () =>
            bs
              ? openWindow('register', { accountId: a.id }, { title: name })
              : openWindow('report', { key: 'account_quickreport', params: { accountId: String(a.id) } }, { title: `Account Activity: ${name}` }),
        };
      })
      .filter((h): h is Hit => !!h)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    if (hits.length) groups.push({ id: 'accounts', hits });
  }

  // Actions and reports.
  const actions = buildActions(prefs);
  const aHits = actions
    .map<Hit | null>((a) => {
      const s = Math.max(matchScore(a.label, term), matchScore(a.keywords, term) * 0.8);
      if (s <= 0) return null;
      return { key: `x${a.id}`, group: 'actions', icon: a.icon, label: a.label, score: s, run: a.run, right: <ArrowRight size={14} /> };
    })
    .filter((h): h is Hit => !!h)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
  if (aHits.length) groups.push({ id: 'actions', hits: aHits });

  const actionReports = new Set(actions.map((a) => a.reportKey).filter(Boolean));
  const rHits = reportCatalog()
    .filter((r) => !HIDDEN_REPORT_CATEGORIES.includes(r.category) && !r.key.endsWith('_quickreport') && !actionReports.has(r.key))
    .map<Hit | null>((r) => {
      const s = Math.max(matchScore(r.title, term), matchScore(r.category, term) * 0.5);
      if (s <= 0) return null;
      return {
        key: `r${r.key}`,
        group: 'reports',
        icon: ChartColumn,
        label: r.title,
        sub: r.category,
        score: s * 0.95,
        run: () => openWindow('report', { key: r.key }),
      };
    })
    .filter((h): h is Hit => !!h)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  if (rHits.length) groups.push({ id: 'reports', hits: rHits });

  const best = (g: Group) => g.hits.reduce((m, h) => Math.max(m, h.score), 0);
  return groups.sort((a, b) => best(b) - best(a) || GROUP_ORDER.indexOf(a.id) - GROUP_ORDER.indexOf(b.id));
}

/** What the drop-down shows before anything is typed: recent transactions and common actions. */
function idleGroups(prefs: Prefs | null): Group[] {
  const groups: Group[] = [];
  const recent = getRecentTxns()
    .slice(0, 5)
    .map<Hit>((r) => ({
      key: `rt${r.id}`,
      group: 'recent',
      icon: Clock,
      label: recentLabel(r),
      sub: [r.nameFull, shellDate(r.date)].filter(Boolean).join(' · '),
      right: <b>{shellMoney(r.amount)}</b>,
      score: 0,
      run: () => openTxn(r.type, r.id),
    }));
  if (recent.length) groups.push({ id: 'recent', hits: recent });
  const wanted = ['invoice', 'receivePayment', 'bill', 'payBills', 'writeCheck', 'pl'];
  const actions = buildActions(prefs).filter((a) => wanted.includes(a.id));
  actions.sort((a, b) => wanted.indexOf(a.id) - wanted.indexOf(b.id));
  groups.push({
    id: 'suggested',
    hits: actions.map((a) => ({ key: `x${a.id}`, group: 'suggested', icon: a.icon, label: a.label, score: 0, run: a.run, right: <ArrowRight size={14} /> })),
  });
  return groups;
}

/** Label with the matched part in bold. */
function Highlight({ text, term }: { text: string; term: string }) {
  const q = term.trim();
  if (!q) return <>{text}</>;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

let searchSeq = 0;

export function GlobalSearch() {
  const companyId = useSession((s) => s.companyId);
  const prefs = useSession((s) => s.prefs);
  const [q, setQ] = useState('');
  const [focused, setFocused] = useState(false);
  const [open, setOpen] = useState(false);
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(false);
  const [hl, setHl] = useState(0);
  const ref = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  const term = q.trim();

  useEffect(() => {
    inputEl = ref.current;
    return () => {
      if (inputEl === ref.current) inputEl = null;
    };
  }, []);

  // Company closed or switched: forget the query.
  useEffect(() => {
    setQ('');
    setOpen(false);
    setGroups([]);
  }, [companyId]);

  useEffect(() => {
    if (!open || !companyId) return;
    if (!term) {
      searchSeq++;
      setLoading(false);
      setGroups(idleGroups(prefs));
      setHl(-1);
      return;
    }
    const seq = ++searchSeq;
    setLoading(true);
    const t = window.setTimeout(() => {
      runSearch(term, prefs)
        .then((g) => {
          if (seq !== searchSeq) return;
          setGroups(g);
          setHl(0);
        })
        .catch(() => {
          if (seq === searchSeq) setGroups([]);
        })
        .finally(() => {
          if (seq === searchSeq) setLoading(false);
        });
    }, 160);
    return () => window.clearTimeout(t);
  }, [term, open, companyId, prefs]);

  const flat = useMemo(() => groups.flatMap((g) => g.hits), [groups]);
  // Index flat.length = the "See all results" row (only with a query).
  const rowCount = flat.length + (term ? 1 : 0);

  useEffect(() => {
    if (hl < 0) return;
    dropRef.current?.querySelector(`[data-row="${hl}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [hl]);

  const close = () => {
    setOpen(false);
  };
  const finish = (fn: () => void) => {
    setOpen(false);
    setQ('');
    ref.current?.blur();
    fn();
  };
  const seeAll = () => finish(() => openWindow('search', { q: term }));
  const choose = (i: number) => {
    if (i >= 0 && i < flat.length) finish(flat[i].run);
    else if (term) seeAll();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (!open) setOpen(true);
        else if (rowCount) setHl((h) => (h + 1 >= rowCount ? 0 : h + 1));
        return;
      case 'ArrowUp':
        e.preventDefault();
        if (rowCount) setHl((h) => (h <= 0 ? rowCount - 1 : h - 1));
        return;
      case 'Enter':
        e.preventDefault();
        if (!open && term) {
          setOpen(true);
          return;
        }
        if (loading && term && hl <= 0) {
          // Results not back yet: wait for them, then open the first one.
          const seq = searchSeq;
          runSearch(term, prefs).then((g) => {
            if (seq !== searchSeq) return;
            const first = g[0]?.hits[0];
            if (first) finish(first.run);
            else seeAll();
          });
          return;
        }
        choose(hl < 0 ? 0 : hl);
        return;
      case 'Escape':
        // Never let Escape reach the window manager (it would close the active window).
        e.preventDefault();
        e.stopPropagation();
        if (open) close();
        else if (q) setQ('');
        else {
          // back to the work area: the active window gets the keyboard again
          const id = getActiveWindow()?.id;
          const win = id ? document.querySelector<HTMLElement>(`[data-window-id="${id}"]`) : null;
          if (win) win.focus({ preventScroll: true });
          else ref.current?.blur();
        }
        return;
      case 'Tab':
        close();
        return;
      default:
    }
  };

  const disabled = !companyId;
  let row = -1;
  return (
    <div className={`sx-gsearch${focused ? ' sx-focused' : ''}`} ref={boxRef}>
      <div className="sx-gsearch-box" onMouseDown={(e) => e.target === e.currentTarget && e.preventDefault()}>
        <Search size={15} strokeWidth={2.2} />
        <input
          ref={ref}
          type="search"
          className="sx-gsearch-input"
          value={q}
          disabled={disabled}
          placeholder={disabled ? 'Open a company to search' : 'Search customers, vendors, transactions, reports...'}
          aria-label="Search"
          aria-expanded={open}
          aria-autocomplete="list"
          autoComplete="off"
          spellCheck={false}
          data-global-search=""
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => {
            setFocused(true);
            setOpen(true);
          }}
          onBlur={(e) => {
            if (boxRef.current?.contains(e.relatedTarget as Node | null)) return;
            setFocused(false);
            setOpen(false);
          }}
          onClick={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        {q ? (
          <button
            type="button"
            className="sx-gsearch-clear"
            title="Clear"
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setQ('');
              ref.current?.focus();
            }}
          >
            <X size={14} />
          </button>
        ) : (
          !disabled && <span className="sx-kbd">{IS_MAC ? '⌘K' : 'Ctrl K'}</span>
        )}
      </div>
      {open && focused && !disabled && (
        <div className="sx-gsearch-drop" ref={dropRef} role="listbox" onMouseDown={(e) => e.preventDefault()}>
          {/* the results scroll; "See all results" stays visible below them */}
          <div className="sx-gsearch-list">
          {groups.map((g) => (
            <div key={g.id} className="sx-gsearch-group">
              <div className="sx-gsearch-title">{GROUP_TITLES[g.id]}</div>
              {g.hits.map((h) => {
                row++;
                const i = row;
                return (
                  <Fragment key={h.key}>
                    <div
                      className={`sx-gsearch-row${i === hl ? ' sx-hl' : ''}`}
                      role="option"
                      aria-selected={i === hl}
                      data-row={i}
                      data-hit={h.key}
                      onMouseMove={() => i !== hl && setHl(i)}
                      onClick={() => choose(i)}
                    >
                      <span className="sx-gsearch-ico">
                        <h.icon size={15} strokeWidth={2} />
                      </span>
                      <span className="sx-gsearch-main">
                        <span className="sx-gsearch-label">
                          <Highlight text={h.label} term={term} />
                        </span>
                        {h.sub && <span className="sx-gsearch-sub">{h.sub}</span>}
                      </span>
                      {h.right && <span className="sx-gsearch-right">{h.right}</span>}
                    </div>
                  </Fragment>
                );
              })}
            </div>
          ))}
          {term && !loading && !flat.length && <div className="sx-gsearch-msg">No quick matches for "{term}".</div>}
          {term && loading && !flat.length && <div className="sx-gsearch-msg">Searching...</div>}
          </div>
          {term && (
            <div
              className={`sx-gsearch-all${hl === flat.length ? ' sx-hl' : ''}`}
              data-row={flat.length}
              onMouseMove={() => hl !== flat.length && setHl(flat.length)}
              onClick={seeAll}
            >
              <Search size={14} />
              <span>See all results for "{term}"</span>
              <CornerDownLeft size={13} />
            </div>
          )}
          {!term && <div className="sx-gsearch-foot">Type a name, number, amount, memo or what you want to do.</div>}
        </div>
      )}
    </div>
  );
}

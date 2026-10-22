// Global search box in the top bar (same design as SerieX Books). Ctrl+K or "/" focuses it.
// While typing, a grouped drop-down shows employees, paychecks (by number, employee, memo),
// tax payments and adjustments (by number, payee, memo), payroll items, actions and reports.
// Arrow keys + Enter pick a result; Enter with no choice opens the first one; "Find paychecks"
// opens Find and Edit Paychecks (window props `q` and `qAt`, so the same text is applied again when
// the window is already open).
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Search, X, User, Banknote, Landmark, SlidersHorizontal, ListChecks, ChartColumn, Clock, ArrowRight, CornerDownLeft, type LucideIcon } from 'lucide-react';
import { api, qs } from '@/api/client';
import { queryClient } from '@/api/hooks';
import { ITEM_TYPE_LABELS, type Employee, type LiabilityAdjustment, type LiabilityPayment, type PaycheckSummary, type PayrollCompany, type PayrollItem } from '@/api/types';
import { useSession } from '@/state/session';
import { reportCatalog, HIDDEN_REPORT_CATEGORIES } from '@/state/catalog';
import { openWindow, openRecord, getActiveWindow } from '@/windows/windowStore';
import { getRecentRecords, recentLabel } from '@/util/recent';
import { buildActions } from './navItems';
import { shellDate, shellMoney } from './format';

type GroupId = 'recent' | 'suggested' | 'employees' | 'paychecks' | 'liabilities' | 'items' | 'actions' | 'reports';

const GROUP_TITLES: Record<GroupId, string> = {
  recent: 'Recent',
  suggested: 'Quick actions',
  employees: 'Employees',
  paychecks: 'Paychecks',
  liabilities: 'Tax payments and adjustments',
  items: 'Payroll items',
  actions: 'Actions',
  reports: 'Reports',
};
/** Tie-break order of the groups (best score first, then this order). */
const GROUP_ORDER: GroupId[] = ['recent', 'suggested', 'employees', 'paychecks', 'liabilities', 'actions', 'reports', 'items'];

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

function fetchCached<T>(key: string, path: string): Promise<T> {
  return queryClient.fetchQuery({ queryKey: ['shell', 'search', key], queryFn: () => api.get<T>(path, { noPrompt: true }), staleTime: 60_000 });
}

function paycheckHit(p: PaycheckSummary, score: number): Hit {
  const num = p.checkNumber ? ` #${p.checkNumber}` : p.toBePrinted ? ' (to print)' : '';
  const label = `${p.kind === 'ytd' ? 'Year-to-Date Entry' : 'Paycheck'}${num}`;
  return {
    key: `p${p.id}`,
    group: 'paychecks',
    icon: Banknote,
    label: p.voided ? `${label} (void)` : label,
    sub: [p.employeeName, shellDate(p.checkDate), p.memo].filter(Boolean).join(' · '),
    right: <b>{shellMoney(p.net)}</b>,
    score,
    run: () => openRecord('paycheck', p.id),
  };
}

/** Score of a check number against the search text (exact 95, starts with 80, else 0). */
function numberScore(num: string | null | undefined, term: string): number {
  const ref = norm(num || '');
  const q = norm(term).replace(/^#/, '');
  if (!ref || !q) return 0;
  return ref === q ? 95 : ref.startsWith(q) ? 80 : 0;
}

function liabilityPaymentHit(p: LiabilityPayment, term: string): Hit | null {
  const prior = p.kind === 'prior';
  const num = prior ? '' : p.checkNumber ? ` #${p.checkNumber}` : p.method === 'e-pay' ? ' (e-pay)' : p.toBePrinted ? ' (to print)' : '';
  const label = (prior ? 'Earlier Tax Payment' : 'Tax Payment') + num;
  const s = Math.max(
    prior ? 0 : numberScore(p.checkNumber, term),
    matchScore(p.agencyName, term) * 0.9,
    matchScore(p.memo, term) * 0.7,
    Math.max(0, ...p.lines.map((l) => matchScore(l.kind === 'item' ? l.itemName : l.accountName, term))) * 0.6,
    matchScore(label, term) * 0.5,
  );
  if (s <= 0) return null;
  return {
    key: `l${p.id}`,
    group: 'liabilities',
    icon: Landmark,
    label: p.voided ? `${label} (void)` : label,
    sub: [p.agencyName, shellDate(p.date), p.memo].filter(Boolean).join(' · '),
    right: <b>{shellMoney(p.amount)}</b>,
    score: s,
    run: () => openRecord('liability_payment', p.id),
  };
}

function adjustmentHit(a: LiabilityAdjustment, term: string): Hit | null {
  const who = a.employeeName || 'Company';
  const items = a.lines.map((l) => l.itemName).filter(Boolean);
  const s = Math.max(
    a.employeeName ? matchScore(a.employeeName, term) * 0.9 : 0,
    matchScore(a.memo, term) * 0.7,
    Math.max(0, ...items.map((n) => matchScore(n, term))) * 0.6,
    matchScore('Tax Balance Adjustment', term) * 0.5,
  );
  if (s <= 0) return null;
  return {
    key: `a${a.id}`,
    group: 'liabilities',
    icon: SlidersHorizontal,
    label: 'Tax Balance Adjustment',
    sub: [who, shellDate(a.date), a.memo || items.slice(0, 2).join(', ')].filter(Boolean).join(' · '),
    right: <b>{shellMoney(a.lines.reduce((t, l) => t + l.amount, 0))}</b>,
    score: s,
    run: () => openRecord('adjustment', a.id),
  };
}

/** Run every search for a term; each source fails on its own without hiding the others. */
async function runSearch(term: string, company: PayrollCompany | null): Promise<Group[]> {
  const [employees, paychecks, items, payments, adjustments] = await Promise.allSettled([
    fetchCached<Employee[]>('employees', '/employees?active=all'),
    api.get<PaycheckSummary[]>('/paychecks' + qs({ q: term, includeVoided: 1 }), { noPrompt: true }),
    fetchCached<PayrollItem[]>('items', '/items?active=all'),
    fetchCached<LiabilityPayment[]>('liability-payments', '/liability-payments'),
    fetchCached<LiabilityAdjustment[]>('liability-adjustments', '/liability-adjustments'),
  ]);
  const groups: Group[] = [];

  if (employees.status === 'fulfilled' && Array.isArray(employees.value)) {
    const hits = employees.value
      .map<Hit | null>((e) => {
        const s = Math.max(matchScore(e.displayName, term), matchScore(`${e.firstName} ${e.lastName}`, term), matchScore(e.employeeNumber, term) * 0.9);
        if (s <= 0) return null;
        return {
          key: `e${e.id}`,
          group: 'employees',
          icon: User,
          label: e.displayName,
          sub: [e.active ? (e.payScheduleName || '') : 'Inactive', e.email || e.phone].filter(Boolean).join(' · '),
          score: s,
          run: () => openWindow('employeeCenter', { tab: 'employees', selectId: e.id }),
        };
      })
      .filter((h): h is Hit => !!h)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);
    if (hits.length) groups.push({ id: 'employees', hits });
  }

  if (paychecks.status === 'fulfilled' && Array.isArray(paychecks.value)) {
    const q = norm(term);
    const hits = paychecks.value
      .map((p) => {
        const ref = norm(p.checkNumber || '');
        const s = ref && ref === q ? 95 : ref && ref.startsWith(q) ? 80 : Math.max(45, matchScore(p.employeeName, term) - 10);
        return paycheckHit(p, s);
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
    if (hits.length) groups.push({ id: 'paychecks', hits });
  }

  const liabHits = [
    ...(payments.status === 'fulfilled' && Array.isArray(payments.value) ? payments.value.map((p) => liabilityPaymentHit(p, term)) : []),
    ...(adjustments.status === 'fulfilled' && Array.isArray(adjustments.value) ? adjustments.value.map((a) => adjustmentHit(a, term)) : []),
  ]
    .filter((h): h is Hit => !!h)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
  if (liabHits.length) groups.push({ id: 'liabilities', hits: liabHits });

  if (items.status === 'fulfilled' && Array.isArray(items.value)) {
    const hits = items.value
      .map<Hit | null>((it) => {
        const s = matchScore(it.name, term);
        if (s <= 0) return null;
        return {
          key: `i${it.id}`,
          group: 'items',
          icon: ListChecks,
          label: it.name,
          sub: [ITEM_TYPE_LABELS[it.type] ?? it.type, it.active ? '' : 'Inactive'].filter(Boolean).join(' · '),
          score: s * 0.95,
          run: () => openWindow('payrollItemEdit', { id: it.id }),
        };
      })
      .filter((h): h is Hit => !!h)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    if (hits.length) groups.push({ id: 'items', hits });
  }

  // Actions and reports.
  const actions = buildActions(company);
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
    .filter((r) => !HIDDEN_REPORT_CATEGORIES.includes(r.category) && !actionReports.has(r.key))
    .map<Hit | null>((r) => {
      const s = Math.max(matchScore(r.title, term), matchScore(r.category, term) * 0.5);
      if (s <= 0) return null;
      return { key: `r${r.key}`, group: 'reports', icon: ChartColumn, label: r.title, sub: r.category, score: s * 0.95, run: () => openWindow('report', { key: r.key }) };
    })
    .filter((h): h is Hit => !!h)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  if (rHits.length) groups.push({ id: 'reports', hits: rHits });

  const best = (g: Group) => g.hits.reduce((m, h) => Math.max(m, h.score), 0);
  return groups.sort((a, b) => best(b) - best(a) || GROUP_ORDER.indexOf(a.id) - GROUP_ORDER.indexOf(b.id));
}

/** What the drop-down shows before anything is typed: recent records and common actions. */
function idleGroups(company: PayrollCompany | null): Group[] {
  const groups: Group[] = [];
  const recent = getRecentRecords()
    .slice(0, 5)
    .map<Hit>((r) => ({
      key: `rt${r.kind}${r.id}`,
      group: 'recent',
      icon: Clock,
      label: recentLabel(r),
      sub: [r.name, shellDate(r.date)].filter(Boolean).join(' · '),
      right: <b>{shellMoney(r.amount)}</b>,
      score: 0,
      run: () => openRecord(r.kind, r.id),
    }));
  if (recent.length) groups.push({ id: 'recent', hits: recent });
  const wanted = ['payrollCenter', 'payEmployees', 'payLiabilities', 'forms', 'newEmployee', 'summary'];
  const actions = buildActions(company).filter((a) => wanted.includes(a.id));
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
  const company = useSession((s) => s.company);
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
      setGroups(idleGroups(company));
      setHl(-1);
      return;
    }
    const seq = ++searchSeq;
    setLoading(true);
    const t = window.setTimeout(() => {
      runSearch(term, company)
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
  }, [term, open, companyId, company]);

  const flat = useMemo(() => groups.flatMap((g) => g.hits), [groups]);
  // Index flat.length = the "Find paychecks" row (only with a query).
  const rowCount = flat.length + (term ? 1 : 0);

  useEffect(() => {
    if (hl < 0) return;
    dropRef.current?.querySelector(`[data-row="${hl}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [hl]);

  const finish = (fn: () => void) => {
    setOpen(false);
    setQ('');
    ref.current?.blur();
    fn();
  };
  // qAt: the window applies the text again even when it already shows this search
  const seeAll = () => finish(() => openWindow('editVoidPaychecks', { q: term, qAt: Date.now() }));
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
          runSearch(term, company).then((g) => {
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
        if (open) setOpen(false);
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
        setOpen(false);
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
          placeholder={disabled ? 'Open a company to search' : 'Search employees, paychecks, tax payments, reports...'}
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
          !disabled && <span className="sx-kbd">Ctrl K</span>
        )}
      </div>
      {open && focused && !disabled && (
        <div className="sx-gsearch-drop" ref={dropRef} role="listbox" onMouseDown={(e) => e.preventDefault()}>
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
          {term && (
            <div
              className={`sx-gsearch-all${hl === flat.length ? ' sx-hl' : ''}`}
              data-row={flat.length}
              onMouseMove={() => hl !== flat.length && setHl(flat.length)}
              onClick={seeAll}
            >
              <Search size={14} />
              <span>Find paychecks for "{term}"</span>
              <CornerDownLeft size={13} />
            </div>
          )}
          {!term && <div className="sx-gsearch-foot">Type an employee name, a check number or what you want to do.</div>}
        </div>
      )}
    </div>
  );
}

// Edit > Search (and "See all results" of the global search): every match for a text, grouped —
// commands, transactions (number, name, memo, amount), customers & jobs, vendors, other names,
// items, accounts and reports. Up/Down move through the results, Enter opens the selected one.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, BookOpen, Building2, ChartColumn, FileText, Package, Search, Truck, User, Users, Zap, type LucideIcon } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api, getCompanyId, qs } from '@/api/client';
import { useAccounts, useItems, usePrefs, useReportsCatalog } from '@/api/hooks';
import { BALANCE_SHEET_TYPES, type Account, type Item, type Name, type TxnListResult, type TxnSummary } from '@/api/types';
import { EmptyState, FilterChips, SearchBox, Spinner } from '@/components';
import { openTxn, openWindow } from '@/windows/windowStore';
import { buildActions } from '@/shell/navItems';
import { HIDDEN_REPORT_CATEGORIES } from '@/state/catalog';
import { fmtDate, fmtMoney, parseMoney } from '@/util/format';
import { useOptionalWindow } from '@/windows/WindowContext';
import './company.css';

export interface SearchWindowProps {
  q?: string;
}

interface Hit {
  key: string;
  icon: LucideIcon;
  title: ReactNode;
  sub?: ReactNode;
  right?: ReactNode;
  open: () => void;
  /** Second action shown on hover ("Activity Report"). */
  extra?: { label: string; run: () => void };
}

type Group = 'actions' | 'txns' | 'customers' | 'vendors' | 'others' | 'items' | 'accounts' | 'reports';

const GROUP_LABELS: Record<Group, string> = {
  actions: 'Commands',
  txns: 'Transactions',
  customers: 'Customers & jobs',
  vendors: 'Vendors',
  others: 'Other names',
  items: 'Items',
  accounts: 'Accounts',
  reports: 'Reports',
};

const SHOW = 6;

function matches(text: string, words: string[]): boolean {
  const t = text.toLowerCase();
  return words.every((w) => t.includes(w));
}

export default function SearchWindow({ q: initial }: SearchWindowProps) {
  const win = useOptionalWindow();
  const [q, setQ] = useState(initial ?? '');
  const [group, setGroup] = useState<Group | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const prefs = usePrefs();
  useEffect(() => {
    if (initial !== undefined) setQ(initial);
  }, [initial]);
  useEffect(() => {
    win?.setTitle(q.trim() ? `Search: ${q.trim()}` : 'Search');
    setExpanded({});
    setCursor(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const term = q.trim();
  const words = term.toLowerCase().split(/\s+/).filter(Boolean);
  const amount = term && /^[$\d,.\s-]+$/.test(term) ? parseMoney(term.replace(/[$\s]/g, '')) : null;
  const enabled = !!getCompanyId() && term.length > 0;

  const names = useQuery({ queryKey: ['names', 'search', term], queryFn: () => api.get<Name[]>('/names' + qs({ q: term, active: 'all' })), enabled });
  const txns = useQuery({
    queryKey: ['txns', 'search', term],
    queryFn: async () => {
      const byText = await api.get<TxnListResult>('/txns' + qs({ q: term, sort: '-date', limit: 100 }));
      if (amount === null || amount === 0) return byText;
      const byAmount = await api.get<TxnListResult>('/txns' + qs({ amountMin: Math.abs(amount), amountMax: Math.abs(amount), sort: '-date', limit: 100 }));
      const seen = new Set(byText.rows.map((r) => r.id));
      const rows = [...byText.rows, ...byAmount.rows.filter((r) => !seen.has(r.id))].sort((a, b) => b.date.localeCompare(a.date));
      return { rows, total: byText.total + byAmount.rows.filter((r) => !seen.has(r.id)).length };
    },
    enabled,
  });
  const items = useItems({ active: 'all' });
  const accounts = useAccounts({ active: 'all' });
  const catalog = useReportsCatalog();

  const groups = useMemo(() => {
    const out: Record<Group, Hit[]> = { actions: [], txns: [], customers: [], vendors: [], others: [], items: [], accounts: [], reports: [] };
    if (!words.length) return out;
    for (const a of buildActions(prefs.data ?? null)) {
      if (a.reportKey) continue;
      if (matches(`${a.label} ${a.keywords}`, words)) out.actions.push({ key: 'a' + a.id, icon: Zap, title: a.label, open: a.run });
    }
    for (const t of txns.data?.rows ?? []) out.txns.push(txnHit(t));
    for (const n of names.data ?? []) {
      const g: Group = n.kind === 'customer' ? 'customers' : n.kind === 'vendor' ? 'vendors' : 'others';
      out[g].push(nameHit(n));
    }
    for (const i of items.data ?? []) if (matches(`${i.fullName} ${i.description} ${i.mpn}`, words)) out.items.push(itemHit(i));
    for (const a of accounts.data ?? []) if (matches(`${a.number} ${a.fullName} ${a.description}`, words)) out.accounts.push(accountHit(a));
    for (const r of catalog.data ?? []) {
      if (HIDDEN_REPORT_CATEGORIES.includes(r.category)) continue;
      if (matches(`${r.title} ${r.category} ${r.description}`, words))
        out.reports.push({ key: 'r' + r.key, icon: ChartColumn, title: r.title, sub: r.category, open: () => openWindow('report', { key: r.key }) });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term, prefs.data, txns.data, names.data, items.data, accounts.data, catalog.data]);

  const order: Group[] = ['actions', 'txns', 'customers', 'vendors', 'others', 'items', 'accounts', 'reports'];
  const shownGroups = order.filter((g) => groups[g].length > 0 && (!group || group === g));
  const visible: { g: Group; hits: Hit[]; more: number }[] = shownGroups.map((g) => {
    const all = groups[g];
    const limit = group || expanded[g] ? all.length : SHOW;
    return { g, hits: all.slice(0, limit), more: all.length - Math.min(all.length, limit) };
  });
  const flat = visible.flatMap((v) => v.hits);
  const loading = enabled && (names.isLoading || txns.isLoading);
  const totalHits = order.reduce((s, g) => s + groups[g].length, 0);

  useEffect(() => {
    listRef.current?.querySelector('.cx-hit.cx-cur')?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(0, Math.min(flat.length - 1, c + (e.key === 'ArrowDown' ? 1 : -1))));
    } else if (e.key === 'Enter' && flat[cursor]) {
      e.preventDefault();
      flat[cursor].open();
    }
  };

  let idx = -1;
  return (
    <div className="cx-search" onKeyDown={onKey}>
      <div className="cx-search-head">
        <SearchBox
          value={q}
          onChange={setQ}
          debounce={250}
          autoFocus
          placeholder="Search customers, vendors, transactions (number, amount, memo), items, accounts, reports..."
          aria-label="Search"
        />
        {term && (
          <FilterChips
            value={group}
            onChange={(v) => setGroup(v as Group | null)}
            allLabel={`All ${totalHits}`}
            options={order.filter((g) => groups[g].length > 0).map((g) => ({ key: g, label: GROUP_LABELS[g], count: groups[g].length }))}
            aria-label="Result types"
          />
        )}
      </div>
      <div className="cx-search-body" ref={listRef}>
        {!term ? (
          <EmptyState
            icon={Search}
            title="Search your company file"
            message="Type a name, a transaction number, an amount such as 1250.00, a memo, an item, an account or a report name."
          />
        ) : loading && totalHits === 0 ? (
          <div style={{ padding: 30, display: 'grid', placeItems: 'center' }}>
            <Spinner label="Searching..." />
          </div>
        ) : totalHits === 0 ? (
          <EmptyState icon={Search} title={`Nothing found for "${term}"`} message="Check the spelling, or search for part of the name or number." />
        ) : (
          visible.map((v) => (
            <section key={v.g} className="cx-hitgroup">
              <h3>
                {GROUP_LABELS[v.g]} <span className="cx-muted">{groups[v.g].length}</span>
              </h3>
              <ul>
                {v.hits.map((h) => {
                  idx++;
                  const i = idx;
                  return (
                    <li key={h.key}>
                      <div className={'cx-hit' + (i === cursor ? ' cx-cur' : '')} onMouseEnter={() => setCursor(i)}>
                        <button type="button" className="cx-hit-main" onClick={h.open}>
                          <span className="cx-hit-icon">
                            <h.icon size={15} />
                          </span>
                          <span className="cx-hit-text">
                            <span className="cx-hit-title">{h.title}</span>
                            {h.sub && <span className="cx-hit-sub">{h.sub}</span>}
                          </span>
                          {h.right && <span className="cx-hit-right cx-num">{h.right}</span>}
                        </button>
                        {h.extra && (
                          <button type="button" className="sx-linkbtn cx-small cx-hit-extra" onClick={h.extra.run}>
                            {h.extra.label}
                          </button>
                        )}
                        <ArrowRight size={14} className="cx-hit-arrow" />
                      </div>
                    </li>
                  );
                })}
              </ul>
              {v.more > 0 && (
                <button type="button" className="sx-linkbtn cx-small cx-hit-more" onClick={() => setExpanded((x) => ({ ...x, [v.g]: true }))}>
                  Show {v.more} more
                </button>
              )}
            </section>
          ))
        )}
        {term && txns.data && txns.data.total > txns.data.rows.length && (!group || group === 'txns') && (
          <div className="cx-muted cx-small" style={{ padding: '4px 4px 12px' }}>
            Only the 100 most recent matching transactions are listed.{' '}
            <button type="button" className="sx-linkbtn" onClick={() => openWindow('find')}>
              Use Find
            </button>{' '}
            to narrow the search.
          </div>
        )}
      </div>
    </div>
  );
}

function txnHit(t: TxnSummary): Hit {
  return {
    key: 't' + t.id,
    icon: t.type === 'GENJRNL' ? BookOpen : FileText,
    title: (
      <>
        {t.typeLabel}
        {t.refNumber ? ` #${t.refNumber}` : ''}
        {t.nameFull ? <span className="cx-muted"> · {t.nameFull}</span> : null}
        {t.voided && <span className="cx-muted"> (void)</span>}
      </>
    ),
    sub: [fmtDate(t.date), t.accountName, t.memo].filter(Boolean).join(' · '),
    right: fmtMoney(t.amount),
    open: () => openTxn(t.type, t.id),
  };
}

function nameHit(n: Name): Hit {
  const icon = n.kind === 'customer' ? Users : n.kind === 'vendor' ? Truck : User;
  const contact = [n.companyName && n.companyName !== n.name ? n.companyName : '', n.phone, n.email].filter(Boolean).join(' · ');
  return {
    key: 'n' + n.id,
    icon,
    title: (
      <>
        {n.fullName}
        {!n.active && <span className="cx-muted"> (inactive)</span>}
      </>
    ),
    sub: contact || (n.kind === 'customer' ? (n.parentId ? 'Job' : 'Customer') : n.kind === 'vendor' ? 'Vendor' : 'Other name'),
    right: n.kind !== 'other' && n.balance ? fmtMoney(n.balance) : undefined,
    open: () =>
      n.kind === 'customer'
        ? openWindow('customerCenter', { selectId: n.id })
        : n.kind === 'vendor'
          ? openWindow('vendorCenter', { selectId: n.id })
          : openWindow('otherNameEdit', { id: n.id }),
    extra: { label: 'Activity Report', run: () => openWindow('report', { key: 'name_quickreport', params: { nameId: String(n.id), dates: 'all' } }) },
  };
}

function itemHit(i: Item): Hit {
  return {
    key: 'i' + i.id,
    icon: Package,
    title: (
      <>
        {i.fullName}
        {!i.active && <span className="cx-muted"> (inactive)</span>}
      </>
    ),
    sub: [i.type, i.description].filter(Boolean).join(' · '),
    right: i.rateIsPercent ? `${i.salesPrice}%` : i.salesPrice ? fmtMoney(i.salesPrice) : undefined,
    open: () => openWindow('itemEdit', { id: i.id }),
    extra: { label: 'Activity Report', run: () => openWindow('report', { key: 'item_quickreport', params: { itemId: String(i.id), dates: 'all' } }) },
  };
}

function accountHit(a: Account): Hit {
  const bs = BALANCE_SHEET_TYPES.includes(a.type);
  return {
    key: 'c' + a.id,
    icon: Building2,
    title: (
      <>
        {a.number ? `${a.number} · ` : ''}
        {a.fullName}
        {!a.active && <span className="cx-muted"> (inactive)</span>}
      </>
    ),
    sub: a.type,
    right: bs ? fmtMoney(a.balance) : undefined,
    open: () =>
      bs
        ? openWindow('register', { accountId: a.id, accountName: a.name })
        : openWindow('report', { key: 'account_quickreport', params: { accountId: String(a.id), dates: 'thisFiscalYearToDate' } }),
    extra: bs
      ? { label: 'Activity Report', run: () => openWindow('report', { key: 'account_quickreport', params: { accountId: String(a.id), dates: 'all' } }) }
      : undefined,
  };
}

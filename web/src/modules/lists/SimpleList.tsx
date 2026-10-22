// Shared window of the simple lists (Class List and the other lists of the Lists menu: sales reps,
// customer / vendor / job types, terms, customer messages, payment methods, ship via).
// List columns depend on the list (terms show their rule, payment methods their type, reps their
// initials). Bottom menu "<List> ▾" (New, Edit, Delete, Make inactive, Show inactive, views, Print),
// optional Reports ▾; search, include inactive, hover actions. Double-click edits.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Info, ListPlus, Plus } from 'lucide-react';
import { api } from '@/api/client';
import { useList, useNames } from '@/api/hooks';
import { LIST_TITLES, type ID, type ListEntry, type ListName } from '@/api/types';
import { Button, Checkbox, DropdownButton, EmptyState, ListView, useHotkeys, type ListColumn, type MenuItem } from '@/components';
import { openWindow } from '@/windows/windowStore';
import {
  actionsColumn,
  deleteBlocker,
  deleteRecord,
  descendantIds,
  ListPage,
  ListSearchBox,
  matchesSearch,
  plural,
  printList,
  setRecordActive,
  useCreatedListener,
  useElementWidth,
  useRevealRow,
  useAutoSelect,
  useLocalState,
} from './common';

/** Lists whose entries can have subentries. */
export const HIERARCHICAL_LISTS: ListName[] = ['class', 'customer_type', 'vendor_type', 'job_type'];

/** Singular, lower case noun of an entry ("class", "terms", "payment method"...). */
export const ENTRY_WORD: Record<ListName, string> = {
  class: 'class',
  customer_type: 'customer type',
  vendor_type: 'vendor type',
  job_type: 'job type',
  terms: 'terms',
  payment_method: 'payment method',
  ship_via: 'shipping method',
  customer_message: 'customer message',
  sales_rep: 'sales rep',
};

const PLURAL: Record<ListName, string> = {
  class: 'classes',
  customer_type: 'customer types',
  vendor_type: 'vendor types',
  job_type: 'job types',
  terms: 'terms',
  payment_method: 'payment methods',
  ship_via: 'shipping methods',
  customer_message: 'customer messages',
  sales_rep: 'sales reps',
};

const EMPTY_TEXT: Record<ListName, string> = {
  class: 'Classes let you track income and expenses by department, location, business line or any other way you divide your business.',
  customer_type: 'Customer types group your customers (for example Retail, Wholesale or Referral) so you can filter lists and reports by type.',
  vendor_type: 'Vendor types group your vendors (for example Suppliers, Subcontractors or Utilities) so you can filter lists and reports by type.',
  job_type: 'Job types group jobs by the kind of work (for example Installation or Maintenance) so you can compare them in reports.',
  terms: 'Terms say when payment is due and whether there is a discount for paying early, for example Net 30 or 2% 10 Net 30.',
  payment_method: 'Payment methods (Cash, Check, Visa...) are recorded on payments and sales receipts, and help you group deposits.',
  ship_via: 'Shipping methods appear in the VIA field of invoices and sales receipts.',
  customer_message: 'Messages print at the bottom of invoices, sales receipts and estimates, for example "Thank you for your business."',
  sales_rep: 'Sales reps are the people who bring in sales. Put a rep on customers and invoices to see your sales by rep.',
};

const ordinal = (n: number) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

/** Plain-English rule of a terms entry ("Due in 30 days · 2% discount if paid within 10 days"). */
export function termsSummary(d: Record<string, any>): string {
  const pct = Number(d.discountPct) || 0;
  if (d.dateDriven) {
    const due = Number(d.dueDay) || 1;
    const within = Number(d.dueNextMonthDays) || 0;
    let s = `Due on the ${ordinal(due)} of the month`;
    if (within) s += ` (next month if issued within ${within} days of it)`;
    if (pct) s += ` · ${pct}% discount if paid by the ${ordinal(Number(d.discountDay) || 1)}`;
    return s;
  }
  const net = Number(d.netDays) || 0;
  let s = net ? `Due in ${net} days` : 'Due on receipt';
  if (pct) s += ` · ${pct}% discount if paid within ${Number(d.discountDays) || 0} days`;
  return s;
}

/** Props of {@link SimpleListWindow}. */
export interface SimpleListWindowProps {
  list: ListName;
  /** Entries of the Reports ▾ menu (the selected entry is passed). */
  reports?: (sel: ListEntry | null) => MenuItem[];
  /** Notice shown above the list (e.g. class tracking is off). */
  notice?: ReactNode;
  selectId?: number;
}

/** A simple list window (see the file header). */
export function SimpleListWindow({ list, reports, notice, selectId }: SimpleListWindowProps) {
  const title = LIST_TITLES[list] ?? 'List';
  const word = ENTRY_WORD[list] ?? 'entry';
  const tree = HIERARCHICAL_LISTS.includes(list);
  const { data, isLoading, error, refetch } = useList(list, { active: 'all' });
  const { data: names } = useNames(undefined, { active: 'all' });
  const [q, setQ] = useState('');
  const [showInactive, setShowInactive] = useLocalState(`sx.fl.list.${list}.inactive`, false);
  const [flat, setFlat] = useLocalState(`sx.fl.list.${list}.flat`, false);
  const [selId, setSelId] = useState<ID | null>(selectId ?? null);
  const rootRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(rootRef);

  useEffect(() => {
    if (selectId) {
      setSelId(selectId);
      reveal(selectId);
    }
  }, [selectId]); // eslint-disable-line react-hooks/exhaustive-deps
  useCreatedListener(
    'list',
    (d) => {
      setSelId(d.id);
      setQ('');
      reveal(d.id);
    },
    list,
  );

  const all = data ?? [];
  const searching = q.trim() !== '';
  const rows = useMemo(() => all.filter((e) => (showInactive || e.active) && (!searching || matchesSearch(q, e.fullName, e.data?.initials))), [all, showInactive, q, searching]);
  const treeMode = tree && !flat && !searching;
  const reveal = useRevealRow(rootRef, rows, (r) => r.id);
  const sel = rows.find((e) => e.id === selId) ?? null;
  useAutoSelect(rows, sel, (r) => setSelId(r.id), reveal.pending);

  const newEntry = (parentId?: ID) => openWindow('listEntryEdit', parentId ? { list, parentId } : { list });
  const edit = (e: ListEntry | null = sel) => e && openWindow('listEntryEdit', { list, id: e.id });
  const del = (e: ListEntry | null = sel) =>
    e &&
    deleteRecord({
      what: word,
      name: e.fullName,
      blocked: tree ? deleteBlocker(word, e.fullName, { children: descendantIds(all, e.id).size - 1 }) : null,
      // the row's updatedAt (here and in the PUTs below): refused when someone changed the entry since the list was loaded
      request: () => api.del(`/lists/${list}/${e.id}${e.updatedAt ? `?updatedAt=${encodeURIComponent(e.updatedAt)}` : ''}`),
      makeInactive: () => api.put(`/lists/${list}/${e.id}`, { ...e, active: false }),
    });
  const toggleActive = (e: ListEntry | null = sel) =>
    e &&
    setRecordActive({
      what: word,
      name: e.fullName,
      active: !e.active,
      childCount: e.active && tree ? descendantIds(all, e.id).size - 1 : 0,
      childWord: 'subentries',
      request: () => api.put(`/lists/${list}/${e.id}`, { ...e, active: !e.active }),
    });

  const linkedName = (e: ListEntry) => (e.data?.nameId ? names?.find((n) => n.id === e.data.nameId)?.fullName ?? '' : '');

  const columns: ListColumn<ListEntry>[] = [
    {
      key: 'name',
      label: list === 'customer_message' ? 'Message' : list === 'sales_rep' ? 'Sales rep name' : 'Name',
      width: list === 'terms' ? 180 : 200,
      grow: list !== 'terms',
      sortValue: (e) => e.fullName,
      render: (e) => <span className="fl-name-text">{treeMode ? e.name : e.fullName}</span>,
    },
  ];
  if (list === 'terms') {
    columns.push({ key: 'kind', label: 'Type', width: 100, sortValue: (e) => (e.data?.dateDriven ? 'Date driven' : 'Standard'), render: (e) => (e.data?.dateDriven ? 'Date driven' : 'Standard') });
    if (width >= 560) columns.push({ key: 'rule', label: 'Rule', width: 300, grow: true, sortValue: (e) => termsSummary(e.data ?? {}), render: (e) => <span className="fl-dim">{termsSummary(e.data ?? {})}</span> });
  } else if (list === 'payment_method') {
    columns.push({ key: 'ptype', label: 'Payment type', width: 150, sortValue: (e) => e.data?.type ?? '', render: (e) => e.data?.type ?? '' });
  } else if (list === 'sales_rep') {
    columns.push({ key: 'initials', label: 'Initials', width: 80, sortValue: (e) => e.data?.initials ?? '', render: (e) => e.data?.initials ?? '' });
    if (width >= 520) columns.push({ key: 'linked', label: 'Linked name', width: 180, sortValue: linkedName, render: linkedName });
  }
  if (width >= 640) columns.push(actionsColumn<ListEntry>((e) => [{ label: 'Edit', onClick: () => edit(e), title: 'Edit (Ctrl+E)' }], 70));

  const print = () =>
    printList(
      `${title} List`,
      columns.filter((c) => c.key !== '__act').map((c) => ({ label: String(c.label) })),
      rows.map((e) => ({
        cells: columns
          .filter((c) => c.key !== '__act')
          .map((c) => (c.key === 'name' ? (treeMode ? e.name : e.fullName) : c.key === 'rule' ? termsSummary(e.data ?? {}) : c.key === 'kind' ? (e.data?.dateDriven ? 'Date driven' : 'Standard') : c.key === 'ptype' ? e.data?.type ?? '' : c.key === 'initials' ? e.data?.initials ?? '' : c.key === 'linked' ? linkedName(e) : '')),
        level: treeMode ? e.level : 0,
        inactive: !e.active,
      })),
    );

  useHotkeys({
    'ctrl+e': () => (sel ? void edit() : false),
    'ctrl+d': () => (sel ? void del() : false),
  });

  const listMenu: MenuItem[] = [
    { label: '&New', onClick: () => newEntry() },
    { label: `&Edit ${title}`, shortcut: 'Ctrl+E', disabled: !sel, onClick: () => edit() },
    { label: `&Delete ${title}`, shortcut: 'Ctrl+D', disabled: !sel, onClick: () => void del() },
    { label: sel && !sel.active ? `Make ${title} &Active` : `Make ${title} &Inactive`, disabled: !sel, onClick: () => void toggleActive() },
    ...(tree ? [{ label: `New &Sub${word}`, disabled: !sel, onClick: () => sel && newEntry(sel.id) }] : []),
    { separator: true },
    { label: 'Show Inacti&ve Entries', checked: showInactive, onClick: () => setShowInactive(!showInactive) },
    ...(tree
      ? [
          { label: '&Hierarchical View', checked: !flat, onClick: () => setFlat(false) },
          { label: '&Flat View', checked: flat, onClick: () => setFlat(true) },
        ]
      : []),
    { separator: true },
    { label: '&Print List...', onClick: () => void print() },
  ];
  const rowMenu = (e: ListEntry | null): MenuItem[] =>
    e
      ? [
          { label: `&Edit ${title}`, shortcut: 'Ctrl+E', onClick: () => edit(e) },
          { label: `&New ${title}`, onClick: () => newEntry() },
          ...(tree ? [{ label: `New &Sub${word}`, onClick: () => newEntry(e.id) }] : []),
          { label: `&Delete ${title}`, shortcut: 'Ctrl+D', onClick: () => void del(e) },
          { label: e.active ? `Make ${title} &Inactive` : `Make ${title} &Active`, onClick: () => void toggleActive(e) },
        ]
      : [{ label: `&New ${title}`, onClick: () => newEntry() }];

  const total = showInactive ? all.length : all.filter((e) => e.active).length;
  const status = rows.length === total ? plural(total, 'entry', 'entries') : `${rows.length} of ${plural(total, 'entry', 'entries')}`;
  const empty = !isLoading && !error && data && all.length === 0;
  const reportItems = reports?.(sel) ?? [];

  return (
    <ListPage
      rootRef={rootRef}
      toolbar={<ListSearchBox value={q} onChange={setQ} placeholder={`Search ${PLURAL[list] ?? `${title.toLowerCase()} list`}`} aria-label={`Search ${title} list`} />}
      actions={<Button variant="primary" icon={Plus} label={`New ${word}`} onClick={() => newEntry()} />}
      bulk={notice}
      footer={
        <>
          <DropdownButton label={title} items={listMenu} up />
          {reportItems.length > 0 && <DropdownButton label="Re&ports" items={reportItems} up />}
          <Checkbox checked={showInactive} onChange={setShowInactive} label="Include inactive" style={{ marginLeft: 8 }} />
        </>
      }
      status={data ? status : undefined}
    >
      {error ? (
        <div className="fl-emptywrap">
          <EmptyState icon={ListPlus} title="The list could not be loaded" message={(error as Error).message} action={{ label: 'Try again', onClick: () => void refetch() }} />
        </div>
      ) : empty ? (
        <div className="fl-emptywrap">
          <EmptyState icon={ListPlus} title={`No ${PLURAL[list] ?? 'entries'} yet`} message={EMPTY_TEXT[list]} action={{ label: `Add a ${word}`, onClick: () => newEntry(), icon: Plus }} />
        </div>
      ) : (
        <ListView<ListEntry>
          className="fl-list"
          aria-label={`${title} list`}
          columns={columns}
          rows={rows}
          loading={isLoading}
          selectedKey={sel?.id ?? null}
          onSelect={(k) => setSelId(k as ID)}
          onActivate={(e) => edit(e)}
          contextMenu={rowMenu}
          getLevel={treeMode ? (e) => e.level : undefined}
          indentKey="name"
          isInactive={(e) => !e.active}
          showInactiveColumn={showInactive}
          persistKey={`fl-list-${list}`}
          autoFocus
          emptyText="Nothing matches your search."
        />
      )}
    </ListPage>
  );
}

/** Info bar shown above a list (e.g. "Class tracking is turned off"). */
export function ListNotice({ children, action }: { children: ReactNode; action?: { label: string; onClick: () => void } }) {
  return (
    <div className="fl-info" role="note">
      <Info size={16} />
      <span style={{ flex: 1 }}>{children}</span>
      {action && (
        <button type="button" className="fl-linkbtn" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}

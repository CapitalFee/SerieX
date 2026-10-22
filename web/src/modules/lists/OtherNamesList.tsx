// Other Names List (Lists > Other Names List; Banking > Other Names List).
// Other names are people and businesses that are neither customers nor vendors (owners, partners,
// employees paid by check). Columns NAME, COMPANY, PHONE, EMAIL; bottom menus Other Names ▾,
// Activities ▾, Reports ▾; search, include inactive, bulk select, hover actions.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, UserRound } from 'lucide-react';
import { api } from '@/api/client';
import { useNames } from '@/api/hooks';
import type { ID, Name } from '@/api/types';
import { Button, Checkbox, DropdownButton, EmptyState, ListView, useHotkeys, type ListColumn, type MenuItem } from '@/components';
import { downloadCsv } from '@/util/csv';
import { openWindow } from '@/windows/windowStore';
import {
  actionsColumn,
  deleteBlocker,
  deleteRecord,
  downloadExport,
  ListPage,
  ListSearchBox,
  matchesSearch,
  openNameActivity,
  openReport,
  plural,
  printList,
  runBulk,
  setRecordActive,
  useBulkSelect,
  useCreatedListener,
  useElementWidth,
  useRevealRow,
  useAutoSelect,
  useLocalState,
} from './common';

export interface OtherNamesListProps {
  /** Name to select when the window opens (global search). */
  selectId?: number;
}

const contactName = (n: Name) => [n.salutation, n.firstName, n.middleName, n.lastName].filter(Boolean).join(' ');

export default function OtherNamesList(props: OtherNamesListProps) {
  const { data, isLoading, error, refetch } = useNames('other', { active: 'all' });
  const [q, setQ] = useState('');
  const [showInactive, setShowInactive] = useLocalState('sx.fl.other.inactive', false);
  const [selId, setSelId] = useState<ID | null>(props.selectId ?? null);
  const rootRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(rootRef);

  useEffect(() => {
    if (props.selectId) {
      setSelId(props.selectId);
      setQ('');
      reveal(props.selectId);
    }
  }, [props.selectId]); // eslint-disable-line react-hooks/exhaustive-deps
  useCreatedListener('name', (d) => {
    setSelId(d.id);
    setQ('');
    reveal(d.id);
  });

  const all = data ?? [];
  // a name opened from the global search is shown even when it is inactive
  const forced = props.selectId && all.find((n) => n.id === props.selectId && !n.active) ? props.selectId : null;
  const rows = useMemo(
    () =>
      all.filter(
        (n) => (showInactive || n.active || n.id === forced) && (!q.trim() || matchesSearch(q, n.name, n.companyName, contactName(n), n.phone, n.mobile, n.email, n.notes)),
      ),
    [all, showInactive, forced, q],
  );
  const reveal = useRevealRow(rootRef, rows, (r) => r.id);
  const sel = rows.find((n) => n.id === selId) ?? null;
  useAutoSelect(rows, sel, (r) => setSelId(r.id), reveal.pending);

  const bulk = useBulkSelect<Name>(rows, (n) => n.id, (n) => n.name);

  const newName = () => openWindow('otherNameEdit', {});
  const edit = (n: Name | null = sel) => n && openWindow('otherNameEdit', { id: n.id });
  const del = (n: Name | null = sel) =>
    n &&
    deleteRecord({
      what: 'name',
      name: n.name,
      blocked: deleteBlocker('name', n.name, { hasTxns: n.hasTxns }),
      request: () => api.del(`/names/${n.id}`),
      makeInactive: () => api.put(`/names/${n.id}/active`, { active: false }),
    });
  const toggleActive = (n: Name | null = sel) =>
    n && setRecordActive({ what: 'name', name: n.name, active: !n.active, request: () => api.put(`/names/${n.id}/active`, { active: !n.active }) });
  const activityReport = (n: Name | null = sel) => n && openNameActivity(n.id, n.name);
  const writeCheck = (n: Name | null = sel) => openWindow('writeCheck', n ? { payeeId: n.id } : {});

  const print = () =>
    printList(
      'Other Names List',
      [{ label: 'Name' }, { label: 'Company' }, { label: 'Contact' }, { label: 'Phone' }, { label: 'Email' }],
      rows.map((n) => ({ cells: [n.name, n.companyName, contactName(n), n.phone || n.mobile, n.email], inactive: !n.active })),
    );
  const exportSelected = () => {
    const list = rows.filter((n) => bulk.selected.has(n.id));
    downloadCsv('other-names-selected', [
      ['Name', 'Company', 'First', 'Last', 'Phone', 'Mobile', 'Email', 'Active'],
      ...list.map((n) => [n.name, n.companyName, n.firstName, n.lastName, n.phone, n.mobile, n.email, n.active ? 'Yes' : 'No']),
    ]);
  };

  useHotkeys({
    'ctrl+e': () => (sel ? void edit() : false),
    'ctrl+d': () => (sel ? void del() : false),
    'ctrl+q': () => (sel ? void activityReport() : false),
  });

  const listMenu: MenuItem[] = [
    { label: '&New', onClick: newName },
    { label: '&Edit Name', shortcut: 'Ctrl+E', disabled: !sel, onClick: () => edit() },
    { label: '&Delete Name', shortcut: 'Ctrl+D', disabled: !sel, onClick: () => void del() },
    { label: sel && !sel.active ? 'Make Name &Active' : 'Make Name &Inactive', disabled: !sel, onClick: () => void toggleActive() },
    { separator: true },
    { label: 'Show Inacti&ve Names', checked: showInactive, onClick: () => setShowInactive(!showInactive) },
    { separator: true },
    { label: '&Print List...', onClick: () => void print() },
    { label: 'I&mport from CSV...', onClick: () => openWindow('importData', { entity: 'other' }) },
    { label: 'E&xport to CSV', onClick: () => void downloadExport('other') },
  ];
  const activitiesMenu: MenuItem[] = [
    { label: sel ? `&Write Check to ${sel.name}` : '&Write Checks', onClick: () => writeCheck() },
    { label: 'Make General &Journal Entries', onClick: () => openWindow('journalEntry') },
  ];
  const reportsMenu: MenuItem[] = [
    { label: sel ? `&Activity Report: ${sel.name}` : '&Activity Report', shortcut: 'Ctrl+Q', disabled: !sel, onClick: () => activityReport() },
    { separator: true },
    { label: 'Other Names &Phone List', onClick: () => openReport('other_names_phone_list') },
  ];
  const rowMenu = (n: Name | null): MenuItem[] =>
    n
      ? [
          { label: '&Edit Name', shortcut: 'Ctrl+E', onClick: () => edit(n) },
          { label: '&Activity Report', shortcut: 'Ctrl+Q', onClick: () => activityReport(n) },
          { label: '&Write Check', onClick: () => writeCheck(n) },
          { separator: true },
          { label: '&New Name', onClick: newName },
          { label: '&Delete Name', shortcut: 'Ctrl+D', onClick: () => void del(n) },
          { label: n.active ? 'Make Name &Inactive' : 'Make Name &Active', onClick: () => void toggleActive(n) },
        ]
      : [{ label: '&New Name', onClick: newName }];

  const columns: ListColumn<Name>[] = [
    bulk.column,
    { key: 'name', label: 'Name', width: 200, grow: true },
    ...(width >= 620 ? [{ key: 'companyName', label: 'Company', width: 170 } as ListColumn<Name>] : []),
    { key: 'phone', label: 'Phone', width: 130, sortValue: (n) => n.phone || n.mobile, render: (n) => n.phone || n.mobile },
    ...(width >= 760 ? [{ key: 'email', label: 'Email', width: 220 } as ListColumn<Name>] : []),
    ...(width >= 900
      ? [
          actionsColumn<Name>((n) => [
            { label: 'Edit', onClick: () => edit(n), title: 'Edit (Ctrl+E)' },
            { label: 'Write check', onClick: () => writeCheck(n) },
          ]),
        ]
      : []),
  ];

  const total = showInactive ? all.length : all.filter((n) => n.active).length;
  const status = rows.length === total ? plural(total, 'name') : `${rows.length} of ${plural(total, 'name')}`;
  const selRecords = rows.filter((n) => bulk.selected.has(n.id));
  const empty = !isLoading && !error && data && all.length === 0;

  return (
    <ListPage
      rootRef={rootRef}
      toolbar={<ListSearchBox value={q} onChange={setQ} placeholder="Search names" aria-label="Search names" />}
      actions={<Button variant="primary" icon={Plus} label="New name" onClick={newName} />}
      bulk={
        bulk.count > 0 ? (
          <div className="fl-bulkbar" role="toolbar" aria-label="Selected names">
            <span className="fl-bulkbar-text">{plural(bulk.count, 'name')} selected</span>
            <Button
              small
              label="Make inactive"
              onClick={() => void runBulk(selRecords.filter((n) => n.active), (n) => n.name, (n) => api.put(`/names/${n.id}/active`, { active: false }), (c) => `${plural(c, 'name')} made inactive`).then(bulk.clear)}
            />
            <Button
              small
              label="Make active"
              onClick={() => void runBulk(selRecords.filter((n) => !n.active), (n) => n.name, (n) => api.put(`/names/${n.id}/active`, { active: true }), (c) => `${plural(c, 'name')} made active`).then(bulk.clear)}
            />
            <Button small label="Export to CSV" onClick={exportSelected} />
            <Button small variant="ghost" label="Clear selection" onClick={bulk.clear} />
          </div>
        ) : null
      }
      footer={
        <>
          <DropdownButton label="&Other Names" items={listMenu} up />
          <DropdownButton label="Ac&tivities" items={activitiesMenu} up />
          <DropdownButton label="Re&ports" items={reportsMenu} up />
          <Checkbox checked={showInactive} onChange={setShowInactive} label="Include inactive" style={{ marginLeft: 8 }} />
        </>
      }
      status={data ? status : undefined}
    >
      {error ? (
        <div className="fl-emptywrap">
          <EmptyState icon={UserRound} title="The list could not be loaded" message={(error as Error).message} action={{ label: 'Try again', onClick: () => void refetch() }} />
        </div>
      ) : empty ? (
        <div className="fl-emptywrap">
          <EmptyState
            icon={UserRound}
            title="No other names yet"
            message="Other names are people and businesses that are not customers or vendors, such as owners, partners or employees you write checks to."
            action={{ label: 'Add a name', onClick: newName, icon: Plus }}
          />
        </div>
      ) : (
        <ListView<Name>
          className="fl-list"
          aria-label="Other names"
          columns={columns}
          rows={rows}
          loading={isLoading}
          selectedKey={sel?.id ?? null}
          onSelect={(k) => setSelId(k as ID)}
          onActivate={(n) => edit(n)}
          contextMenu={rowMenu}
          isInactive={(n) => !n.active}
          showInactiveColumn={showInactive}
          persistKey="fl-other"
          autoFocus
          emptyText="No names match your search."
          onKeyDown={(e) => bulk.onListKeyDown(e, sel)}
        />
      )}
    </ListPage>
  );
}

// Memorized Report List: memorized reports grouped (groups with their
// reports indented). Display (run), Edit (name / group) and Delete; search; right-click menu.
import { useEffect, useMemo, useState } from 'react';
import { BookmarkCheck, FileBarChart, Folder, Pencil, Play, Trash2 } from 'lucide-react';
import type { MemorizedReport } from '@/api/types';
import { useReportsCatalog } from '@/api/hooks';
import { Button, DropdownButton, EmptyState, ListView, SearchBox, useHotkeys, type ListColumn, type MenuItem } from '@/components';
import { openWindow } from '@/windows/windowStore';
import { presetLabel } from '@/util/dates';
import { fmtDate } from '@/util/format';
import { STATIC_REPORTS } from '@/state/catalog';
import { deleteMemorizedReport, editMemorizedReport, runMemorizedReport, useMemorizedReports } from './memorized';
import './reports.css';

export interface MemorizedReportListProps {}

type Row = { id: string; kind: 'group'; name: string; count: number } | { id: string; kind: 'report'; m: MemorizedReport; grouped: boolean };

function datesOf(m: MemorizedReport): string {
  const p = m.params ?? {};
  if (p.dates && p.dates !== 'custom') return presetLabel(p.dates);
  if (p.from || p.to) return `${p.from ? fmtDate(p.from) : 'Beginning'} – ${p.to ? fmtDate(p.to) : 'today'}`;
  if (p.asOf) return `As of ${fmtDate(p.asOf)}`;
  return 'Report default';
}

export default function MemorizedReportList(_props: MemorizedReportListProps) {
  const { data, isLoading } = useMemorizedReports();
  const { data: catalog } = useReportsCatalog();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string | null>(null);

  const titleOf = (key: string) => catalog?.find((r) => r.key === key)?.title ?? STATIC_REPORTS.find((r) => r.key === key)?.title ?? key;

  const rows = useMemo<Row[]>(() => {
    const t = q.trim().toLowerCase();
    const list = (data ?? []).filter((m) => !t || m.name.toLowerCase().includes(t) || m.groupName.toLowerCase().includes(t) || titleOf(m.reportKey).toLowerCase().includes(t));
    const groups = new Map<string, MemorizedReport[]>();
    const loose: MemorizedReport[] = [];
    for (const m of list) {
      if (m.groupName) {
        if (!groups.has(m.groupName)) groups.set(m.groupName, []);
        groups.get(m.groupName)!.push(m);
      } else loose.push(m);
    }
    const out: Row[] = [];
    for (const g of [...groups.keys()].sort((a, b) => a.localeCompare(b))) {
      const ms = groups.get(g)!;
      out.push({ id: 'g:' + g, kind: 'group', name: g, count: ms.length });
      for (const m of ms) out.push({ id: 'm:' + m.id, kind: 'report', m, grouped: true });
    }
    for (const m of loose) out.push({ id: 'm:' + m.id, kind: 'report', m, grouped: false });
    return out;
  }, [data, q, catalog]); // eslint-disable-line react-hooks/exhaustive-deps

  // select the first memorized report when the list loads (Display / Enter work at once)
  useEffect(() => {
    if (sel && rows.some((r) => r.id === sel)) return;
    const first = rows.find((r) => r.kind === 'report');
    if (first) setSel(first.id);
  }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps

  const selected = rows.find((r) => r.id === sel);
  const selM = selected?.kind === 'report' ? selected.m : null;

  const edit = (m: MemorizedReport | null) => m && void editMemorizedReport(m, data);
  const del = async (m: MemorizedReport | null) => {
    if (!m) return;
    const i = rows.findIndex((r) => r.id === 'm:' + m.id);
    if (await deleteMemorizedReport(m)) {
      const next =
        rows.slice(i + 1).find((r) => r.kind === 'report') ??
        rows
          .slice(0, i)
          .reverse()
          .find((r) => r.kind === 'report');
      setSel(next?.id ?? null);
    }
  };

  useHotkeys({
    'ctrl+e': () => (selM ? edit(selM) : false),
    'ctrl+d': () => (selM ? void del(selM) : false),
  });

  const menuFor = (m: MemorizedReport | null): MenuItem[] => [
    { label: '&Display Report', onClick: () => m && runMemorizedReport(m), disabled: !m },
    { separator: true },
    { label: '&Edit Memorized Report…', shortcut: 'Ctrl+E', onClick: () => edit(m), disabled: !m },
    { label: 'De&lete Memorized Report', shortcut: 'Ctrl+D', onClick: () => void del(m), disabled: !m },
    { separator: true },
    { label: 'Report &Center', onClick: () => openWindow('reportCenter') },
  ];

  const columns: ListColumn<Row>[] = [
    {
      key: 'name',
      label: 'Report name',
      width: 240,
      grow: true,
      sortable: false,
      render: (r) =>
        r.kind === 'group' ? (
          <span className="mr-group-row">
            <Folder size={13} style={{ verticalAlign: '-2px', marginRight: 6, color: '#64748b' }} />
            {r.name} <span style={{ fontWeight: 400, color: '#6b7280' }}>({r.count})</span>
          </span>
        ) : (
          r.m.name
        ),
    },
    { key: 'report', label: 'Report', width: 200, sortable: false, render: (r) => (r.kind === 'report' ? titleOf(r.m.reportKey) : '') },
    { key: 'dates', label: 'Dates', width: 150, sortable: false, render: (r) => (r.kind === 'report' ? datesOf(r.m) : '') },
    {
      key: 'actions',
      label: '',
      width: 92,
      sortable: false,
      render: (r) =>
        r.kind === 'report' ? (
          <span className="mr-hover-actions">
            <button type="button" className="sx-iconbtn" title="Display the report" aria-label={`Display ${r.m.name}`} onClick={() => runMemorizedReport(r.m)}>
              <Play size={13} />
            </button>
            <button type="button" className="sx-iconbtn" title="Rename or change group" aria-label={`Edit ${r.m.name}`} onClick={() => edit(r.m)}>
              <Pencil size={13} />
            </button>
            <button type="button" className="sx-iconbtn" title="Delete" aria-label={`Delete ${r.m.name}`} onClick={() => void del(r.m)}>
              <Trash2 size={13} />
            </button>
          </span>
        ) : null,
    },
  ];

  const empty = !isLoading && (data?.length ?? 0) === 0;

  return (
    <div className="mr-win">
      <div className="mr-top">
        <SearchBox value={q} onChange={setQ} placeholder="Find a memorized report" width={280} aria-label="Find a memorized report" />
      </div>
      <div className="mr-list">
        {empty ? (
          <EmptyState
            icon={BookmarkCheck}
            title="No memorized reports yet"
            message="Open any report, set its dates, filters and columns the way you like, then click Memorize. It is saved here so you can run it again with one click."
            action={{ label: 'See all reports', icon: FileBarChart, onClick: () => openWindow('reportCenter') }}
          />
        ) : (
          <ListView<Row>
            columns={columns}
            rows={rows}
            getKey={(r) => r.id}
            selectedKey={sel}
            onSelect={(k) => setSel(String(k))}
            onActivate={(r) => r.kind === 'report' && runMemorizedReport(r.m)}
            getLevel={(r) => (r.kind === 'report' && r.grouped ? 1 : 0)}
            contextMenu={(r) => menuFor(r && r.kind === 'report' ? r.m : null)}
            loading={isLoading}
            autoFocus
            persistKey="memorizedReports"
            emptyText={q ? `No memorized report matches "${q}".` : undefined}
            aria-label="Memorized reports"
            onKeyDown={(e) => {
              if (e.key === 'Delete' && selM) {
                e.preventDefault();
                void del(selM);
              }
            }}
          />
        )}
      </div>
      <div className="mr-bottom">
        <DropdownButton label="&Memorized Report" items={menuFor(selM)} up />
        <span style={{ flex: 1 }} />
        <Button label="All Reports" icon={FileBarChart} onClick={() => openWindow('reportCenter')} />
        <Button variant="primary" label="&Display" icon={Play} disabled={!selM} onClick={() => selM && runMemorizedReport(selM)} />
      </div>
    </div>
  );
}

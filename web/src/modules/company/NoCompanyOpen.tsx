// "No Company Open" welcome screen (not an MDI window: App shows it on the empty work area).
// Start page: create a company, open or restore one,
// open the sample company, and the list of company files with Open / Remove from list.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArchiveRestore, Building2, FolderInput, FolderOpen, Plus, Sparkles, Trash2, X } from 'lucide-react';
import { api } from '@/api/client';
import type { CompanyFile } from '@/api/types';
import { Badge, Button, EmptyState, SearchBox, Spinner, confirmBox, toast } from '@/components';
import { openWindow } from '@/windows/windowStore';
import { getLastCompanyId, getRecentCompanies, forgetRecentCompany } from '@/state/session';
import { queryClient } from '@/api/hooks';
import { fmtBytes, fmtDateTime, timeAgo, useCompanyFiles } from './shared';
import { deleteCompanyFile } from './DeleteCompanyDialog';
import './company.css';

export interface NoCompanyOpenProps {
  /** Open this company (the shell handles login and closing the current one). */
  onOpened(companyId: string): void;
}

const HIDDEN_KEY = 'sx.hiddenCompanies';

function readHidden(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
function writeHidden(ids: string[]) {
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify(ids));
  } catch {
    /* ignore */
  }
}

/** The sample company file (created by POST /api/companies/sample). */
export function isSampleFile(c: CompanyFile): boolean {
  return c.id.startsWith('sample-') || /\(sample\)\s*$/i.test(c.name);
}

/** Folder part of a file path. */
function folderOf(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i > 0 ? path.slice(0, i) : path;
}

export default function NoCompanyOpen({ onOpened }: NoCompanyOpenProps) {
  const files = useCompanyFiles();
  const [hidden, setHidden] = useState<string[]>(readHidden);
  const [showHidden, setShowHidden] = useState(false);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const [sampleBusy, setSampleBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const last = getLastCompanyId();

  const all = files.data ?? [];
  const recentOrder = useMemo(() => getRecentCompanies().map((r) => r.id), [files.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    return all
      .filter((c) => showHidden || !hidden.includes(c.id))
      .filter((c) => !term || c.name.toLowerCase().includes(term) || c.fileName.toLowerCase().includes(term))
      .sort((a, b) => {
        const ra = recentOrder.indexOf(a.id);
        const rb = recentOrder.indexOf(b.id);
        if (ra !== rb) return (ra < 0 ? 999 : ra) - (rb < 0 ? 999 : rb);
        return b.modified.localeCompare(a.modified);
      });
  }, [all, hidden, showHidden, q, recentOrder]);
  const hiddenCount = all.filter((c) => hidden.includes(c.id)).length;
  const sample = all.find(isSampleFile);

  useEffect(() => {
    if (!rows.length) setSel(null);
    else if (!sel || !rows.some((r) => r.id === sel)) setSel(rows[0].id);
  }, [rows, sel]);

  const open = (id: string) => onOpened(id);

  const removeFromList = (c: CompanyFile) => {
    const next = [...hidden.filter((h) => h !== c.id), c.id];
    setHidden(next);
    writeHidden(next);
    forgetRecentCompany(c.id);
    toast(`"${c.name}" was removed from the list. The company file was not deleted.`, {
      kind: 'info',
      action: {
        label: 'Undo',
        onClick: () => {
          const back = readHidden().filter((h) => h !== c.id);
          setHidden(back);
          writeHidden(back);
        },
      },
    });
  };

  const unhideAll = () => {
    setHidden([]);
    writeHidden([]);
    setShowHidden(false);
  };

  const openSample = async (recreate: boolean) => {
    if (sample && !recreate) {
      open(sample.id);
      return;
    }
    if (recreate && !(await confirmBox('Start the sample company over? Any changes you made in it will be lost.', 'Sample Company'))) return;
    setSampleBusy(true);
    try {
      const cf = await api.global.post<CompanyFile>('/companies/sample', {}, { noPrompt: true });
      void queryClient.invalidateQueries({ queryKey: ['global', 'companies'] });
      const back = readHidden().filter((h) => h !== cf.id);
      writeHidden(back);
      setHidden(back);
      open(cf.id);
    } catch (e) {
      toast((e as Error).message || 'The sample company could not be created.', { kind: 'error', duration: 8000 });
    } finally {
      setSampleBusy(false);
    }
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
      open(sel);
    } else if (e.key === 'Delete' && sel) {
      const c = rows.find((r) => r.id === sel);
      if (c) removeFromList(c);
    }
  };

  return (
    <div className="cx-welcome">
      <div className="cx-welcome-head">
        <div className="cx-logo" aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <path d="M5 7h14M5 12h10M5 17h7" />
          </svg>
        </div>
        <div>
          <h1 className="cx-welcome-title">Welcome to SerieX Books</h1>
          <div className="cx-muted">Open a company to pick up where you left off, or start something new.</div>
        </div>
      </div>

      <div className="cx-welcome-actions">
        <button type="button" className="cx-action-card" onClick={() => openWindow('newCompany')}>
          <span className="cx-action-icon" style={{ background: '#e0ecff', color: '#1d4ed8' }}>
            <Plus size={20} />
          </span>
          <span className="cx-action-text">
            <b>Create a new company</b>
            <span>A few quick questions and you are ready to go.</span>
          </span>
        </button>
        <button type="button" className="cx-action-card" onClick={() => openWindow('openCompany', { mode: 'open' })}>
          <span className="cx-action-icon" style={{ background: '#e7f6ee', color: '#15803d' }}>
            <FolderOpen size={20} />
          </span>
          <span className="cx-action-text">
            <b>Open or restore a company</b>
            <span>Open a company file or restore a backup.</span>
          </span>
        </button>
        <button type="button" className="cx-action-card" onClick={() => void openSample(false)} disabled={sampleBusy}>
          <span className="cx-action-icon" style={{ background: '#fdf0e1', color: '#c2410c' }}>
            {sampleBusy ? <Spinner size={18} /> : <Sparkles size={20} />}
          </span>
          <span className="cx-action-text">
            <b>{sample ? 'Open the sample company' : 'Explore the sample company'}</b>
            <span>{sampleBusy ? 'Creating the sample company...' : 'A landscaping business with 18 months of activity to try things safely.'}</span>
          </span>
        </button>
        <button type="button" className="cx-action-card" onClick={() => openWindow('qbImport', { target: 'new' })}>
          <span className="cx-action-icon" style={{ background: '#ede9fe', color: '#6d28d9' }}>
            <FolderInput size={20} />
          </span>
          <span className="cx-action-text">
            <b>Import from QuickBooks®</b>
            <span>Moving from QuickBooks® Desktop? Bring your accounts, customers, vendors and history.</span>
          </span>
        </button>
      </div>

      <div className="cx-welcome-listhead">
        <span className="cx-section-title" style={{ margin: 0 }}>
          Your companies
        </span>
        <span className="cx-spacer" />
        {sample && (
          <button type="button" className="sx-linkbtn cx-small" onClick={() => void openSample(true)} disabled={sampleBusy}>
            Start the sample company over
          </button>
        )}
        <SearchBox value={q} onChange={setQ} placeholder="Find a company" width={200} />
      </div>
      <div className="cx-filelist" ref={listRef} tabIndex={0} role="listbox" aria-label="Company files" onKeyDown={onListKey}>
        {files.isLoading ? (
          <div style={{ padding: 30, display: 'grid', placeItems: 'center' }}>
            <Spinner label="Loading company files..." />
          </div>
        ) : files.error ? (
          <EmptyState
            compact
            title="The server could not be reached"
            message={(files.error as Error).message}
            action={{ label: 'Try again', onClick: () => void files.refetch() }}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            compact
            icon={Building2}
            title={all.length ? 'No company matches' : 'No company files yet'}
            message={
              all.length
                ? 'Try another name, or show the companies removed from this list.'
                : 'Create your first company, restore a backup, or explore the sample company.'
            }
          />
        ) : (
          <table className="cx-filetable">
            <thead>
              <tr>
                <th>Company</th>
                <th>Location</th>
                <th>Last modified</th>
                <th className="cx-right">Size</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr
                  key={c.id}
                  data-id={c.id}
                  role="option"
                  aria-selected={c.id === sel}
                  className={(c.id === sel ? 'cx-sel ' : '') + (hidden.includes(c.id) ? 'cx-dim' : '')}
                  onMouseDown={() => setSel(c.id)}
                  onDoubleClick={() => open(c.id)}
                >
                  <td>
                    <div className="cx-file-name">
                      <Building2 size={15} className="cx-muted" />
                      <span>{c.name}</span>
                      {c.id === last && <Badge tone="accent">Last opened</Badge>}
                      {isSampleFile(c) && <Badge tone="warning">Sample</Badge>}
                    </div>
                    <div className="cx-muted cx-small">{c.fileName}</div>
                  </td>
                  <td className="cx-muted cx-small cx-ellipsis" title={c.path}>
                    {folderOf(c.path)}
                  </td>
                  <td title={fmtDateTime(c.modified)}>{timeAgo(c.modified)}</td>
                  <td className="cx-right cx-num">{fmtBytes(c.size)}</td>
                  <td className="cx-right" style={{ whiteSpace: 'nowrap' }}>
                    <Button size="sm" variant={c.id === sel ? 'primary' : 'secondary'} label="Open" onClick={() => open(c.id)} />
                    <button
                      type="button"
                      className="sx-iconbtn cx-rowx"
                      title="Remove from list (the file is not deleted)"
                      aria-label={`Remove ${c.name} from the list`}
                      onClick={() => removeFromList(c)}
                    >
                      <X size={14} />
                    </button>
                    <button
                      type="button"
                      className="sx-iconbtn cx-rowx"
                      title="Delete the company file from this computer"
                      aria-label={`Delete the company file of ${c.name}`}
                      onClick={() => void deleteCompanyFile(c)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="cx-welcome-foot">
        {hiddenCount > 0 &&
          (showHidden ? (
            <button type="button" className="sx-linkbtn cx-small" onClick={unhideAll}>
              Put the {hiddenCount} removed compan{hiddenCount === 1 ? 'y' : 'ies'} back on the list
            </button>
          ) : (
            <button type="button" className="sx-linkbtn cx-small" onClick={() => setShowHidden(true)}>
              Show {hiddenCount} compan{hiddenCount === 1 ? 'y' : 'ies'} removed from the list
            </button>
          ))}
        <span className="cx-spacer" />
        <button type="button" className="sx-linkbtn cx-small" onClick={() => openWindow('openCompany', { mode: 'restore' })}>
          <ArchiveRestore size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />
          Restore a backup file
        </button>
      </div>
    </div>
  );
}

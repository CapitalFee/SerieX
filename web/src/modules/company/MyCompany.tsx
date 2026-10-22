// Company > My Company: the company's details with an edit link, the company file (location, size,
// backups), users and closing date, the features that are turned on, and product information.
import { useState } from 'react';
import { Building2, HardDrive, Lock, Pencil, Settings2, ShieldCheck, Sparkles } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { useCompanyInfo, usePrefValues } from '@/api/hooks';
import type { IndustryTemplate } from '@/api/types';
import { Badge, Button, Card, Spinner, msgBox, toast } from '@/components';
import { openWindow } from '@/windows/windowStore';
import { fmtDate } from '@/util/format';
import {
  ENTITY_TYPES,
  MONTHS,
  PRODUCT_NAME,
  fmtBytes,
  backUpNow,
  backupKindLabel,
  fmtDateTime,
  timeAgo,
  useBackupStatus,
  useClosingDate,
  useCompanyFiles,
  useProductVersion,
  useUsers,
} from './shared';
import './company.css';

export interface MyCompanyProps {}

export default function MyCompany(_props: MyCompanyProps) {
  const info = useCompanyInfo();
  const version = useProductVersion();
  const companyId = info.data?.companyId ?? null;
  const prefs = usePrefValues();
  const files = useCompanyFiles();
  const users = useUsers();
  const closing = useClosingDate();
  const templates = useQuery({
    queryKey: ['global', 'templates'],
    queryFn: () => api.global.get<IndustryTemplate[]>('/companies/templates', { noPrompt: true }),
    staleTime: Infinity,
  });
  const backups = useBackupStatus();
  const [backingUp, setBackingUp] = useState(false);
  const backup = async () => {
    setBackingUp(true);
    try {
      const e = await backUpNow();
      toast(`Backup saved in the backup folder (${e.file}).`);
    } catch (e) {
      await msgBox({ title: 'Back Up Now', icon: 'error', message: (e as Error).message });
    } finally {
      setBackingUp(false);
    }
  };

  const c = info.data;
  const file = files.data?.find((f) => f.id === companyId);
  if (!c) {
    return (
      <div className="cx-page" style={{ display: 'grid', placeItems: 'center' }}>
        {info.error ? <span className="cx-muted">{(info.error as Error).message}</span> : <Spinner label="Loading..." />}
      </div>
    );
  }
  const industry = templates.data?.find((t) => t.key === c.industry)?.label ?? c.industry;
  const entity = ENTITY_TYPES.find((e) => e.value === c.entityType)?.label ?? c.entityType;
  const cityLine = [c.city, [c.state, c.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const activeUsers = (users.data ?? []).filter((u) => u.active);
  const features: [string, boolean][] = [
    ['Estimates', prefs.estimatesEnabled],
    ['Inventory', prefs.inventoryEnabled],
    ['Purchase orders', prefs.purchaseOrdersEnabled],
    ['Sales tax', prefs.salesTaxEnabled],
    ['Class tracking', prefs.useClassTracking],
    ['Account numbers', prefs.useAccountNumbers],
    ['Undeposited Funds', prefs.useUndepositedFunds],
  ];

  return (
    <div className="cx-page">
      <div className="cx-page-head">
        <div className="cx-mc-avatar" aria-hidden="true">
          {c.name
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 2)
            .map((w) => w[0]?.toUpperCase())
            .join('')}
        </div>
        <div style={{ minWidth: 0 }}>
          <h1 className="cx-page-title">{c.name}</h1>
          <div className="cx-muted">
            {industry}
            {entity ? ` · ${entity}` : ''}
          </div>
        </div>
        <span className="cx-spacer" />
        <Button icon={Pencil} label="Edit company info" onClick={() => openWindow('companyInfo')} />
      </div>

      <div className="cx-mc-grid">
        <Card
          title={
            <span className="cx-row">
              <Building2 size={16} /> Company information
            </span>
          }
          actions={
            <button
              type="button"
              className="sx-iconbtn"
              title="Edit company information"
              aria-label="Edit company information"
              onClick={() => openWindow('companyInfo')}
            >
              <Pencil size={14} />
            </button>
          }
        >
          <dl className="cx-kv">
            <dt>Legal name</dt>
            <dd>{c.legalName || c.name}</dd>
            <dt>Address</dt>
            <dd>
              {[c.address1, c.address2, cityLine, c.country].filter(Boolean).map((l, i) => (
                <div key={i}>{l}</div>
              ))}
              {!c.address1 && !c.address2 && !cityLine && !c.country && <span className="cx-muted">Not set</span>}
            </dd>
            <dt>Phone</dt>
            <dd>{c.phone || <span className="cx-muted">Not set</span>}</dd>
            <dt>Email</dt>
            <dd>{c.email || <span className="cx-muted">Not set</span>}</dd>
            <dt>Website</dt>
            <dd>{c.website || <span className="cx-muted">Not set</span>}</dd>
            <dt>Tax ID (EIN)</dt>
            <dd>{c.taxId || <span className="cx-muted">Not set</span>}</dd>
            <dt>Fiscal year starts</dt>
            <dd>{MONTHS[(c.fiscalYearStartMonth || 1) - 1]}</dd>
            <dt>Income tax year starts</dt>
            <dd>{MONTHS[(c.taxYearStartMonth || 1) - 1]}</dd>
          </dl>
        </Card>

        <div className="cx-stack">
          <Card
            title={
              <span className="cx-row">
                <HardDrive size={16} /> Company file
              </span>
            }
          >
            <dl className="cx-kv cx-kv-narrow">
              <dt>File</dt>
              <dd>{file?.fileName ?? `${companyId}.sxb`}</dd>
              <dt>Location</dt>
              <dd className="cx-small" title={file?.path}>
                {file?.path ?? '…'}
              </dd>
              <dt>Size</dt>
              <dd>{file ? fmtBytes(file.size) : '…'}</dd>
              <dt>Last modified</dt>
              <dd>{file ? fmtDateTime(file.modified) : '…'}</dd>
              <dt>Created</dt>
              <dd>{c.createdAt ? fmtDateTime(c.createdAt) : ''}</dd>
              <dt>Last backup</dt>
              <dd>
                {!backups.data ? (
                  '…'
                ) : backups.data.last ? (
                  <span title={fmtDateTime(backups.data.last.time)}>
                    {timeAgo(backups.data.last.time)}
                    {backups.data.last.kind !== 'auto' && ` (${backupKindLabel(backups.data.last.kind).toLowerCase()})`}
                  </span>
                ) : (
                  <span style={{ color: 'var(--sx-warning)' }}>No backup made yet</span>
                )}
                {backups.data?.error && (
                  <div className="cx-small" style={{ color: 'var(--sx-warning)' }}>
                    The last automatic backup failed: {backups.data.error}
                  </div>
                )}
              </dd>
              <dt>Automatic backups</dt>
              <dd>
                {!backups.data ? (
                  '…'
                ) : backups.data.enabled ? (
                  <>
                    On, the last {backups.data.keep} are kept
                    <div className="cx-small cx-muted cx-ellipsis" title={backups.data.folderInUse}>
                      {backups.data.folderInUse}
                    </div>
                  </>
                ) : (
                  <span style={{ color: 'var(--sx-warning)' }}>Off</span>
                )}
              </dd>
            </dl>
            <div className="cx-row" style={{ marginTop: 12, flexWrap: 'wrap' }}>
              <Button size="sm" variant="primary" label="Back up now" busy={backingUp} onClick={() => void backup()} />
              <Button size="sm" label="Backup settings" onClick={() => openWindow('backupSettings')} />
              <Button size="sm" label="Save a copy" onClick={() => openWindow('backupCompany', { mode: 'copy' })} />
              <Button size="sm" label="Check company file" onClick={() => openWindow('verifyData')} />
            </div>
          </Card>
          <Card
            title={
              <span className="cx-row">
                <ShieldCheck size={16} /> Security
              </span>
            }
          >
            <dl className="cx-kv cx-kv-narrow">
              <dt>Users</dt>
              <dd>
                {users.isLoading ? '…' : activeUsers.map((u) => u.name).join(', ')}
                {!users.isLoading && !activeUsers.some((u) => u.hasPassword) && (
                  <div className="cx-small" style={{ color: 'var(--sx-warning)' }}>
                    No passwords: the file opens without a login.
                  </div>
                )}
              </dd>
              <dt>Closing date</dt>
              <dd>
                {closing.data?.closingDate ? (
                  <>
                    <Lock size={12} style={{ verticalAlign: '-1px' }} /> {fmtDate(closing.data.closingDate)}
                    {closing.data.hasPassword ? ' (password)' : ''}
                  </>
                ) : (
                  <span className="cx-muted">Not set</span>
                )}
              </dd>
            </dl>
            <div className="cx-row" style={{ marginTop: 12 }}>
              <Button size="sm" label="Set up users" onClick={() => openWindow('users')} />
              <Button size="sm" label="Set closing date" onClick={() => openWindow('closingDate')} />
            </div>
          </Card>
        </div>

        <Card
          title={
            <span className="cx-row">
              <Settings2 size={16} /> Features
            </span>
          }
          actions={<Button size="sm" variant="ghost" label="Preferences" onClick={() => openWindow('preferences')} />}
        >
          <div className="cx-featurelist">
            {features.map(([label, on]) => (
              <Badge key={label} tone={on ? 'success' : 'muted'} dot>
                {label}: {on ? 'on' : 'off'}
              </Badge>
            ))}
          </div>
        </Card>
        <Card
          title={
            <span className="cx-row">
              <Sparkles size={16} /> Product
            </span>
          }
        >
          <dl className="cx-kv cx-kv-narrow">
            <dt>Product</dt>
            <dd>{PRODUCT_NAME}</dd>
            <dt>Version</dt>
            <dd>{version}</dd>
            <dt>Help</dt>
            <dd>
              <button type="button" className="sx-linkbtn" onClick={() => openWindow('about', { help: true })}>
                Getting started and keyboard shortcuts
              </button>
            </dd>
          </dl>
        </Card>
      </div>
    </div>
  );
}

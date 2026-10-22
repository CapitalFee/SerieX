// Left navigation: "+ New" button, grouped navigation with plain
// labels (Home; Customers & Sales; Vendors & Expenses; Banking; Reports; Lists;
// Company) and collapsible groups, collapse-to-icons toggle (flyouts show the
// entries), and the bottom tabs Balances / Open Windows.
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { ChevronDown, CircleDollarSign, AppWindow, X } from 'lucide-react';
import { useSession } from '@/state/session';
import { useView, type IconBarTab } from '@/state/view';
import { useWindowStore, openWindow, focusWindow, closeWindow, type WinState } from '@/windows/windowStore';
import { useBalanceAccounts, useMemorizedReports } from './data';
import { buildNav, entryMatches, type FavoriteReport, type NavGroup } from './navItems';
import { getFavorites, useReportPrefs } from '@/modules/reports/reportStore';
import { useReportsCatalog } from '@/api/hooks';
import { reportTitle } from '@/state/catalog';
import { NewButton } from './NewMenu';
import { Popover } from './Popover';
import { shellMoney } from './format';
import { kindIcon } from './kindIcons';

/** Active window (kind + props only, so moving windows does not re-render the navigation). */
function useActiveWindow(): WinState | null {
  const a = useWindowStore(
    useShallow((s) => {
      const w = s.windows.find((v) => v.id === s.activeId);
      return { id: w?.id ?? '', kind: w?.kind ?? null, props: w?.props ?? null };
    }),
  );
  return a.kind ? ({ id: a.id, kind: a.kind, props: a.props ?? {} } as WinState) : null;
}

function groupHasActive(g: NavGroup, w: WinState | null): boolean {
  if (!w) return false;
  if (g.kinds?.includes(w.kind)) return true;
  return g.entries.some((e) => e.kinds.includes(w.kind));
}

export function IconBar() {
  const collapsed = useView((s) => s.navCollapsed);
  const tab = useView((s) => s.iconBarTab);
  const setTab = useView((s) => s.setIconBarTab);
  const hasCompany = useSession((s) => !!s.companyId);
  const windowCount = useWindowStore((s) => s.windows.filter((w) => !w.modal).length);
  const [panelFlyout, setPanelFlyout] = useState<{ tab: IconBarTab; anchor: HTMLElement } | null>(null);

  const panelTab = tab === 'balances' || tab === 'windows' ? tab : null;
  const showPanel = !collapsed && panelTab;

  const toggleTab = (t: IconBarTab, el: HTMLElement) => {
    if (collapsed) {
      setPanelFlyout((f) => (f && f.tab === t ? null : { tab: t, anchor: el }));
      return;
    }
    setTab(tab === t ? 'shortcuts' : t);
  };

  return (
    <aside className={`sx-nav sx-dimmable${collapsed ? ' sx-nav-collapsed' : ''}`} aria-label="Navigation">
      <div className="sx-nav-top">
        <NewButton variant={collapsed ? 'nav-collapsed' : 'nav'} />
      </div>
      {showPanel ? (
        <>
          <div className="sx-nav-panelhead">
            <span>{panelTab === 'balances' ? 'Account balances' : 'Open windows'}</span>
            <button type="button" className="sx-nav-iconbtn" title="Back to navigation" onClick={() => setTab('shortcuts')}>
              <X size={15} />
            </button>
          </div>
          <div className="sx-nav-scroll">{panelTab === 'balances' ? <BalancesPanel dark /> : <WindowsPanel dark />}</div>
        </>
      ) : (
        <div className="sx-nav-scroll">
          <NavGroups collapsed={collapsed} disabled={!hasCompany} />
        </div>
      )}
      <div className="sx-nav-bottom">
        <button
          type="button"
          className={`sx-nav-tab${(collapsed ? panelFlyout?.tab === 'balances' : panelTab === 'balances') ? ' sx-selected' : ''}`}
          title="Balances"
          data-ib-tab="balances"
          onClick={(e) => toggleTab('balances', e.currentTarget)}
        >
          <CircleDollarSign size={collapsed ? 19 : 17} strokeWidth={1.9} />
          {!collapsed && <span>Balances</span>}
        </button>
        <button
          type="button"
          className={`sx-nav-tab${(collapsed ? panelFlyout?.tab === 'windows' : panelTab === 'windows') ? ' sx-selected' : ''}`}
          title="Open Windows"
          data-ib-tab="windows"
          onClick={(e) => toggleTab('windows', e.currentTarget)}
        >
          <AppWindow size={collapsed ? 19 : 17} strokeWidth={1.9} />
          {!collapsed && <span>Open Windows</span>}
          {windowCount > 0 && <span className="sx-nav-count">{windowCount}</span>}
        </button>
      </div>
      {collapsed && panelFlyout && (
        <Popover anchor={() => panelFlyout.anchor} placement="right-start" gap={8} onClose={() => setPanelFlyout(null)} className="sx-flyout">
          <div className="sx-pop-title">{panelFlyout.tab === 'balances' ? 'Account balances' : 'Open windows'}</div>
          <div className="sx-pop-list" style={{ padding: 0, minWidth: 260 }}>
            {panelFlyout.tab === 'balances' ? <BalancesPanel onPick={() => setPanelFlyout(null)} /> : <WindowsPanel onPick={() => setPanelFlyout(null)} />}
          </div>
        </Popover>
      )}
    </aside>
  );
}

/** The grouped navigation (expanded: collapsible groups; collapsed: icons with flyouts). */
function NavGroups({ collapsed, disabled }: { collapsed: boolean; disabled: boolean }) {
  const prefs = useSession((s) => s.prefs);
  const memorized = useMemorizedReports();
  const closed = useView((s) => s.navClosed);
  const setGroupOpen = useView((s) => s.setNavGroupOpen);
  const active = useActiveWindow();
  // starred reports (All Reports ★) are listed under Reports
  const companyId = useSession((s) => s.companyId);
  const { favorites: favKeys } = useReportPrefs();
  const catalog = useReportsCatalog();
  const favorites = useMemo<FavoriteReport[]>(
    () => (companyId ? getFavorites() : []).map((key) => ({ key, title: reportTitle(key) || key })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [favKeys, companyId, catalog.data],
  );
  const groups = useMemo(() => buildNav(prefs, Array.isArray(memorized.data) ? memorized.data : [], favorites), [prefs, memorized.data, favorites]);
  const [fly, setFly] = useState<{ id: string; anchor: HTMLElement; pinned: boolean } | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const schedule = (fn: () => void, ms: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(fn, ms);
  };

  if (collapsed) {
    const flyGroup = fly ? groups.find((g) => g.id === fly.id) : null;
    return (
      <>
        {groups.map((g) => {
          const selected = g.open ? groupHasActive(g, active) : false;
          const has = !g.open && groupHasActive(g, active);
          return (
            <div key={g.id} className="sx-nav-group">
              <button
                type="button"
                className={`sx-nav-head${selected ? ' sx-selected' : ''}${has ? ' sx-has-current' : ''}`}
                title={g.label}
                disabled={disabled}
                data-nav-group={g.id}
                aria-haspopup={g.open ? undefined : 'true'}
                onClick={(e) => {
                  if (g.open) {
                    setFly(null);
                    g.open();
                    return;
                  }
                  const el = e.currentTarget;
                  setFly((f) => (f && f.id === g.id && f.pinned ? null : { id: g.id, anchor: el, pinned: true }));
                }}
                onMouseEnter={(e) => {
                  if (g.open || disabled) return;
                  const el = e.currentTarget;
                  schedule(() => setFly((f) => (f && f.pinned && f.id === g.id ? f : { id: g.id, anchor: el, pinned: false })), fly ? 60 : 160);
                }}
                onMouseLeave={() => schedule(() => setFly((f) => (f && !f.pinned ? null : f)), 220)}
              >
                <g.icon size={19} strokeWidth={1.9} />
              </button>
            </div>
          );
        })}
        {fly && flyGroup && (
          <Popover
            key={fly.id}
            anchor={() => fly.anchor}
            placement="right-start"
            gap={6}
            className="sx-flyout"
            onClose={() => setFly(null)}
            onMouseEnter={() => window.clearTimeout(timer.current)}
            onMouseLeave={() => schedule(() => setFly((f) => (f && !f.pinned ? null : f)), 220)}
          >
            <div className="sx-pop-title">{flyGroup.label}</div>
            {flyGroup.entries.map((e) => (
              <button
                key={e.id}
                type="button"
                className={`sx-pop-item${entryMatches(e, active) ? ' sx-checked' : ''}`}
                data-nav-entry={e.id}
                onClick={() => {
                  setFly(null);
                  e.open();
                }}
              >
                <span className="sx-pop-item-text">{e.label}</span>
              </button>
            ))}
          </Popover>
        )}
      </>
    );
  }

  return (
    <>
      {groups.map((g) => {
        if (g.open) {
          const selected = groupHasActive(g, active);
          return (
            <div key={g.id} className="sx-nav-group">
              <button type="button" className={`sx-nav-head${selected ? ' sx-selected' : ''}`} disabled={disabled} data-nav-group={g.id} onClick={g.open}>
                <g.icon size={17} strokeWidth={1.9} />
                <span className="sx-nav-head-label">{g.label}</span>
              </button>
            </div>
          );
        }
        const isOpen = !closed[g.id];
        const has = groupHasActive(g, active);
        return (
          <div key={g.id} className={`sx-nav-group${isOpen ? '' : ' sx-closed'}`}>
            <button
              type="button"
              className={`sx-nav-head${has ? ' sx-has-current' : ''}${!isOpen && g.entries.some((e) => entryMatches(e, active)) ? ' sx-selected' : ''}`}
              aria-expanded={isOpen}
              disabled={disabled}
              data-nav-group={g.id}
              onClick={() => setGroupOpen(g.id, !isOpen)}
            >
              <g.icon size={17} strokeWidth={1.9} />
              <span className="sx-nav-head-label">{g.label}</span>
              <ChevronDown size={14} className="sx-nav-chev" />
            </button>
            {isOpen && (
              <div className="sx-nav-entries" role="group" aria-label={g.label}>
                {g.entries.map((e) => (
                  <button
                    key={e.id}
                    type="button"
                    className={`sx-nav-entry${entryMatches(e, active) ? ' sx-selected' : ''}`}
                    disabled={disabled}
                    data-nav-entry={e.id}
                    title={e.label}
                    onClick={e.open}
                  >
                    <span>{e.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

/** Rows of a navigation panel: dark (in the navigation) or light (in a flyout). */
function PanelRow({
  dark,
  selected,
  title,
  onClick,
  children,
  dataAttr,
}: {
  dark?: boolean;
  selected?: boolean;
  title?: string;
  onClick(): void;
  children: ReactNode;
  dataAttr?: Record<string, string>;
}) {
  return (
    <div
      className={dark ? `sx-nav-row${selected ? ' sx-selected' : ''}` : `sx-pop-item${selected ? ' sx-checked' : ''}`}
      title={title}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      {...dataAttr}
    >
      {children}
    </div>
  );
}

/** Bank, credit card, A/R and A/P balances (click opens the register). */
function BalancesPanel({ dark, onPick }: { dark?: boolean; onPick?: () => void }) {
  const hasCompany = useSession((s) => !!s.companyId);
  const q = useBalanceAccounts();
  const empty = (msg: string) => (dark ? <div className="sx-nav-empty">{msg}</div> : <div className="sx-gsearch-msg">{msg}</div>);
  if (!hasCompany) return empty('No company file is open.');
  if (q.isLoading) return empty('Loading...');
  if (q.isError) return empty('Balances are not available.');
  const rows = (q.data ?? []).filter((a) => a.active !== false);
  if (!rows.length) return empty('No bank, credit card, A/R or A/P accounts.');
  return (
    <div>
      {rows.map((a) => (
        <PanelRow
          key={a.id}
          dark={dark}
          title={`${a.fullName || a.name} (${a.type}) - open register`}
          onClick={() => {
            onPick?.();
            openWindow('register', { accountId: a.id }, { title: a.fullName || a.name });
          }}
        >
          <span className={dark ? 'sx-nav-row-text' : 'sx-pop-item-text'} style={{ paddingLeft: (a.level ?? 0) * 10 }}>
            {a.name}
          </span>
          <span className={dark ? `sx-nav-row-amt${a.balance < 0 ? ' sx-neg' : ''}` : 'sx-pop-item-note'}>{shellMoney(a.balance)}</span>
        </PanelRow>
      ))}
    </div>
  );
}

/** Open windows, in tab order (click focuses, x closes). */
function WindowsPanel({ dark, onPick }: { dark?: boolean; onPick?: () => void }) {
  const rows = useWindowStore(useShallow((s) => s.windows.map((w) => `${w.id}\u0001${w.title}\u0001${w.minimized ? 1 : 0}\u0001${w.dirty ? 1 : 0}\u0001${w.kind}`)));
  const activeId = useWindowStore((s) => s.activeId);
  if (!rows.length) return dark ? <div className="sx-nav-empty">No windows are open.</div> : <div className="sx-gsearch-msg">No windows are open.</div>;
  return (
    <div>
      {rows.map((r) => {
        const [id, title, min, dirty, kind] = r.split('\u0001');
        const Icon = kindIcon(kind as WinState['kind']);
        return (
          <PanelRow
            key={id}
            dark={dark}
            selected={id === activeId}
            title={title}
            dataAttr={{ 'data-open-window': id }}
            onClick={() => {
              onPick?.();
              focusWindow(id);
            }}
          >
            <Icon size={14} strokeWidth={1.9} style={{ flex: 'none', opacity: 0.8 }} />
            <span className={dark ? 'sx-nav-row-text' : 'sx-pop-item-text'}>{title}</span>
            {dirty === '1' && <span className="sx-nav-row-dot" title="Unsaved changes" />}
            {min === '1' && <span className={dark ? 'sx-nav-row-note' : 'sx-pop-item-note'}>min</span>}
            <button
              type="button"
              className={dark ? 'sx-nav-iconbtn' : 'sx-pop-close'}
              title="Close"
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                void closeWindow(id);
              }}
            >
              <X size={13} />
            </button>
          </PanelRow>
        );
      })}
    </div>
  );
}

// Application frame: dark top bar (app mark, company,
// global search, user menu) over the dark-slate left navigation; to its right the
// menu bar, the optional top icon bar, the workspace tab strip (Tabs workspace)
// and the work area. `children` is shown on the empty work area (No Company Open).
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { House, FileText, Users, ChartColumn, LayoutGrid } from 'lucide-react';
import { useSession, getRecentCompanies, onRecentCompaniesChange } from '@/state/session';
import { useView } from '@/state/view';
import { reportCatalog } from '@/state/catalog';
import { useWindowStore, minimizeWindow, restoreWindow, closeWindow, getTopModal, flashWindow, openWindow } from '@/windows/windowStore';
import { TopBar } from './TopBar';
import { MenuBar } from './MenuBar';
import { buildMenus } from './menus';
import { IconBar } from './IconBar';
import { TopIconBar } from './TopIconBar';
import { TabStrip } from './TabStrip';
import { Desktop } from './Desktop';
import { useGlobalShortcuts } from './shortcuts';
import { useMemorizedReports, useReportCatalog } from './data';
import { GlyphClose, GlyphMin, GlyphRestore } from './glyphs';

/** Parts of the frame that a modal dialog blocks (a click there flashes the dialog). */
const BLOCKED_AREAS = '.sx-appbar, .sx-nav, .sx-wtabs, .sx-topbar';

export function AppFrame({ children }: { children?: ReactNode }) {
  const iconBar = useView((s) => s.iconBar);
  const tabsMode = useView((s) => s.windowMode === 'one');
  const modalOpen = useWindowStore((s) => s.windows.some((w) => w.modal));
  const loginOpen = useSession((s) => !!s.login);
  const hasCompany = useSession((s) => !!s.companyId);
  const opening = useSession((s) => s.opening);
  const noDocs = useWindowStore((s) => !s.windows.some((w) => !w.modal));
  const menus = useMenus();
  useGlobalShortcuts();
  const blocked = modalOpen || loginOpen;

  return (
    <div
      className={`sx-frame${modalOpen ? ' sx-modal-open' : ''}`}
      onPointerDownCapture={(e) => {
        const top = getTopModal();
        if (!top) return;
        const t = e.target as Element | null;
        if (t && t.closest(BLOCKED_AREAS)) {
          e.preventDefault();
          e.stopPropagation();
          flashWindow(top.id);
        }
      }}
    >
      <TopBar />
      <div className="sx-main">
        {iconBar === 'left' && <IconBar />}
        <div className="sx-workcol">
          <MenuBar menus={menus} right={tabsMode ? null : <MdiControls />} disabled={blocked} />
          {iconBar === 'top' && <TopIconBar />}
          {tabsMode && hasCompany && <TabStrip />}
          <div className="sx-body">
            <Desktop>
              {children}
              {hasCompany && !opening && noDocs && <EmptyWorkspace />}
            </Desktop>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Builds the menus from the state they depend on (not rebuilt while dragging windows). */
function useMenus() {
  const companyId = useSession((s) => s.companyId);
  const prefs = useSession((s) => s.prefs);
  const iconBar = useView((s) => s.iconBar);
  const windowMode = useView((s) => s.windowMode);
  const iconBarTab = useView((s) => s.iconBarTab);
  const navCollapsed = useView((s) => s.navCollapsed);
  const activeId = useWindowStore((s) => s.activeId);
  // Only what the menus show of the windows (titles, dirty, minimized, tab order).
  const winKey = useWindowStore((s) => s.windows.map((w) => `${w.id}|${w.title}|${w.dirty ? 1 : 0}|${w.minimized ? 1 : 0}`).join('\n'));
  const [recentVer, setRecentVer] = useState(0);
  useEffect(() => onRecentCompaniesChange(() => setRecentVer((v) => v + 1)), []);
  const catalog = useReportCatalog();
  const memorized = useMemorizedReports();

  return useMemo(
    () =>
      buildMenus({
        hasCompany: !!companyId,
        prefs,
        recent: getRecentCompanies(),
        currentCompanyId: companyId,
        reports: Array.isArray(catalog.data) && catalog.data.length ? catalog.data : reportCatalog(),
        memorizedReports: companyId && Array.isArray(memorized.data) ? memorized.data : [],
        windows: useWindowStore.getState().windows,
        activeId,
        iconBar,
        windowMode,
        iconBarTab,
        navCollapsed,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [companyId, prefs, iconBar, windowMode, iconBarTab, navCollapsed, activeId, winKey, recentVer, catalog.data, memorized.data],
  );
}

/** Buttons of the maximized floating window, at the right end of the menu bar. */
function MdiControls() {
  const id = useWindowStore((s) => {
    let top: { id: string; z: number } | null = null;
    for (const w of s.windows) if (!w.modal && w.maximized && !w.minimized && (!top || w.z > top.z)) top = w;
    return top?.id ?? null;
  });
  if (!id) return null;
  return (
    // (a click keeps the keyboard focus where it is: the window buttons never take it)
    <div className="sx-mdi-controls" onMouseDown={(e) => e.preventDefault()}>
      <button type="button" className="sx-wbtn" title="Minimize" tabIndex={-1} onClick={() => minimizeWindow(id)}>
        <GlyphMin />
      </button>
      <button type="button" className="sx-wbtn" title="Restore Down" tabIndex={-1} onClick={() => restoreWindow(id)}>
        <GlyphRestore />
      </button>
      <button type="button" className="sx-wbtn sx-wbtn-close" title="Close" tabIndex={-1} onClick={() => void closeWindow(id)}>
        <GlyphClose />
      </button>
    </div>
  );
}

/** Shown when a company is open but no window is: explains where to start. */
function EmptyWorkspace() {
  return (
    <div className="sx-ws-empty" data-empty-workspace="">
      <div className="sx-ws-empty-card">
        <div className="sx-ws-empty-icon">
          <LayoutGrid size={24} strokeWidth={1.8} />
        </div>
        <h2>Nothing is open right now</h2>
        <p>
          Pick a place to start: the Home page, a center, or a report. Create anything with <b>+ New</b>, or press <kbd>Ctrl</kbd>+<kbd>K</kbd> to
          search for a customer, a transaction or a command.
        </p>
        <div className="sx-ws-empty-actions">
          <button type="button" className="sx-shell-btn sx-primary" onClick={() => openWindow('home')}>
            <House size={15} />
            Home
          </button>
          <button type="button" className="sx-shell-btn" onClick={() => openWindow('invoice')}>
            <FileText size={15} />
            Create invoice
          </button>
          <button type="button" className="sx-shell-btn" onClick={() => openWindow('customerCenter')}>
            <Users size={15} />
            Customers
          </button>
          <button type="button" className="sx-shell-btn" onClick={() => openWindow('reportCenter')}>
            <ChartColumn size={15} />
            All reports
          </button>
        </div>
      </div>
    </div>
  );
}

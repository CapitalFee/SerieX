// Top bar (same design as SerieX Books): app mark + "SerieX Payroll", company switcher, global
// search, help and the user menu (SerieX Books user name, Log out when the Books company has
// passwords, Close company). The browser tab title is kept by the session
// ("<Company> - SerieX Payroll").
import { useEffect, useRef, useState } from 'react';
import { Building2, ChevronDown, CircleHelp, FolderOpen, LogOut, DoorClosed, Settings, Info, Check, Menu, BookOpen, ShieldCheck } from 'lucide-react';
import { useSession, APP_NAME, getRecentCompanies, onRecentCompaniesChange, switchCompany, requestCloseCompany, logOut, setBrowserTitle } from '@/state/session';
import { useView } from '@/state/view';
import { openWindow } from '@/windows/windowStore';
import { AppIcon } from './glyphs';
import { GlobalSearch } from './GlobalSearch';
import { NewButton } from './NewMenu';
import { Popover } from './Popover';
import { initials } from './format';
import { openSerieXBooks } from './booksLink';
import { AppSwitcher } from './AppSwitcher';

export function TopBar() {
  const iconBar = useView((s) => s.iconBar);
  const collapsed = useView((s) => s.navCollapsed);
  const setCollapsed = useView((s) => s.setNavCollapsed);
  const hasCompany = useSession((s) => !!s.companyId);
  const name = useSession((s) => s.company?.name || s.companyId || '');

  useEffect(() => {
    setBrowserTitle(name || null);
  }, [name]);

  const navLeft = iconBar === 'left';
  const brandCls = !navLeft ? ' sx-auto' : collapsed ? ' sx-narrow' : '';
  return (
    <header className="sx-appbar sx-dimmable" aria-label="Application bar">
      <div className={`sx-appbar-brand${brandCls}`}>
        {navLeft && (
          <button
            type="button"
            className="sx-appbar-btn sx-appbar-icon"
            title={collapsed ? 'Expand the navigation' : 'Collapse the navigation to icons'}
            aria-label={collapsed ? 'Expand the navigation' : 'Collapse the navigation'}
            aria-pressed={collapsed}
            data-nav-collapse=""
            onClick={() => setCollapsed(!collapsed)}
          >
            <Menu size={19} strokeWidth={2} />
          </button>
        )}
        {!(navLeft && collapsed) && (
          <span className="sx-brand" title={APP_NAME}>
            <AppIcon size={26} />
            <span className="sx-brand-name">
              SerieX <span>Payroll</span>
            </span>
          </span>
        )}
      </div>
      <AppSwitcher />
      {!navLeft && hasCompany && <NewButton variant="appbar" />}
      <CompanySwitcher />
      <div className="sx-appbar-center">
        <GlobalSearch />
      </div>
      <div className="sx-appbar-right">
        <button type="button" className="sx-appbar-btn sx-appbar-icon" title="Help (F1)" onClick={() => openWindow('about', { help: true })}>
          <CircleHelp size={18} strokeWidth={1.9} />
        </button>
        {hasCompany && <UserMenu />}
      </div>
    </header>
  );
}

/** Company name button; its menu switches to a recent company, opens or sets up one. */
function CompanySwitcher() {
  const companyId = useSession((s) => s.companyId);
  const name = useSession((s) => s.company?.name || s.companyId || '');
  const [open, setOpen] = useState(false);
  const [, setVer] = useState(0);
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => onRecentCompaniesChange(() => setVer((v) => v + 1)), []);
  const recent = getRecentCompanies();
  const run = (fn: () => void) => {
    setOpen(false);
    window.setTimeout(fn, 0);
  };
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`sx-appbar-btn sx-appbar-company${open ? ' sx-on' : ''}`}
        title={companyId ? `${name} - switch company` : 'Open a company'}
        aria-haspopup="true"
        aria-expanded={open}
        data-company-switcher=""
        onClick={() => setOpen((o) => !o)}
      >
        <Building2 size={16} className="sx-dim" />
        <span className="sx-appbar-company-name">{companyId ? name : 'No company open'}</span>
        <ChevronDown size={14} className="sx-dim" />
      </button>
      {open && (
        <Popover anchor={() => btn.current} placement="below-start" onClose={() => setOpen(false)} role="menu" ariaLabel="Company">
          <div className="sx-pop-list" style={{ minWidth: 270 }}>
            {recent.length > 0 && <div className="sx-pop-title">Recent companies</div>}
            {recent.map((r) => (
              <button
                key={r.id}
                type="button"
                className={`sx-pop-item${r.id === companyId ? ' sx-checked' : ''}`}
                onClick={() => run(() => void switchCompany(r.id))}
              >
                {r.id === companyId ? <Check size={15} /> : <Building2 size={15} />}
                <span className="sx-pop-item-text">{r.name}</span>
              </button>
            ))}
            {recent.length > 0 && <div className="sx-pop-sep" />}
            <button type="button" className="sx-pop-item" onClick={() => run(() => void requestCloseCompany())}>
              <FolderOpen size={15} />
              <span className="sx-pop-item-text">Open or set up company...</span>
            </button>
            <button type="button" className="sx-pop-item" onClick={() => run(openSerieXBooks)}>
              <BookOpen size={15} />
              <span className="sx-pop-item-text">Open SerieX Books</span>
            </button>
            {companyId && (
              <>
                <div className="sx-pop-sep" />
                <button type="button" className="sx-pop-item" onClick={() => run(() => openWindow('companyPayroll'))}>
                  <Info size={15} />
                  <span className="sx-pop-item-text">Company payroll information...</span>
                </button>
                <button type="button" className="sx-pop-item" onClick={() => run(() => void requestCloseCompany())}>
                  <DoorClosed size={15} />
                  <span className="sx-pop-item-text">Close company</span>
                </button>
              </>
            )}
          </div>
        </Popover>
      )}
    </>
  );
}

/** User button: SerieX Books user name, preferences, payroll access, Log out (when logins are required), Close company. */
function UserMenu() {
  const user = useSession((s) => s.user || 'Admin');
  const isAdmin = useSession((s) => s.isAdmin);
  const company = useSession((s) => s.company?.name || s.companyId || '');
  const authRequired = useSession((s) => s.authRequired);
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const run = (fn: () => void) => {
    setOpen(false);
    window.setTimeout(fn, 0);
  };
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`sx-appbar-btn${open ? ' sx-on' : ''}`}
        title={`Signed in as ${user}`}
        aria-haspopup="true"
        aria-expanded={open}
        data-user-menu=""
        onClick={() => setOpen((o) => !o)}
      >
        <span className="sx-avatar">{initials(user)}</span>
        <span className="sx-appbar-user-name">{user}</span>
        <ChevronDown size={14} className="sx-dim" />
      </button>
      {open && (
        <Popover anchor={() => btn.current} placement="below-end" onClose={() => setOpen(false)} role="menu" ariaLabel="User">
          <div className="sx-pop-list" style={{ minWidth: 250 }}>
            <div className="sx-pop-header">
              <span className="sx-avatar sx-avatar-lg">{initials(user)}</span>
              <span className="sx-pop-header-text">
                <b>{user}</b>
                <span>
                  {company}
                  {isAdmin ? ' · Administrator' : ''}
                </span>
              </span>
            </div>
            <button type="button" className="sx-pop-item" onClick={() => run(() => openWindow('preferences'))}>
              <Settings size={15} />
              <span className="sx-pop-item-text">Preferences...</span>
            </button>
            {isAdmin && (
              <button type="button" className="sx-pop-item" onClick={() => run(() => openWindow('preferences', { section: 'access' }))}>
                <ShieldCheck size={15} />
                <span className="sx-pop-item-text">Payroll access...</span>
              </button>
            )}
            <div className="sx-pop-sep" />
            {authRequired && (
              <button type="button" className="sx-pop-item" onClick={() => run(() => void logOut())} data-logout="">
                <LogOut size={15} />
                <span className="sx-pop-item-text">Log out</span>
              </button>
            )}
            <button type="button" className="sx-pop-item" onClick={() => run(() => void requestCloseCompany())} data-close-company="">
              <DoorClosed size={15} />
              <span className="sx-pop-item-text">Close company</span>
            </button>
          </div>
        </Popover>
      )}
    </>
  );
}


// Top bar: app mark + "SerieX Books", app switcher (SerieX Payroll), company switcher, global search, help and
// the user menu (user name, Log out when users have passwords, Close company).
// Also keeps the browser tab title: "<Company> - SerieX Books".
import { useEffect, useRef, useState } from 'react';
import { Building2, ChevronDown, CircleHelp, FolderOpen, FilePlus2, LogOut, DoorClosed, Settings, UserCog, Info, Check, Menu } from 'lucide-react';
import { useSession, APP_NAME, getRecentCompanies, onRecentCompaniesChange, switchCompany, requestCloseCompany, logOut } from '@/state/session';
import { useView } from '@/state/view';
import { openWindow } from '@/windows/windowStore';
import { AppIcon } from './glyphs';
import { GlobalSearch } from './GlobalSearch';
import { NewButton } from './NewMenu';
import { AppSwitcher } from './AppSwitcher';
import { Popover } from './Popover';
import { initials } from './format';

export function TopBar() {
  const iconBar = useView((s) => s.iconBar);
  const collapsed = useView((s) => s.navCollapsed);
  const setCollapsed = useView((s) => s.setNavCollapsed);
  const hasCompany = useSession((s) => !!s.companyId);
  const name = useSession((s) => s.company?.name || s.companyId || '');

  const base = name ? `${name} - ${APP_NAME}` : APP_NAME;
  useEffect(() => {
    document.title = base;
  }, [base]);

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
              SerieX <span>Books</span>
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

/** Company name button; its menu switches to a recent company, opens or creates one. */
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
          <div className="sx-pop-list" style={{ minWidth: 260 }}>
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
            <button type="button" className="sx-pop-item" onClick={() => run(() => openWindow('openCompany', { mode: 'open' }))}>
              <FolderOpen size={15} />
              <span className="sx-pop-item-text">Open or restore company...</span>
            </button>
            <button type="button" className="sx-pop-item" onClick={() => run(() => openWindow('newCompany'))}>
              <FilePlus2 size={15} />
              <span className="sx-pop-item-text">New company...</span>
            </button>
            {companyId && (
              <>
                <div className="sx-pop-sep" />
                <button type="button" className="sx-pop-item" onClick={() => run(() => openWindow('companyInfo'))}>
                  <Info size={15} />
                  <span className="sx-pop-item-text">Company information...</span>
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

/** User button: name, preferences, users, Log out (when logins are required), Close company. */
function UserMenu() {
  const user = useSession((s) => s.user || 'Admin');
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
                <span>{company}</span>
              </span>
            </div>
            <button type="button" className="sx-pop-item" onClick={() => run(() => openWindow('preferences'))}>
              <Settings size={15} />
              <span className="sx-pop-item-text">Preferences...</span>
            </button>
            <button type="button" className="sx-pop-item" onClick={() => run(() => openWindow('users'))}>
              <UserCog size={15} />
              <span className="sx-pop-item-text">Users and passwords...</span>
            </button>
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

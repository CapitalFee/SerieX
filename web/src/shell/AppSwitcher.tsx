// App switcher: the "apps" button in the top bar that moves between SerieX Books
// and SerieX Payroll. Switching opens the other app in the same browser tab at
// <url>/?company=<company file id> so it opens the same company; open windows get
// their usual "save changes?" question first. SerieX Payroll has the same switcher.
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Banknote, Check, RefreshCw } from 'lucide-react';
import { api } from '@/api/client';
import { alertBox } from '@/components/dialogs';
import { useSession } from '@/state/session';
import { closeAllWindows } from '@/windows/windowStore';
import { AppIcon } from './glyphs';
import { Popover, arrowFocus } from './Popover';
import '@/styles/appswitcher.css';

/** GET /api/info */
export interface AppInfo {
  app: string;
  version: string;
  payrollUrl: string;
  payrollReachable: boolean;
}

const INFO_KEY = ['app-info'];

function fetchInfo(): Promise<AppInfo> {
  return api.global.get<AppInfo>('/info', { noPrompt: true });
}

/** Where SerieX Payroll runs and whether it answers (re-checked every minute and when the panel opens). */
export function useAppInfo() {
  return useQuery({ queryKey: INFO_KEY, queryFn: fetchInfo, staleTime: 30_000, refetchInterval: 60_000, retry: 0 });
}

/** The address that opens SerieX Payroll on the company that is open here ("" when not configured). */
function payrollTarget(base: string, companyId: string | null): string {
  if (!base) return '';
  const root = base.replace(/\/+$/, '');
  return companyId ? `${root}/?company=${encodeURIComponent(companyId)}` : `${root}/`;
}

/**
 * Switch to SerieX Payroll in this tab. Checks that it is running, asks open windows
 * to save their changes (Cancel keeps you here), then leaves.
 */
export async function switchToPayroll(): Promise<void> {
  let info: AppInfo;
  try {
    info = await fetchInfo();
  } catch {
    await alertBox('The SerieX Books server did not answer, so SerieX Payroll could not be opened. Try again in a moment.', 'Switch app');
    return;
  }
  if (!info.payrollUrl) {
    await alertBox('SerieX Payroll is not set up for this server.', 'Switch app');
    return;
  }
  if (!info.payrollReachable) {
    await alertBox(
      `SerieX Payroll is not running at ${info.payrollUrl}.\n\nStart the SerieX Payroll server, then choose it again.`,
      'Switch app',
    );
    return;
  }
  if (!(await closeAllWindows())) return;
  window.location.assign(payrollTarget(info.payrollUrl, useSession.getState().companyId));
}

/** Top bar button with the app list. Hidden when no SerieX Payroll address is configured. */
export function AppSwitcher() {
  const info = useAppInfo();
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);

  // Opening the panel puts the keyboard on its first entry so arrows, Enter and Escape work at once.
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => list.current?.querySelector<HTMLElement>('.sx-apps-item')?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  if (info.data && !info.data.payrollUrl) return null;
  const reachable = !!info.data?.payrollReachable;
  const checking = info.isFetching && !info.data;
  const payrollUrl = info.data?.payrollUrl ?? '';

  const toggle = () => {
    setOpen((o) => {
      if (!o) void info.refetch();
      return !o;
    });
  };

  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`sx-appbar-btn sx-appbar-icon sx-apps-btn${open ? ' sx-on' : ''}`}
        title="Switch app (SerieX Books / SerieX Payroll)"
        aria-label="Switch app"
        aria-haspopup="true"
        aria-expanded={open}
        data-app-switcher=""
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowDown') return;
          e.preventDefault();
          if (!open) toggle();
          else list.current?.querySelector<HTMLElement>('.sx-apps-item')?.focus();
        }}
      >
        <AppsGlyph />
      </button>
      {open && (
        <Popover anchor={() => btn.current} placement="below-start" onClose={() => setOpen(false)} role="menu" ariaLabel="Switch app">
          <div
            ref={list}
            className="sx-pop-list sx-apps-panel"
            onKeyDown={(e) => arrowFocus(e, list.current, '.sx-apps-item')}
          >
            <div className="sx-pop-title">Switch app</div>
            <button
              type="button"
              role="menuitem"
              className="sx-apps-item sx-apps-current"
              aria-current="true"
              data-app="books"
              onClick={() => {
                setOpen(false);
                btn.current?.focus();
              }}
            >
              <span className="sx-apps-tile sx-apps-books">
                <AppIcon size={22} />
              </span>
              <span className="sx-apps-text">
                <b>SerieX Books</b>
                <span>Invoices, bills, banking and reports</span>
              </span>
              <span className="sx-apps-state">
                <Check size={15} /> Current
              </span>
            </button>
            <button
              type="button"
              role="menuitem"
              className={`sx-apps-item${reachable ? '' : ' sx-apps-off'}`}
              aria-disabled={!reachable}
              title={reachable ? `Open SerieX Payroll (${payrollUrl})` : `SerieX Payroll is not running at ${payrollUrl}`}
              data-app="payroll"
              onClick={() => {
                if (!reachable) {
                  void info.refetch();
                  return;
                }
                setOpen(false);
                btn.current?.focus(); // so Cancel on a "save changes?" question returns here
                window.setTimeout(() => void switchToPayroll(), 0);
              }}
            >
              <span className="sx-apps-tile sx-apps-payroll">
                <Banknote size={20} strokeWidth={2} />
              </span>
              <span className="sx-apps-text">
                <b>SerieX Payroll</b>
                <span>
                  {checking
                    ? 'Checking...'
                    : reachable
                      ? 'Paychecks, payroll taxes and employees'
                      : `Not running at ${payrollUrl}`}
                </span>
              </span>
              {!reachable && !checking && (
                <span className="sx-apps-state sx-apps-retry" title="Check again">
                  <RefreshCw size={14} className={info.isFetching ? 'sx-apps-spin' : ''} /> Retry
                </span>
              )}
            </button>
            <div className="sx-apps-foot">
              SerieX Books{info.data?.version ? ` ${info.data.version}` : ''}
            </div>
          </div>
        </Popover>
      )}
    </>
  );
}

/** 3 x 3 dots "apps" icon. */
function AppsGlyph() {
  const dots = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) dots.push(<circle key={`${r}${c}`} cx={4 + c * 6} cy={4 + r * 6} r={1.9} />);
  return (
    <svg width={20} height={20} viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      {dots}
    </svg>
  );
}

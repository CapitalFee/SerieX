// App root: data provider, message boxes, toasts, startup flow (reopen the last
// company file, else the No Company Open screen; ?company= and ?open= in the address),
// login dialog and the application frame.
import { lazy, Suspense, useEffect, useState } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '@/api/hooks';
import { setAuthHandler } from '@/api/client';
import { DialogHost } from '@/components/dialogs';
import { ToastHost } from '@/components/toast';
import { AppFrame } from '@/shell/AppFrame';
import { useSession, getLastCompanyId, listCompanies, switchCompany, handleAuthRequired } from '@/state/session';
import { openWindow } from '@/windows/windowStore';

const NoCompanyOpen = lazy(() => import('@/modules/company/NoCompanyOpen'));
const LoginDialog = lazy(() => import('@/modules/company/LoginDialog'));

let bootPromise: Promise<void> | null = null;

/** Takes ?company=<id> off the address (set by SerieX Payroll's app switcher) and returns it. */
function takeCompanyParam(): string | null {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('company')) return null;
    const id = (url.searchParams.get('company') ?? '').trim();
    url.searchParams.delete('company');
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
    return id || null;
  } catch {
    return null;
  }
}

/** Windows the address may ask for with ?open= (the SerieX desktop app's Go > Connect an AI Assistant). */
const OPEN_PARAM_KINDS = ['aiAssistants'] as const;
type OpenParamKind = (typeof OPEN_PARAM_KINDS)[number];

/** Takes ?open=<window> off the address and returns it when it is one of OPEN_PARAM_KINDS (anything else is ignored). */
function takeOpenParam(): OpenParamKind | null {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('open')) return null;
    const v = (url.searchParams.get('open') ?? '').trim();
    url.searchParams.delete('open');
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
    return (OPEN_PARAM_KINDS as readonly string[]).includes(v) ? (v as OpenParamKind) : null;
  } catch {
    return null;
  }
}

/**
 * Open the company asked for in the address (?company=), else the one open last (once per page
 * load); then the window asked for with ?open=, once that company is open (none opened: nothing).
 */
function boot(): Promise<void> {
  if (!bootPromise) {
    bootPromise = (async () => {
      try {
        const wanted = takeCompanyParam();
        const openKind = takeOpenParam();
        const last = getLastCompanyId();
        if (!wanted && !last) return;
        const list = await listCompanies();
        const has = (id: string | null) => !!id && Array.isArray(list) && list.some((c) => c.id === id);
        // A company asked for in the address that does not exist: show the start screen rather
        // than opening a different company than the one the user asked for.
        const target = wanted ? (has(wanted) ? wanted : null) : has(last) ? last : null;
        if (!target) return;
        await useSession.getState().openCompany(target);
        const s = useSession.getState();
        if (openKind && s.companyId === target && s.company) openWindow(openKind);
      } catch {
        /* server unreachable: show the No Company Open screen */
      }
    })();
  }
  return bootPromise;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Root />
      <DialogHost />
      <ToastHost />
    </QueryClientProvider>
  );
}

function Root() {
  const companyId = useSession((s) => s.companyId);
  const opening = useSession((s) => s.opening);
  const login = useSession((s) => s.login);
  const [booted, setBooted] = useState(false);

  useEffect(() => {
    let alive = true;
    boot().finally(() => alive && setBooted(true));
    return () => {
      alive = false;
    };
  }, []);

  // A request refused because the session is gone (server restarted, session ended): log in
  // again and the API client re-sends it, so an open form's save goes through.
  useEffect(() => {
    setAuthHandler((message) => handleAuthRequired(message));
    return () => setAuthHandler(null);
  }, []);

  useEffect(() => {
    const onAuth = (e: Event) => {
      const msg = (e as CustomEvent<{ message?: string }>).detail?.message;
      void handleAuthRequired(msg);
    };
    window.addEventListener('sx-auth-required', onAuth);
    return () => window.removeEventListener('sx-auth-required', onAuth);
  }, []);

  const showNoCompany = booted && !companyId && !opening && !login;

  return (
    <>
      <AppFrame>
        {showNoCompany && (
          <div className="sx-nocompany-layer">
            <Suspense fallback={null}>
              <NoCompanyOpen onOpened={(id: string) => void switchCompany(id)} />
            </Suspense>
          </div>
        )}
        {(opening || !booted) && !login && <div className="sx-opening">Opening company file...</div>}
      </AppFrame>
      {login && (
        <div className="sx-login-layer">
          <Suspense fallback={null}>
            <LoginDialog
              key={login.companyId}
              companyId={login.companyId}
              message={login.message}
              onDone={(token: string | null, user?: string) => login.resolve(token ? { token, user } : null)}
            />
          </Suspense>
        </div>
      )}
    </>
  );
}

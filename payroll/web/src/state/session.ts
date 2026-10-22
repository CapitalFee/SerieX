// Session store: which company is open (payroll company id = SerieX Books company file id),
// its payroll information and preferences, and the signed-in SerieX Books user. Also handles
// the login flow (sign in with the SerieX Books user name and password), the payroll setup
// entry for a Books company without a payroll file, the "last company" and the recent
// companies list. Storage keys use the prefix "sxp." so SerieX Books and SerieX Payroll never
// share state.
import { create } from 'zustand';
import { api, setCompanyId, setSessionToken, ApiError } from '@/api/client';
import type { AuthInfo, LoginResult, PayrollCompany, PayrollCompanyFile, PayrollPrefs } from '@/api/types';
import { closeAllWindows, openWindow, useWindowStore, forceCloseAllWindows } from '@/windows/windowStore';
import { invalidateAll, queryClient } from '@/api/hooks';
import { alertBox } from '@/components/dialogs';

const LAST_KEY = 'sxp.lastCompany';
const RECENT_KEY = 'sxp.recentCompanies';
const TOKEN_KEY = 'sxp.session'; // sessionStorage: {companyId, token, user, isAdmin}
const MAX_RECENT = 8;

/** Product names (caption bar, browser tab, message boxes). */
export const APP_NAME = 'SerieX Payroll';
export const APP_SHORT_NAME = 'SerieX Payroll';

/** One entry of the recent companies list (localStorage "sxp.recentCompanies"). */
export interface RecentCompany {
  id: string;
  name: string;
}

/** Result of a successful login. */
export interface LoginOutcome {
  token: string;
  user?: string;
  isAdmin?: boolean;
}

/** A pending login request: App renders LoginDialog while this is set. */
export interface LoginRequest {
  companyId: string;
  /** Message shown when the session expired (from the "sx-auth-required" event). */
  message?: string;
  resolve(result: LoginOutcome | null): void;
}

export interface SessionState {
  companyId: string | null;
  company: PayrollCompany | null;
  prefs: PayrollPrefs | null;
  /** SerieX Books user name ("Admin" when the Books company has no passwords). */
  user: string;
  /** The user is a SerieX Books administrator (may reveal SSNs, edit tax tables, access). */
  isAdmin: boolean;
  /** True when the SerieX Books company has users with passwords (the user menu offers Log out). */
  authRequired: boolean;
  /** True while a company is being opened. */
  opening: boolean;
  /** Set while the login dialog must be shown. */
  login: LoginRequest | null;
  openCompany(id: string): Promise<void>;
  closeCompany(): void;
  reloadCompany(): Promise<void>;
}

/** Local date as YYYY-MM-DD. */
export function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function lsSet(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

/** Id of the company that was open last (localStorage "sxp.lastCompany"). */
export function getLastCompanyId(): string | null {
  return lsGet(LAST_KEY);
}

/** Recently opened companies, most recent first (localStorage "sxp.recentCompanies"). */
export function getRecentCompanies(): RecentCompany[] {
  try {
    const v = JSON.parse(lsGet(RECENT_KEY) ?? '[]');
    if (!Array.isArray(v)) return [];
    return v
      .map((x) => (typeof x === 'string' ? { id: x, name: x } : x))
      .filter((x): x is RecentCompany => !!x && typeof x.id === 'string')
      .map((x) => ({ id: x.id, name: x.name || x.id }));
  } catch {
    return [];
  }
}

/** Remove a company from the recent list (e.g. it no longer exists in SerieX Books). */
export function forgetRecentCompany(id: string) {
  lsSet(RECENT_KEY, JSON.stringify(getRecentCompanies().filter((r) => r.id !== id)));
  if (getLastCompanyId() === id) lsSet(LAST_KEY, null);
  recentListeners.forEach((f) => f());
}

function rememberCompany(id: string, name: string) {
  lsSet(LAST_KEY, id);
  const list = [{ id, name }, ...getRecentCompanies().filter((r) => r.id !== id)].slice(0, MAX_RECENT);
  lsSet(RECENT_KEY, JSON.stringify(list));
  recentListeners.forEach((f) => f());
}

const recentListeners = new Set<() => void>();
/** Subscribe to recent list changes; returns an unsubscribe function. */
export function onRecentCompaniesChange(fn: () => void): () => void {
  recentListeners.add(fn);
  return () => recentListeners.delete(fn);
}

interface SavedSession {
  token: string;
  user: string;
  isAdmin: boolean;
}

function savedToken(companyId: string): SavedSession | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(TOKEN_KEY) ?? 'null');
    if (v && v.companyId === companyId && typeof v.token === 'string') return { token: v.token, user: v.user || 'Admin', isAdmin: !!v.isAdmin };
  } catch {
    /* ignore */
  }
  return null;
}
function saveToken(companyId: string | null, token: string | null, user: string, isAdmin = false) {
  try {
    if (!companyId || !token) sessionStorage.removeItem(TOKEN_KEY);
    else sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ companyId, token, user, isAdmin }));
  } catch {
    /* ignore */
  }
}

/** Ask the user to sign in (App renders LoginDialog). Resolves null when cancelled. */
export function requestLogin(companyId: string, message?: string): Promise<LoginOutcome | null> {
  const pending = useSession.getState().login;
  if (pending) pending.resolve(null);
  return new Promise((resolve) => {
    useSession.setState({
      login: {
        companyId,
        message,
        resolve: (r) => {
          useSession.setState({ login: null });
          resolve(r);
        },
      },
    });
  });
}

/** Sign-in requirement of a SerieX Books company (GET /api/companies/{id}/auth). */
export function getAuthInfo(companyId: string): Promise<AuthInfo> {
  return api.global.get<AuthInfo>(`/companies/${encodeURIComponent(companyId)}/auth`, { noPrompt: true });
}

/** Sign in with a SerieX Books user name and password (POST /api/companies/{id}/login). */
export function loginCompany(companyId: string, user: string, password: string): Promise<LoginResult> {
  return api.global.post<LoginResult>(`/companies/${encodeURIComponent(companyId)}/login`, { user, password }, { noPrompt: true });
}

let openSeq = 0;

async function loadCompanyData(): Promise<{ company: PayrollCompany; prefs: PayrollPrefs }> {
  const [company, prefs] = await Promise.all([
    api.get<PayrollCompany>('/company', { noPrompt: true }),
    api.get<PayrollPrefs>('/prefs', { noPrompt: true }),
  ]);
  return { company, prefs };
}

const isAuthError = (e: unknown) => e instanceof ApiError && (e.code === 'auth' || e.code === 'books_auth');

/** Browser tab title: "<Company> - SerieX Payroll", "SerieX Payroll" without a company. */
export function setBrowserTitle(companyName: string | null) {
  document.title = companyName ? `${companyName} - ${APP_NAME}` : APP_SHORT_NAME;
}

export const useSession = create<SessionState>((set, get) => ({
  companyId: null,
  company: null,
  prefs: null,
  user: '',
  isAdmin: false,
  authRequired: false,
  opening: false,
  login: null,

  async openCompany(id: string) {
    const cur = get();
    if (cur.companyId === id && cur.company) return;
    const seq = ++openSeq;
    // Close the company that is open now (windows were already asked to save by the caller).
    if (cur.companyId) get().closeCompany();
    forceCloseAllWindows();
    set({ opening: true });
    try {
      const auth = await getAuthInfo(id);
      let user = 'Admin';
      let isAdmin = true;
      let token: string | null = null;
      if (auth?.required) {
        const saved = savedToken(id);
        if (saved) {
          token = saved.token;
          user = saved.user;
          isAdmin = saved.isAdmin;
        }
      }
      setSessionToken(token);
      setCompanyId(id);
      let data: { company: PayrollCompany; prefs: PayrollPrefs } | null = null;
      if (!auth?.required || token) {
        try {
          data = await loadCompanyData();
        } catch (e) {
          if (!isAuthError(e)) throw e;
          data = null;
        }
      }
      let message: string | undefined;
      while (!data) {
        // Sign-in required (no saved session, or it expired).
        setCompanyId(null);
        setSessionToken(null);
        const r = await requestLogin(id, message);
        if (seq !== openSeq) return;
        if (!r) {
          saveToken(null, null, '');
          set({ opening: false });
          return;
        }
        token = r.token;
        user = r.user || 'Admin';
        isAdmin = r.isAdmin ?? false;
        setSessionToken(token);
        setCompanyId(id);
        try {
          data = await loadCompanyData();
        } catch (e) {
          if (!isAuthError(e)) throw e;
          message = e instanceof Error ? e.message : undefined;
        }
      }
      if (seq !== openSeq) return;
      saveToken(token ? id : null, token, user, isAdmin);
      queryClient.clear();
      set({ companyId: id, company: data.company, prefs: data.prefs, user, isAdmin, opening: false, authRequired: !!auth?.required });
      rememberCompany(id, data.company.name || id);
      setBrowserTitle(data.company.name || id);
      openWindow('home');
      // The payroll file exists but the Payroll Setup wizard was not finished yet.
      if (!data.company.setupDone) openWindow('payrollSetup');
    } catch (e) {
      if (seq !== openSeq) return;
      setCompanyId(null);
      setSessionToken(null);
      set({ companyId: null, company: null, prefs: null, user: '', isAdmin: false, opening: false });
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof ApiError && e.code === 'not_found') {
        await alertBox(`Payroll has not been set up for this SerieX Books company yet.\n\nSelect the company in the list and click Set Up Payroll.`, APP_NAME);
      } else if (e instanceof ApiError && e.code === 'books_unavailable') {
        await alertBox(`SerieX Books is not running or cannot be reached.\n\n${msg}`, APP_NAME, 'warning');
      } else {
        await alertBox(`The company could not be opened.\n\n${msg}`, APP_NAME);
      }
    }
  },

  closeCompany() {
    const { companyId } = get();
    forceCloseAllWindows();
    if (companyId && savedToken(companyId)) {
      // Tell the server the session ended (ignore errors).
      api.post('/logout', {}, { noPrompt: true }).catch(() => undefined);
    }
    saveToken(null, null, '');
    setSessionToken(null);
    setCompanyId(null);
    queryClient.clear();
    set({ companyId: null, company: null, prefs: null, user: '', isAdmin: false, authRequired: false });
    setBrowserTitle(null);
  },

  async reloadCompany() {
    if (!get().companyId) return;
    try {
      const data = await loadCompanyData();
      set({ company: data.company, prefs: data.prefs });
      setBrowserTitle(data.company.name || get().companyId);
      const id = get().companyId;
      if (id) rememberCompany(id, data.company.name || id);
    } catch {
      /* keep the old values */
    }
  },
}));

/** Display name of the open company ('' when none). */
export function companyName(): string {
  const s = useSession.getState();
  return s.company?.name || s.companyId || '';
}

/** Open another company: asks open windows to save first, then opens it. */
export async function switchCompany(id: string): Promise<void> {
  const s = useSession.getState();
  if (s.companyId === id && s.company) return;
  if (!(await closeAllWindows())) return;
  await s.openCompany(id);
}

/**
 * Log out (user menu): asks open windows to save, ends the session and shows the login box again
 * for the same company. Cancelling the login leaves no company open.
 */
export async function logOut(): Promise<void> {
  const id = useSession.getState().companyId;
  if (!id) return;
  if (!(await closeAllWindows())) return;
  useSession.getState().closeCompany();
  await useSession.getState().openCompany(id);
}

/** File > Close Company: asks open windows to save, closes the company and forgets it as the last company. */
export async function requestCloseCompany(): Promise<boolean> {
  if (!(await closeAllWindows())) return false;
  useSession.getState().closeCompany();
  lsSet(LAST_KEY, null);
  return true;
}

/**
 * Called by App for the "sx-auth-required" window event: the payroll session is not valid
 * (or, with `books`, the SerieX Books session behind it expired). Shows the login dialog again.
 * Cancelling it closes the company only for the payroll session (`auth`): when just the SerieX
 * Books session expired the company stays open, payroll records can still be read and the
 * request that failed reports its error.
 */
export async function handleAuthRequired(message?: string, books?: boolean): Promise<void> {
  const s = useSession.getState();
  if (!s.companyId || s.login || s.opening) return;
  const id = s.companyId;
  // The server's generic "Please log in." (payroll session ended, e.g. the payroll server was
  // restarted) is replaced by a clearer text; other messages (access removed...) are shown as sent.
  const text = books
    ? 'Your SerieX Books session has expired. Sign in again with your SerieX Books user name and password.'
    : !message || /^please log in\.?$/i.test(message.trim())
      ? 'Your SerieX Payroll session has ended. Sign in again with your SerieX Books user name and password.'
      : message;
  const r = await requestLogin(id, text);
  if (useSession.getState().companyId !== id) return;
  if (!r) {
    if (!books) useSession.getState().closeCompany();
    return;
  }
  setSessionToken(r.token);
  const user = r.user || useSession.getState().user || 'Admin';
  const isAdmin = r.isAdmin ?? useSession.getState().isAdmin;
  saveToken(id, r.token, user, isAdmin);
  useSession.setState({ user, isAdmin });
  invalidateAll();
}

/** SerieX Books companies with their payroll status (GET /api/companies). */
export function listCompanies(): Promise<PayrollCompanyFile[]> {
  return api.global.get<PayrollCompanyFile[]>('/companies', { noPrompt: true });
}

/** True when any window is open (used to decide whether a company switch needs confirmation). */
export function hasOpenWindows(): boolean {
  return useWindowStore.getState().windows.length > 0;
}

// ---------------------------------------------------------------------------
// Payroll setup entry (a SerieX Books company without a payroll file)

/** Shows the first page of Payroll Setup; registered by App (modules/company/SetupFirstPage). */
type SetupPageFn = (companyId: string, companyName: string) => Promise<boolean>;
let setupPage: SetupPageFn | null = null;

/** Called once by App to provide the first Payroll Setup page (POST /api/companies/{id}/setup). */
export function registerSetupPage(fn: SetupPageFn) {
  setupPage = fn;
}

let settingUp = false;

/**
 * Set Up Payroll for a SerieX Books company: closes the open company (asking windows to save),
 * signs in to SerieX Books when the company has passwords, asks the first Payroll Setup page
 * (state, EIN, deposit schedule, first pay schedule...) which creates the payroll file, then
 * opens the company and the Payroll Setup wizard. Resolves true when the payroll file was created.
 */
export async function setUpPayroll(companyId: string, companyName = companyId): Promise<boolean> {
  if (settingUp || !setupPage) return false;
  settingUp = true;
  try {
    if (useSession.getState().companyId) {
      if (!(await closeAllWindows())) return false;
      useSession.getState().closeCompany();
    }
    const auth = await getAuthInfo(companyId);
    let token: string | null = null;
    let user = 'Admin';
    let isAdmin = true;
    if (auth?.required) {
      // Always sign in again: a saved session may have expired, and setup needs a valid SerieX Books session.
      const r = await requestLogin(companyId, 'Sign in with your SerieX Books user name and password to set up payroll for this company.');
      if (!r) return false;
      token = r.token;
      user = r.user || 'Admin';
      isAdmin = r.isAdmin ?? false;
    }
    setSessionToken(token);
    let created = false;
    try {
      created = await setupPage(companyId, companyName);
    } finally {
      if (!created) setSessionToken(null);
    }
    if (!created) return false;
    saveToken(token ? companyId : null, token, user, isAdmin);
    await useSession.getState().openCompany(companyId);
    if (useSession.getState().companyId === companyId) openWindow('payrollSetup');
    return true;
  } catch (e) {
    setSessionToken(null);
    await alertBox(`Payroll could not be set up.\n\n${e instanceof Error ? e.message : String(e)}`, APP_NAME);
    return false;
  } finally {
    settingUp = false;
  }
}

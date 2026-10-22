// Session store: which company file is open, its info and preferences, and the
// logged-in user. Also handles the company login (auth) flow, the "last company"
// and the recent companies list kept in localStorage.
import { create } from 'zustand';
import { api, setCompanyId, setSessionToken, getSessionToken, ApiError } from '@/api/client';
import type { CompanyFile, CompanyInfo, Prefs } from '@/api/types';
import { closeAllWindows, openTxn, openWindow, useWindowStore, forceCloseAllWindows } from '@/windows/windowStore';
import { invalidateAll, queryClient } from '@/api/hooks';
import { alertBox, msgBox } from '@/components/dialogs';
import { toast } from '@/components/toast';
import type { TxnType } from '@/api/types';
import { useView } from './view';

const LAST_KEY = 'sx.lastCompany';
const RECENT_KEY = 'sx.recentCompanies';
const TOKEN_KEY = 'sx.session'; // sessionStorage: {companyId, token, user}
const MAX_RECENT = 8;

/** One entry of the recent companies list (localStorage "sx.recentCompanies"). */
export interface RecentCompany {
  id: string;
  name: string;
}

/** A login session of a company file (token from POST /companies/{id}/login). */
export interface CompanySession {
  token: string;
  user?: string;
}

/** A pending login request: App renders LoginDialog while this is set. */
export interface LoginRequest {
  companyId: string;
  /** Message shown when the session expired (from the "sx-auth-required" event). */
  message?: string;
  resolve(result: { token: string; user?: string } | null): void;
}

export interface SessionState {
  companyId: string | null;
  company: CompanyInfo | null;
  prefs: Prefs | null;
  user: string;
  /** True while a company is being opened. */
  opening: boolean;
  /** Set while the login dialog must be shown. */
  login: LoginRequest | null;
  /** True when the open company has users with passwords (login required; the user menu offers Log out). */
  authRequired: boolean;
  /**
   * Opens a company file (closing the one that is open). `session`: a login the caller already
   * has for this file (e.g. the New Company wizard logged in to the new file), used instead of
   * asking for the password; the Log in box still shows when the server refuses it.
   */
  openCompany(id: string, session?: CompanySession): Promise<void>;
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

/** Id of the company that was open last (localStorage "sx.lastCompany"). */
export function getLastCompanyId(): string | null {
  return lsGet(LAST_KEY);
}

/** Recently opened companies, most recent first (localStorage "sx.recentCompanies"). */
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

/** Remove a company from the recent list (e.g. after it was deleted). */
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

function savedToken(companyId: string): { token: string; user: string } | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(TOKEN_KEY) ?? 'null');
    if (v && v.companyId === companyId && typeof v.token === 'string') return { token: v.token, user: v.user || 'Admin' };
  } catch {
    /* ignore */
  }
  return null;
}
function saveToken(companyId: string | null, token: string | null, user: string) {
  try {
    if (!companyId || !token) sessionStorage.removeItem(TOKEN_KEY);
    else sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ companyId, token, user }));
  } catch {
    /* ignore */
  }
}

/** Ask the user to log in (App renders LoginDialog). Resolves null when cancelled. */
export function requestLogin(companyId: string, message?: string): Promise<{ token: string; user?: string } | null> {
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

let openSeq = 0;

/** Ends a login session of a company file on the server (one that is not used; errors are ignored). */
function endSession(companyId: string, token: string): void {
  api.global.post(`/c/${encodeURIComponent(companyId)}/logout`, {}, { noPrompt: true, headers: { 'X-Session': token } }).catch(() => undefined);
}

async function loadCompanyData(): Promise<{ company: CompanyInfo; prefs: Prefs }> {
  const [company, prefs] = await Promise.all([
    api.get<CompanyInfo>('/company', { noPrompt: true }),
    api.get<Prefs>('/prefs', { noPrompt: true }),
  ]);
  return { company, prefs };
}

export const useSession = create<SessionState>((set, get) => ({
  companyId: null,
  company: null,
  prefs: null,
  user: '',
  opening: false,
  login: null,
  authRequired: false,

  async openCompany(id: string, session?: CompanySession) {
    const cur = get();
    if (cur.companyId === id && cur.company) return;
    const seq = ++openSeq;
    // Close the company that is open now (windows were already asked to save by the caller).
    if (cur.companyId) get().closeCompany();
    forceCloseAllWindows();
    set({ opening: true });
    // session made by the Log in box here: ended again when the file does not open with it
    let loggedIn: string | null = null;
    const dropLogin = () => {
      if (loggedIn) endSession(id, loggedIn);
      loggedIn = null;
    };
    try {
      const auth = await api.global.get<{ required: boolean; users: string[] }>(`/companies/${encodeURIComponent(id)}/auth`, { noPrompt: true });
      let user = 'Admin';
      let token: string | null = null;
      if (auth?.required) {
        const saved = session?.token ? { token: session.token, user: session.user || 'Admin' } : savedToken(id);
        if (saved) {
          token = saved.token;
          user = saved.user;
        }
      }
      setSessionToken(token);
      setCompanyId(id);
      let data: { company: CompanyInfo; prefs: Prefs } | null = null;
      if (!auth?.required || token) {
        try {
          data = await loadCompanyData();
        } catch (e) {
          if (!(e instanceof ApiError && e.code === 'auth')) throw e;
          data = null;
        }
      }
      while (!data) {
        // Login required (no saved session, or it expired).
        setCompanyId(null);
        setSessionToken(null);
        const r = await requestLogin(id);
        if (r) {
          dropLogin(); // an earlier login of this loop that the server refused
          loggedIn = r.token;
        }
        if (seq !== openSeq) {
          dropLogin();
          return;
        }
        if (!r) {
          dropLogin();
          saveToken(null, null, '');
          set({ opening: false });
          return;
        }
        token = r.token;
        user = r.user || 'Admin';
        setSessionToken(token);
        setCompanyId(id);
        try {
          data = await loadCompanyData();
        } catch (e) {
          if (!(e instanceof ApiError && e.code === 'auth')) throw e;
        }
      }
      if (seq !== openSeq) {
        dropLogin();
        return;
      }
      saveToken(token ? id : null, token, user);
      queryClient.clear();
      set({ companyId: id, company: data.company, prefs: data.prefs, user, opening: false, authRequired: !!auth?.required });
      rememberCompany(id, data.company.name || id);
      document.title = `${data.company.name || id} - ${APP_NAME}`;
      // Due automatic memorized transactions are entered when a company file opens.
      void processDueMemorized(id);
      if (data.prefs.showHomePageOnOpen) openWindow('home');
      if (data.prefs.showRemindersOnOpen) openWindow('reminders');
    } catch (e) {
      dropLogin();
      if (seq !== openSeq) return;
      setCompanyId(null);
      setSessionToken(null);
      set({ companyId: null, company: null, prefs: null, user: '', opening: false });
      const msg = e instanceof Error ? e.message : String(e);
      await alertBox(`The company file could not be opened.\n\n${msg}`, APP_NAME);
    }
  },

  closeCompany() {
    const { companyId } = get();
    forceCloseAllWindows();
    // The server backs up the file when it changed since its last backup (in the background);
    // sent before the logout below, which ends the session the request needs.
    const backedUp = companyId ? api.post('/backups/close', {}, { noPrompt: true, quiet: true }).catch(() => undefined) : Promise.resolve();
    if (companyId && savedToken(companyId)) {
      // Tell the server the session ended (ignore errors), and forget it.
      const token = getSessionToken();
      if (token) void backedUp.then(() => endSession(companyId, token));
      saveToken(null, null, '');
    }
    // A session saved for another company file is kept: the New Company wizard logs in to the
    // new file before the open one is closed, so its owner is not asked for the password again.
    setSessionToken(null);
    setCompanyId(null);
    queryClient.clear();
    set({ companyId: null, company: null, prefs: null, user: '', authRequired: false });
    document.title = APP_NAME;
  },

  async reloadCompany() {
    if (!get().companyId) return;
    try {
      const old = get().prefs;
      const data = await loadCompanyData();
      set({ company: data.company, prefs: data.prefs });
      // window and navigation preferences changed (Preferences dialog): follow them.
      const view = useView.getState();
      if (old && data.prefs.windowMode && data.prefs.windowMode !== old.windowMode) view.setWindowMode(data.prefs.windowMode);
      if (old && data.prefs.iconBar && data.prefs.iconBar !== old.iconBar) view.setIconBar(data.prefs.iconBar);
      document.title = `${data.company.name || get().companyId} - ${APP_NAME}`;
      const id = get().companyId;
      if (id) rememberCompany(id, data.company.name || id);
      // Users and passwords may have changed (Set Up Users): refresh the login requirement.
      if (id) {
        api.global
          .get<{ required: boolean }>(`/companies/${encodeURIComponent(id)}/auth`, { noPrompt: true })
          .then((a) => {
            if (get().companyId === id) set({ authRequired: !!a?.required });
          })
          .catch(() => undefined);
      }
    } catch {
      /* keep the old values */
    }
  },
}));

export const APP_NAME = 'SerieX Books';

/** Display name of the open company ('' when none). */
export function companyName(): string {
  const s = useSession.getState();
  return s.company?.name || s.companyId || '';
}

/**
 * Open another company: asks open windows to save first, then opens it. `session`: a login the
 * caller already has for that file (see SessionState.openCompany). Resolves true when that company
 * is open at the end (also when it already was), false when the switch did not happen: Cancel in
 * a "save your changes?" prompt (the open company stays), the Log in box was cancelled, or the
 * file could not be opened. A `session` that did not end up in use is ended on the server, so
 * no login is left behind.
 */
export async function switchCompany(id: string, session?: CompanySession): Promise<boolean> {
  const s = useSession.getState();
  if (s.companyId === id && s.company) return true;
  let opened = false;
  try {
    if (await closeAllWindows()) {
      await useSession.getState().openCompany(id, session);
      const after = useSession.getState();
      opened = after.companyId === id && !!after.company;
    }
  } finally {
    if (session?.token && !(opened && getSessionToken() === session.token)) endSession(id, session.token);
  }
  return opened;
}

/** File > Close Company: asks open windows to save, closes the file and forgets it as the last company. */
export async function requestCloseCompany(): Promise<boolean> {
  if (!(await closeAllWindows())) return false;
  useSession.getState().closeCompany();
  lsSet(LAST_KEY, null);
  return true;
}

/**
 * Log out (user menu): asks open windows to save, ends the session and shows the
 * login box again for the same company. Cancelling the login leaves no company open.
 */
export async function logOut(): Promise<void> {
  const id = useSession.getState().companyId;
  if (!id) return;
  if (!(await closeAllWindows())) return;
  useSession.getState().closeCompany();
  await useSession.getState().openCompany(id);
}

/** Result of POST /memorized/process-due. */
interface ProcessDueResult {
  entered: number;
  errors?: string[];
  /** (when the server lists them) the transactions entered. */
  txns?: { id: number; type: TxnType }[];
}

/**
 * Enters the automatic memorized transactions that are due (done when a company file opens)
 * and tells the user: a toast for what was entered, a message box for the ones that failed.
 */
async function processDueMemorized(companyId: string): Promise<void> {
  let r: ProcessDueResult | null = null;
  try {
    r = await api.post<ProcessDueResult>('/memorized/process-due', {}, { noPrompt: true });
  } catch {
    return;
  }
  if (!r || useSession.getState().companyId !== companyId) return;
  if (r.entered > 0) {
    void invalidateAll();
    const one = r.entered === 1;
    const last = Array.isArray(r.txns) && r.txns.length ? r.txns[r.txns.length - 1] : null;
    toast(`${r.entered} scheduled memorized transaction${one ? ' was' : 's were'} entered automatically`, {
      kind: 'success',
      duration: 8000,
      action: {
        label: 'Open',
        onClick: () => {
          if (last && one) openTxn(last.type, last.id);
          else openWindow('memorizedTxns');
        },
      },
    });
  }
  const errors = (r.errors ?? []).filter(Boolean);
  if (errors.length) {
    const b = await msgBox({
      title: 'Memorized Transactions',
      message:
        `${errors.length === 1 ? 'One scheduled memorized transaction was' : `${errors.length} scheduled memorized transactions were`} not entered automatically:\n\n` +
        errors.map((e) => `• ${e}`).join('\n') +
        '\n\nOpen the Memorized Transaction List to fix and enter them.',
      buttons: ['Open &Memorized Transaction List', 'OK'],
      icon: 'warning',
      width: 520,
    });
    if (b === 'Open Memorized Transaction List' && useSession.getState().companyId === companyId) openWindow('memorizedTxns');
  }
}

let pendingAuth: Promise<boolean> | null = null;

/**
 * Asks the user to log in again (session expired / lost after a server restart). Used by the API
 * client (setAuthHandler: the refused request is re-sent after the login) and by App for the
 * "sx-auth-required" window event. Several refused requests share one login box.
 * Resolves true when a new session is in place.
 */
export function handleAuthRequired(message?: string): Promise<boolean> {
  if (pendingAuth) return pendingAuth;
  const s = useSession.getState();
  if (!s.companyId || s.login || s.opening) return Promise.resolve(false);
  const id = s.companyId;
  pendingAuth = (async () => {
    const r = await requestLogin(id, message);
    if (useSession.getState().companyId !== id) return false;
    if (!r) {
      useSession.getState().closeCompany();
      return false;
    }
    setSessionToken(r.token);
    const user = r.user || useSession.getState().user || 'Admin';
    saveToken(id, r.token, user);
    useSession.setState({ user });
    void invalidateAll();
    return true;
  })().finally(() => {
    pendingAuth = null;
  });
  return pendingAuth;
}

/** List the company files on the server. */
export function listCompanies(): Promise<CompanyFile[]> {
  return api.global.get<CompanyFile[]>('/companies', { noPrompt: true });
}

/** True when any window is open (used to decide whether a company switch needs confirmation). */
export function hasOpenWindows(): boolean {
  return useWindowStore.getState().windows.length > 0;
}

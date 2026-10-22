// HTTP client for the SerieX Books server.
//
// Company-scoped calls use paths relative to /api/c/{companyId} (e.g.
// api.get('/accounts')). Global calls use api.global.* with paths relative to
// /api (e.g. api.global.get('/companies')).
//
// Server questions are handled here so every screen gets them for free:
//   code "confirm"      -> Yes/No box; on Yes the request is re-sent with ?accept=<kinds answered
//                          Yes so far> (the error's "warning" kind), so each later question is still
//                          asked; a question without a kind is answered with ?force=1 (all)
//   code "closing_date" -> password box; the request is re-sent with header X-Closing-Password
//   code "auth"         -> the login handler (setAuthHandler) asks the user to log in and the
//                          request is re-sent; without a handler the window event
//                          "sx-auth-required" is dispatched
// The message boxes themselves are provided by the UI through setPromptHandlers().

export class ApiError extends Error {
  status: number;
  code: string;
  field?: string;
  /** Kind of a "confirm" question (dupnum, creditlimit, inventory...); also kept on the "cancelled" error after No. */
  warning?: string;
  /** Extra details from the server (e.g. the existing record of a "name already in use" error). */
  data?: Record<string, unknown>;
  constructor(status: number, code: string, message: string, field?: string, warning?: string, data?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.field = field;
    this.warning = warning;
    this.data = data;
  }
}

export interface PromptHandlers {
  confirm(message: string, title?: string): Promise<boolean>;
  password(message: string, title?: string): Promise<string | null>;
}

let companyId: string | null = null;
let sessionToken: string | null = null;
let prompts: PromptHandlers = {
  confirm: async (m) => window.confirm(m),
  password: async (m) => window.prompt(m),
};

export function setCompanyId(id: string | null) {
  companyId = id;
}
export function getCompanyId(): string | null {
  return companyId;
}
export function setSessionToken(token: string | null) {
  sessionToken = token;
}
export function getSessionToken(): string | null {
  return sessionToken;
}
export function setPromptHandlers(h: PromptHandlers) {
  prompts = h;
}

/** Asks the user to log in again; resolves true when a new session token is in place. */
export type AuthHandler = (message: string) => Promise<boolean>;
let authHandler: AuthHandler | null = null;
/**
 * Login handler used when a request is refused with code "auth" (session lost, e.g. after a
 * server restart): the request is re-sent once after a successful login.
 */
export function setAuthHandler(h: AuthHandler | null) {
  authHandler = h;
}

export interface RequestOptions {
  /** Path is relative to /api instead of /api/c/{companyId}. */
  global?: boolean;
  /** Pre-confirm every question (adds ?force=1). */
  force?: boolean;
  /** Question kinds already answered Yes (adds ?accept=a,b; see ApiError.warning). */
  accept?: string[];
  /** Extra request headers (e.g. If-Match with the updatedAt of the copy being voided / deleted). */
  headers?: Record<string, string>;
  closingPassword?: string;
  /** Return the raw Response (downloads). */
  raw?: boolean;
  /** Do not show confirm / password prompts; throw instead. */
  noPrompt?: boolean;
  /** Background request: a refused login does not ask the user to log in again (no "sx-auth-required"). */
  quiet?: boolean;
  signal?: AbortSignal;
}

function buildUrl(path: string, opts: RequestOptions): string {
  let base: string;
  if (opts.global) {
    base = '/api' + path;
  } else {
    if (!companyId) throw new ApiError(0, 'no_company', 'No company file is open.');
    base = `/api/c/${encodeURIComponent(companyId)}` + path;
  }
  if (opts.force) base += (base.includes('?') ? '&' : '?') + 'force=1';
  if (opts.accept && opts.accept.length) base += (base.includes('?') ? '&' : '?') + 'accept=' + opts.accept.map(encodeURIComponent).join(',');
  return base;
}

/** Build a query string from an object, skipping null/undefined/'' values. */
export function qs(params: Record<string, unknown> | undefined): string {
  if (!params) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) {
      if (v.length) parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v.join(','))}`);
    } else {
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    }
  }
  return parts.length ? '?' + parts.join('&') : '';
}

/** Internal: the request was already re-sent after a login. */
type InternalOptions = RequestOptions & { authRetried?: boolean };

async function request<T>(method: string, path: string, body?: unknown, opts: InternalOptions = {}): Promise<T> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  // (a caller may name the session itself, e.g. to end a login of another company file)
  if (sessionToken && !headers['X-Session']) headers['X-Session'] = sessionToken;
  if (opts.closingPassword) headers['X-Closing-Password'] = opts.closingPassword;

  const res = await fetch(buildUrl(path, opts), { method, headers, body: payload, signal: opts.signal });
  if (res.ok) {
    if (opts.raw) return res as unknown as T;
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  let err: { error?: string; code?: string; field?: string; warning?: string; data?: Record<string, unknown> } = {};
  try {
    err = await res.json();
  } catch {
    /* not JSON */
  }
  const e = new ApiError(res.status, err.code ?? 'http_' + res.status, err.error ?? res.statusText, err.field, err.warning || undefined, err.data);

  if (!opts.noPrompt) {
    if (e.code === 'confirm' && !opts.force) {
      const yes = await prompts.confirm(e.message);
      if (yes) {
        const accepted = opts.accept ?? [];
        // answer Yes to this question only; the server still asks the next one
        if (e.warning && !accepted.includes(e.warning)) return request<T>(method, path, body, { ...opts, accept: [...accepted, e.warning] });
        return request<T>(method, path, body, { ...opts, force: true });
      }
      throw new ApiError(e.status, 'cancelled', 'Cancelled.', e.field, e.warning, { question: e.message });
    }
    if (e.code === 'closing_date') {
      const pw = await prompts.password(e.message, 'Closing Date Password');
      if (pw !== null && pw !== '') return request<T>(method, path, body, { ...opts, closingPassword: pw });
      throw new ApiError(e.status, 'cancelled', 'Cancelled.');
    }
    if (e.code === 'auth' && authHandler && !opts.authRetried) {
      // log in again, then send the same request once more (the typed data is not lost)
      if (await authHandler(e.message)) return request<T>(method, path, body, { ...opts, authRetried: true });
      throw e;
    }
  }
  if (e.code === 'auth' && !opts.quiet) window.dispatchEvent(new CustomEvent('sx-auth-required', { detail: { message: e.message } }));
  throw e;
}

/**
 * File name of a download from its Content-Disposition header: the RFC 5987 form
 * (filename*=UTF-8''100%25%20Organic.sxb) is decoded; the plain form (filename="100% Organic.sxb")
 * is used as it is. Falls back to `fallback` when there is none or it cannot be read.
 */
export function downloadFileName(cd: string | null | undefined, fallback: string): string {
  if (!cd) return fallback;
  try {
    const star = /filename\*\s*=\s*([^;]+)/i.exec(cd);
    if (star) {
      let v = star[1].trim().replace(/^"(.*)"$/, '$1');
      const enc = /^([A-Za-z0-9!#$&+.^_`{}~-]*)'[^']*'(.*)$/.exec(v);
      if (enc) v = enc[2];
      try {
        const d = decodeURIComponent(v);
        if (d.trim()) return d;
      } catch {
        /* bad escape: try the plain name */
      }
    }
    const plain = /(?:^|;)\s*filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/i.exec(cd);
    if (plain) {
      const v = plain[1] !== undefined ? plain[1].replace(/\\(.)/g, '$1') : (plain[2] ?? '').trim();
      if (v.trim()) return v;
    }
  } catch {
    /* fall back */
  }
  return fallback;
}

function make(global: boolean) {
  return {
    get: <T>(path: string, opts?: RequestOptions) => request<T>('GET', path, undefined, { ...opts, global }),
    post: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('POST', path, body ?? {}, { ...opts, global }),
    put: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('PUT', path, body ?? {}, { ...opts, global }),
    patch: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('PATCH', path, body ?? {}, { ...opts, global }),
    del: <T = void>(path: string, opts?: RequestOptions) => request<T>('DELETE', path, undefined, { ...opts, global }),
    /** multipart upload: file under field "file" plus extra string fields */
    upload: <T>(path: string, file: File | Blob, fields?: Record<string, string>, opts?: RequestOptions) => {
      const fd = new FormData();
      fd.append('file', file);
      for (const [k, v] of Object.entries(fields ?? {})) fd.append(k, v);
      return request<T>('POST', path, fd, { ...opts, global });
    },
    /** GET a file and hand it to the browser as a download */
    download: async (path: string, fallbackName = 'download', opts?: RequestOptions) => {
      const res = await request<Response>('GET', path, undefined, { ...opts, global, raw: true });
      const blob = await res.blob();
      const name = downloadFileName(res.headers.get('Content-Disposition'), fallbackName);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    },
    /** absolute URL of an endpoint (for <a href> / window.open) */
    url: (path: string) => buildUrl(path, { global }),
  };
}

export const api = { ...make(false), global: make(true) };

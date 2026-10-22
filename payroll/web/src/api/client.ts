// HTTP client for the SerieX Payroll server (same request and error rules as the
// SerieX Books client, so both apps behave alike).
//
// Company-scoped calls use paths relative to /api/c/{companyId} (e.g.
// api.get('/accounts')). Global calls use api.global.* with paths relative to
// /api (e.g. api.global.get('/companies')).
//
// Server questions are handled here so every screen gets them for free:
//   code "confirm"      -> Yes/No box; on Yes the request is re-sent with ?force=1
//   code "closing_date" -> password box; the request is re-sent with header X-Closing-Password
//   code "auth"         -> the window event "sx-auth-required" is dispatched
//   code "books_auth"   -> same event with detail.books = true (the SerieX Books
//                          session behind payroll expired: sign in again)
// The message boxes themselves are provided by the UI through setPromptHandlers().

export class ApiError extends Error {
  status: number;
  code: string;
  field?: string;
  constructor(status: number, code: string, message: string, field?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.field = field;
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

export interface RequestOptions {
  /** Path is relative to /api instead of /api/c/{companyId}. */
  global?: boolean;
  /** Pre-confirm questions (adds ?force=1). */
  force?: boolean;
  closingPassword?: string;
  /** Return the raw Response (downloads). */
  raw?: boolean;
  /** Do not show confirm / password prompts; throw instead. */
  noPrompt?: boolean;
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

async function request<T>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  let payload: BodyInit | undefined;
  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  if (sessionToken) headers['X-Session'] = sessionToken;
  if (opts.closingPassword) headers['X-Closing-Password'] = opts.closingPassword;

  const res = await fetch(buildUrl(path, opts), { method, headers, body: payload, signal: opts.signal });
  if (res.ok) {
    if (opts.raw) return res as unknown as T;
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  let err: { error?: string; code?: string; field?: string } = {};
  try {
    err = await res.json();
  } catch {
    /* not JSON */
  }
  const e = new ApiError(res.status, err.code ?? 'http_' + res.status, err.error ?? res.statusText, err.field);

  if (!opts.noPrompt) {
    if (e.code === 'confirm' && !opts.force) {
      const yes = await prompts.confirm(e.message);
      if (yes) return request<T>(method, path, body, { ...opts, force: true });
      throw new ApiError(e.status, 'cancelled', 'Cancelled.');
    }
    if (e.code === 'closing_date') {
      const pw = await prompts.password(e.message, 'Closing Date Password');
      if (pw !== null && pw !== '') return request<T>(method, path, body, { ...opts, closingPassword: pw });
      throw new ApiError(e.status, 'cancelled', 'Cancelled.');
    }
  }
  if (e.code === 'auth' || e.code === 'books_auth')
    window.dispatchEvent(new CustomEvent('sx-auth-required', { detail: { message: e.message, books: e.code === 'books_auth' } }));
  throw e;
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
      const cd = res.headers.get('Content-Disposition') ?? '';
      const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
      const name = m ? decodeURIComponent(m[1]) : fallbackName;
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

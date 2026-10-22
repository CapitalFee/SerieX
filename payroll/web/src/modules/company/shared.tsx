// Helpers shared by the company module windows: data hooks for the company
// endpoints that have no kit hook, small formatting helpers and the Books Sync retry flow
// (used by the Books Sync window and the Home page).
import { useQuery } from '@tanstack/react-query';
import { api, ApiError, getCompanyId, qs } from '@/api/client';
import type { AuditRow, PayrollCompanyFile, RetryResult, SyncProblem, SyncRef, TaxTableInfo } from '@/api/types';
import { invalidateAll } from '@/api/hooks';
import { msgBox, promptBox } from '@/components';
import { handleAuthRequired, useSession } from '@/state/session';

export const PRODUCT_NAME = 'SerieX Payroll';

const hasCompany = () => !!getCompanyId();

// ---------------------------------------------------------------------------
// Data hooks

/** SerieX Books companies with their payroll status (global, works without an open company). */
export function useCompanyFiles() {
  return useQuery({
    queryKey: ['global', 'payroll-companies'],
    queryFn: () => api.global.get<PayrollCompanyFile[]>('/companies', { noPrompt: true }),
    staleTime: 0,
    retry: false,
  });
}

/** Audit trail rows (GET /audit?from&to&entity&user), newest first. */
export function useAudit(params: { from?: string; to?: string; entity?: string; user?: string }) {
  return useQuery({
    queryKey: ['audit', params],
    queryFn: ({ signal }) => api.get<AuditRow[]>('/audit' + qs(params), { signal }),
    enabled: hasCompany(),
    staleTime: 0,
  });
}

/** Tax table summary of a year (GET /tax-tables?year=). */
export function useTaxTableInfo(year: number) {
  return useQuery({
    queryKey: ['tax-tables', year],
    queryFn: ({ signal }) => api.get<TaxTableInfo>('/tax-tables' + qs({ year }), { signal }),
    enabled: hasCompany() && !!year,
  });
}

// ---------------------------------------------------------------------------
// Formatting

const m0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0, minimumFractionDigits: 0 });
const m2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "$1,235". */
export function money0(n: number | null | undefined): string {
  return m0.format(Math.round(Number(n ?? 0)) || 0);
}

/** "$1,234.56". */
export function money2(n: number | null | undefined): string {
  return m2.format(Number(n ?? 0) || 0);
}

/** Percent with up to 4 decimals ("3.4%"). */
export function pct(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '';
  return `${Number(n.toFixed(4))}%`;
}

/** "5 minutes ago", "Yesterday", "Mar 3, 2026" for an ISO date/time ('' when empty). */
export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'Just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  if (d === 1) return 'Yesterday';
  if (d < 7) return `${d} days ago`;
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** "10/17/2026 3:05 PM" for an ISO date/time. */
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return `${d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' })} ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
}

/** First line of an error message. */
export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// SerieX Books Sync retry (POST /books/sync/retry). The server answers 200 even when SerieX Books
// refuses a posting; each problem carries a code, handled here as follows:
//   books_auth        -> the SerieX Books session expired: sign in again, then retry
//   confirm           -> SerieX Books asks a question (duplicate check number...): ask, then retry with force
//   closing_date      -> the date is on or before the SerieX Books closing date: ask for the password, then retry
//   books_unavailable -> SerieX Books is not running: nothing more can be done now

/** What a retry run did. */
export interface RetryOutcome {
  posted: number;
  /** Problems left after every question was answered. */
  problems: SyncProblem[];
  /** SerieX Books could not be reached. */
  unavailable: boolean;
  /** The user cancelled the sign-in. */
  signInCancelled: boolean;
}

const refOf = (p: SyncProblem): SyncRef => ({ entity: p.entity, id: p.id });

async function retryOnce(items: SyncRef[] | null, opts: { force?: boolean; closingPassword?: string } = {}): Promise<RetryResult> {
  return api.post<RetryResult>('/books/sync/retry', { items: items ?? [] }, { noPrompt: true, force: opts.force, closingPassword: opts.closingPassword });
}

/**
 * Posts the given records (all waiting and failed records when `items` is null) and answers the
 * questions SerieX Books asks. Returns what was posted and the problems that are left.
 */
export async function retryPosting(items: SyncRef[] | null): Promise<RetryOutcome> {
  let posted = 0;
  let res = await retryOnce(items);
  posted += res.posted;
  let problems = res.problems ?? [];
  const out: RetryOutcome = { posted, problems: [], unavailable: false, signInCancelled: false };

  // 1) SerieX Books session expired: sign in again, then retry what was not posted
  if (problems.some((p) => p.code === 'books_auth')) {
    const cid = useSession.getState().companyId;
    await handleAuthRequired(undefined, true);
    const signedIn = !!cid && useSession.getState().companyId === cid;
    if (!signedIn) {
      out.signInCancelled = true;
      out.problems = problems;
      out.posted = posted;
      return out;
    }
    const again = items ?? null;
    res = await retryOnce(again);
    posted += res.posted;
    problems = res.problems ?? [];
    if (problems.some((p) => p.code === 'books_auth')) {
      out.problems = problems;
      out.posted = posted;
      return out;
    }
  }

  const left: SyncProblem[] = [];
  // 2) questions from SerieX Books: ask once per record, retry the ones the user accepts
  const confirms = problems.filter((p) => p.code === 'confirm');
  const yes: SyncRef[] = [];
  for (let i = 0; i < confirms.length; i++) {
    const p = confirms[i];
    const buttons = confirms.length - i > 1 ? ['&Yes', 'Yes to &All', '&No'] : ['&Yes', '&No'];
    const r = await msgBox({
      title: 'SerieX Books',
      icon: 'question',
      message: `${p.label}\n\nSerieX Books says: ${p.message.replace(/^SerieX Books:\s*/i, '')}\n\nPost it to SerieX Books anyway?`,
      buttons,
    });
    if (r === 'Yes') yes.push(refOf(p));
    else if (r === 'Yes to All') {
      for (let j = i; j < confirms.length; j++) yes.push(refOf(confirms[j]));
      break;
    } else left.push(p);
  }
  if (yes.length) {
    const r2 = await retryOnce(yes, { force: true });
    posted += r2.posted;
    for (const p of r2.problems ?? []) if (p.code !== 'closing_date') left.push(p);
    problems = [...problems.filter((p) => p.code !== 'confirm'), ...(r2.problems ?? []).filter((p) => p.code === 'closing_date')];
  } else problems = problems.filter((p) => p.code !== 'confirm');

  // 3) closing date: one password for every record dated in the closed period
  const closing = problems.filter((p) => p.code === 'closing_date');
  if (closing.length) {
    const pw = await promptBox(
      `${closing.length === 1 ? closing[0].label + ' is' : closing.length + ' records are'} dated on or before the SerieX Books closing date.\n\n${closing[0].message.replace(/^SerieX Books:\s*/i, '')}\n\nEnter the SerieX Books closing date password to post ${closing.length === 1 ? 'it' : 'them'}:`,
      { password: true, title: 'Closing Date Password' },
    );
    if (pw) {
      const r3 = await retryOnce(closing.map(refOf), { closingPassword: pw, force: true });
      posted += r3.posted;
      left.push(...(r3.problems ?? []));
    } else left.push(...closing);
  }

  left.push(...problems.filter((p) => p.code !== 'closing_date' && p.code !== 'confirm'));
  out.posted = posted;
  out.problems = left;
  out.unavailable = left.some((p) => p.code === 'books_unavailable');
  void invalidateAll();
  return out;
}

/** Plain-English summary of a retry outcome (toast / status line). */
export function retrySummary(o: RetryOutcome): string {
  const parts: string[] = [];
  parts.push(o.posted === 1 ? '1 record was posted to SerieX Books.' : `${o.posted} records were posted to SerieX Books.`);
  if (o.unavailable) parts.push('SerieX Books is not running, so the rest could not be posted.');
  else if (o.signInCancelled) parts.push('Sign in to SerieX Books to post the rest.');
  else if (o.problems.length) parts.push(o.problems.length === 1 ? '1 record still has a problem.' : `${o.problems.length} records still have problems.`);
  return parts.join(' ');
}

/** True when the error is "SerieX Books is not running". */
export function isBooksDown(e: unknown): boolean {
  return e instanceof ApiError && e.code === 'books_unavailable';
}

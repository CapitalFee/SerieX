// Suggested bank rules (server banking/rule_suggest.go): rules proposed because the same kind of bank
// transaction was classified the same way several times and no rule covers it yet. Shown in Bank
// Rules (Add / Review / Dismiss), announced in Bank Imports when adds and matches bring new ones, and
// in the import of QuickBooks® Desktop files (tick to create).
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { queryClient } from '@/api/hooks';
import type { BankRule } from '@/api/types';
import { Badge } from '@/components';
import { fmtDate, fmtMoney } from '@/util/format';
import './ruleSuggestions.css';

export interface RuleSuggestion {
  key: string;
  rule: BankRule;
  payee: string;
  category: string;
  accountName: string;
  matchFrom: 'bank' | 'memo' | 'name';
  count: number;
  matching: number;
  total: number;
  first: string;
  last: string;
  confidence: 'high' | 'medium';
  reason: string;
  others: { category: string; count: number }[];
  examples: { txnId: number; date: string; amount: number; text: string }[];
}

/** Query key of the open company's suggested rules (refreshed after transactions are classified). */
export const RULE_SUGGESTIONS_KEY = ['bank-rule-suggestions'];

/** A replaced or cancelled request is stopped (`signal`), so quick clicks do not pile up on the server. */
export const fetchRuleSuggestions = ({ signal }: { signal?: AbortSignal } = {}) =>
  api.get<{ suggestions: RuleSuggestion[] }>('/bank-rules/suggestions', { signal }).then((r) => r.suggestions);

/**
 * The open company's suggested rules (GET /bank-rules/suggestions). `live: false` only reads what
 * is already loaded, without refreshing after every change (Bank Imports loads it when it needs it).
 */
export function useRuleSuggestions({ live = true }: { live?: boolean } = {}) {
  return useQuery({ queryKey: RULE_SUGGESTIONS_KEY, queryFn: fetchRuleSuggestions, enabled: live });
}

/** Loads the suggested rules again now, whatever is already loaded. */
export const loadRuleSuggestions = () => queryClient.fetchQuery({ queryKey: RULE_SUGGESTIONS_KEY, queryFn: fetchRuleSuggestions, staleTime: 0 });

const FROM: Record<RuleSuggestion['matchFrom'], string> = {
  bank: 'from the bank text',
  memo: 'from the memos',
  name: 'from the payee name: check what your bank prints',
};

/**
 * One suggestion: what the rule does and why it is suggested. `matchText` replaces the text shown (an
 * editor); `isNew` marks one that Bank Imports just announced.
 */
export function SuggestionSummary({ s, matchText, isNew }: { s: RuleSuggestion; matchText?: ReactNode; isNew?: boolean }) {
  const dir = s.rule.direction === 'in' ? 'Money in' : 'Money out';
  return (
    <div className="rs-summary">
      <div className="rs-line">
        {isNew && (
          <Badge tone="info" title="Suggested from the transactions you just added or matched in Bank Imports">
            New
          </Badge>
        )}
        <span className="rs-when">When the bank text contains</span>
        {matchText ?? <b className="rs-text">{s.rule.matchText}</b>}
        <span className="rs-arrow">→</span>
        <span className="rs-does">
          {s.payee ? <b>{s.payee}</b> : <span className="rs-muted">No payee</span>}
          <span className="rs-muted"> · </span>
          <b>{s.category}</b>
        </span>
        <Badge tone={s.confidence === 'high' ? 'success' : 'warning'} title={s.confidence === 'high' ? 'A clear, repeated pattern' : 'A pattern with exceptions, or text from the payee name'}>
          {s.confidence === 'high' ? 'Strong pattern' : 'Check it'}
        </Badge>
      </div>
      <div className="rs-meta">
        {s.accountName || 'Every bank and credit card account'} · {dir} · text {FROM[s.matchFrom]}
      </div>
      <div className="rs-why">
        {s.reason} {s.count > 1 && `From ${fmtDate(s.first)} to ${fmtDate(s.last)}, ${fmtMoney(Math.abs(s.total))} in all.`}
        {s.others.length > 0 && <> Other times: {s.others.map((o) => `${o.category} (${o.count})`).join(', ')}.</>}
      </div>
      {s.examples.length > 0 && (
        <div className="rs-examples">
          {s.examples.map((e) => (
            <span key={e.txnId}>
              {fmtDate(e.date)} · {e.text} · {fmtMoney(Math.abs(e.amount))}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

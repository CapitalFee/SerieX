// Bank Rules: the rules that categorize downloaded transactions (bank text contains … → payee,
// category). New / Edit / Delete; double-click edits. Rules are applied as suggestions in Bank Imports.
// Above the list, suggested rules: patterns of transactions classified the same way several times
// that no rule covers yet (Add, Review in the rule editor, or Dismiss).
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Lightbulb, ListFilter, Pencil, Plus, Trash2 } from 'lucide-react';
import { api, type ApiError } from '@/api/client';
import { queryClient, useAccountsById, useNames } from '@/api/hooks';
import type { BankRule, ID } from '@/api/types';
import { Button, EmptyState, ListView, Spinner, Toolbar, ToolbarButton, ToolbarSpacer, confirmBox, toast, useHotkeys, type ListColumn } from '@/components';
import { useWindow } from '@/windows/WindowContext';
import { editBankRule } from './bankRuleDialog';
import { RULE_SUGGESTIONS_KEY, SuggestionSummary, useRuleSuggestions, type RuleSuggestion } from './ruleSuggestions';
import './banking.css';

export interface BankRulesProps {
  /** Suggested rules (keys) to list first and mark as new: the ones Bank Imports just announced. */
  highlight?: string[];
}

const DIRECTION: Record<BankRule['direction'], string> = { any: 'In or out', in: 'Money in', out: 'Money out' };

/** A list cell with two lines (each cut with an ellipsis when too long). */
function twoLines(top: ReactNode, bottom: ReactNode) {
  return (
    <span className="bk-rules-2l">
      <span>{top}</span>
      <span>{bottom}</span>
    </span>
  );
}

export default function BankRules(props: BankRulesProps) {
  const win = useWindow();
  const { data: rules, isLoading } = useQuery({ queryKey: ['bank-rules'], queryFn: () => api.get<BankRule[]>('/bank-rules') });
  const accounts = useAccountsById();
  const { data: names } = useNames(undefined, { active: 'all' });
  const [selected, setSelected] = useState<ID | null>(null);
  const sel = rules?.find((r) => r.id === selected) ?? null;
  const { data: suggestionList } = useRuleSuggestions();
  const highlight = useMemo(() => new Set(props.highlight ?? []), [props.highlight]);
  // the ones Bank Imports just announced come first (the server's order otherwise)
  const suggestions = useMemo(
    () => (suggestionList && highlight.size ? [...suggestionList.filter((s) => highlight.has(s.key)), ...suggestionList.filter((s) => !highlight.has(s.key))] : suggestionList),
    [suggestionList, highlight],
  );
  const [showSuggestions, setShowSuggestions] = useState(true);
  useEffect(() => {
    if (highlight.size) setShowSuggestions(true);
  }, [highlight]);
  const refreshSuggestions = () => void queryClient.invalidateQueries({ queryKey: RULE_SUGGESTIONS_KEY });

  useEffect(() => {
    win.setTitle('Bank Rules');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (rules?.length && !rules.some((r) => r.id === selected)) setSelected(rules[0].id);
  }, [rules, selected]);

  const nameOf = (id: ID | null) => (id ? names?.find((n) => n.id === id)?.fullName ?? '' : '');
  const acctOf = (id: ID | null) => (id ? accounts.get(id)?.fullName ?? '' : '');
  /** The "Show payee as" text when it says something the payee name does not (else ''). */
  const shownAs = (r: BankRule) => {
    const t = r.renameTo.trim();
    return t && t.toLowerCase() !== nameOf(r.nameId).trim().toLowerCase() ? t : '';
  };
  // Two-line rows (like the register) so every column fits the default 740px window: the widths add
  // up to less than its list, with room for a scroll bar. Wider windows share the extra room among
  // the text columns, so long account names and categories show in full.
  const columns = useMemo<ListColumn<BankRule>[]>(
    () => [
      { key: 'priority', label: 'Priority', width: 80, type: 'number', title: 'When several rules match, the lowest number wins' },
      { key: 'name', label: 'Rule name', width: 120, grow: true },
      {
        key: 'accountId',
        label: 'Applies to',
        title: 'The bank or credit card account, and the money direction, the rule looks at',
        width: 146,
        grow: true,
        render: (r) => twoLines(r.accountId ? acctOf(r.accountId) : 'All accounts', <span className="bk-muted">{DIRECTION[r.direction]}</span>),
        sortValue: (r) => (r.accountId ? acctOf(r.accountId) : ''),
      },
      {
        key: 'matchText',
        label: 'Bank text contains',
        title: 'The text the bank description must contain, and the text shown instead of it (Show payee as)',
        width: 152,
        grow: true,
        render: (r) => {
          const shown = shownAs(r);
          return shown ? twoLines(r.matchText, <><span className="bk-muted">Shown as</span> {shown}</>) : r.matchText;
        },
        sortValue: (r) => r.matchText,
      },
      {
        key: 'nameId',
        label: 'Payee / Category',
        title: 'The payee and the category the rule fills in',
        width: 182,
        grow: true,
        render: (r) => {
          const payee = nameOf(r.nameId);
          const cat = acctOf(r.targetAccountId);
          return twoLines(payee || <span className="bk-muted">No payee</span>, cat || <span className="bk-muted">No category</span>);
        },
        // by payee, then category (rules without a payee go last, like other empty values)
        sortValue: (r) => {
          const payee = nameOf(r.nameId);
          return payee ? `${payee}\t${acctOf(r.targetAccountId)}` : '';
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accounts, names],
  );

  const nextPriority = () => (rules?.reduce((m, x) => Math.max(m, x.priority), 0) ?? 0) + 1;
  const add = async () => {
    const r = await editBankRule({ priority: nextPriority() });
    if (r) {
      setSelected(r.id);
      refreshSuggestions();
    }
  };
  const edit = async (r: BankRule | null = sel) => {
    if (r && (await editBankRule(r))) refreshSuggestions();
  };
  const addSuggested = async (s: RuleSuggestion) => {
    try {
      const saved = await api.post<BankRule>('/bank-rules', { ...s.rule, priority: nextPriority() });
      void queryClient.invalidateQueries({ queryKey: ['bank-rules'] });
      void queryClient.invalidateQueries({ queryKey: ['bank-feed-items'] });
      refreshSuggestions();
      setSelected(saved.id);
      toast(`Rule "${saved.name}" added`, { kind: 'success' });
    } catch (e) {
      if ((e as ApiError).code !== 'cancelled') toast((e as Error).message, { kind: 'error' });
    }
  };
  const reviewSuggested = async (s: RuleSuggestion) => {
    const r = await editBankRule({ ...s.rule, priority: nextPriority() });
    if (r) {
      setSelected(r.id);
      refreshSuggestions();
    }
  };
  const dismissSuggested = async (s: RuleSuggestion) => {
    try {
      await api.post('/bank-rules/suggestions/dismiss', { key: s.key });
      refreshSuggestions();
      toast('Suggestion dismissed', { kind: 'info' });
    } catch (e) {
      if ((e as ApiError).code !== 'cancelled') toast((e as Error).message, { kind: 'error' });
    }
  };
  const remove = async (r: BankRule | null = sel) => {
    if (!r) return;
    if (!(await confirmBox(`Delete the rule "${r.name}"? Downloaded transactions already added are not changed.`, 'Delete Rule'))) return;
    try {
      await api.del(`/bank-rules/${r.id}`);
      void queryClient.invalidateQueries({ queryKey: ['bank-rules'] });
      refreshSuggestions();
      void queryClient.invalidateQueries({ queryKey: ['bank-feed-items'] });
      toast(`Rule "${r.name}" deleted`, { kind: 'info' });
    } catch (e) {
      if ((e as ApiError).code !== 'cancelled') toast((e as Error).message, { kind: 'error' });
    }
  };

  useHotkeys({
    'ctrl+e': () => void edit(),
    'ctrl+d': () => void remove(),
  });

  return (
    <div className="bk-rules">
      <Toolbar aria-label="Bank rules">
        <ToolbarButton label="New rule" icon={Plus} onClick={() => void add()} variant="primary" />
        <ToolbarButton label="Edit" icon={Pencil} onClick={() => void edit()} disabled={!sel} shortcut="Ctrl+E" />
        <ToolbarButton label="Delete" icon={Trash2} onClick={() => void remove()} disabled={!sel} shortcut="Ctrl+D" />
        <ToolbarSpacer />
      </Toolbar>
      <p className="bk-rules-intro">Rules fill in the payee and the category of downloaded bank transactions whose description contains some text. You still review each one in Bank Imports before it is added.</p>
      {suggestions && suggestions.length > 0 && (
        <section className="rs-panel" aria-label="Suggested rules">
          <div className="rs-panel-head">
            <Lightbulb size={15} aria-hidden="true" />
            <b>
              {suggestions.length} suggested {suggestions.length === 1 ? 'rule' : 'rules'}
            </b>
            <span className="rs-grow">You classified these transactions the same way several times and no rule covers them yet.</span>
            <button type="button" className="sx-linkbtn" onClick={() => setShowSuggestions((v) => !v)} aria-expanded={showSuggestions}>
              {showSuggestions ? 'Hide' : 'Show'}
            </button>
          </div>
          {showSuggestions && (
            <div className="rs-panel-body">
              {suggestions.map((s) => (
                <div className="rs-item" key={s.key}>
                  <SuggestionSummary s={s} isNew={highlight.has(s.key)} />
                  <div className="rs-actions">
                    <Button size="sm" variant="primary" label="Add rule" onClick={() => void addSuggested(s)} />
                    <Button size="sm" label="Review..." onClick={() => void reviewSuggested(s)} />
                    <Button size="sm" label="Dismiss" onClick={() => void dismissSuggested(s)} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
      <div className="bk-rules-list">
        {isLoading ? (
          <Spinner center />
        ) : rules?.length ? (
          <ListView<BankRule>
            columns={columns}
            rows={rules}
            selectedKey={selected}
            onSelect={(k) => setSelected(k as ID)}
            onActivate={(r) => void edit(r)}
            contextMenu={(r) =>
              r
                ? [
                    { label: '&Edit rule', onClick: () => void edit(r) },
                    { label: '&Delete rule', onClick: () => void remove(r) },
                  ]
                : [{ label: '&New rule', onClick: () => void add() }]
            }
            rowHeight={40}
            autoFocus
            persistKey="bk-rules2"
            aria-label="Bank rules"
          />
        ) : (
          <EmptyState
            icon={ListFilter}
            title="No bank rules yet"
            message="Create a rule when the same kind of bank transaction keeps coming back, for example fuel purchases or your rent. In Bank Imports you can also click “Create rule from this” on a transaction."
            action={{ label: 'New rule', onClick: () => void add() }}
          />
        )}
      </div>
    </div>
  );
}

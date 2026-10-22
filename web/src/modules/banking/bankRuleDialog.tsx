// Bank rule editor (New / Edit Rule), shown in a modal box. Used by the Bank Rules window and by
// Bank Imports ("Create rule from this").
import { useState } from 'react';
import { api } from '@/api/client';
import { queryClient } from '@/api/hooks';
import type { AccountType, BankRule, ID } from '@/api/types';
import { AccountPicker, EditDialog, Field, FieldRow, NamePicker, NumberField, Select, SegmentedControl, TextField, showDialog, toast, useFormErrors } from '@/components';
import { useAccountsOfTypes, LINE_EXCLUDED_TYPES } from './shared';

export function emptyRule(): BankRule {
  return { id: 0, name: '', accountId: null, matchText: '', direction: 'any', renameTo: '', nameId: null, targetAccountId: null, priority: 0 };
}

const FEED_TYPES: AccountType[] = ['Bank', 'Credit Card'];

function RuleForm({ initial, onDone }: { initial: BankRule; onDone: (r: BankRule | null) => void }) {
  const [r, setR] = useState<BankRule>(initial);
  const fe = useFormErrors();
  const { active: feedAccounts } = useAccountsOfTypes(FEED_TYPES);
  const set = (p: Partial<BankRule>) => setR((x) => ({ ...x, ...p }));

  const save = async () => {
    fe.clearAll();
    if (!r.matchText.trim()) {
      fe.setFieldError('matchText', 'Enter the text the bank description must contain.');
      return false;
    }
    if (!r.nameId && !r.targetAccountId && !r.renameTo.trim()) {
      fe.setMessage('Choose what the rule does: a payee, a category, or a new name for the payee.');
      return false;
    }
    try {
      const saved = r.id ? await api.put<BankRule>(`/bank-rules/${r.id}`, r) : await api.post<BankRule>('/bank-rules', r);
      void queryClient.invalidateQueries({ queryKey: ['bank-rules'] });
      void queryClient.invalidateQueries({ queryKey: ['bank-feed-items'] });
      toast(`Rule "${saved.name}" saved`, { kind: 'success' });
      onDone(saved);
      return true;
    } catch (e) {
      fe.fromError(e);
      return false;
    }
  };

  return (
    <div className="bk-rule-dlg">
      <EditDialog errors={fe} onOk={save} onCancel={() => onDone(null)} okLabel="Save rule">
        <div className="bk-rule-form">
          <Field label="Rule name" htmlFor="bk-rule-name" hint="Leave it blank to use the bank text.">
            <TextField id="bk-rule-name" name="name" value={r.name} onChange={(v) => set({ name: v })} autoFocus />
          </Field>
          <div className="bk-rule-section">When a downloaded transaction…</div>
          <FieldRow>
            <Field label="Applies to" htmlFor="bk-rule-acct" width={250}>
              <Select
                id="bk-rule-acct"
                name="accountId"
                value={r.accountId ?? ''}
                onChange={(v) => set({ accountId: v ? Number(v) : null })}
                options={[{ value: '', label: 'Every bank and credit card account' }, ...feedAccounts.map((a) => ({ value: a.id, label: a.fullName }))]}
              />
            </Field>
            <Field label="Money">
              <SegmentedControl<BankRule['direction']>
                name="direction"
                aria-label="Money direction"
                value={r.direction}
                onChange={(v) => set({ direction: v })}
                options={[
                  { value: 'any', label: 'In or out' },
                  { value: 'in', label: 'Money in' },
                  { value: 'out', label: 'Money out' },
                ]}
              />
            </Field>
          </FieldRow>
          <Field label="Bank text contains" htmlFor="bk-rule-text" required hint="Not case sensitive, e.g. HARBOR FUEL">
            <TextField id="bk-rule-text" name="matchText" value={r.matchText} onChange={(v) => set({ matchText: v })} />
          </Field>
          <div className="bk-rule-section">…then fill in</div>
          <FieldRow>
            <Field label="Payee" htmlFor="bk-rule-payee" width={250}>
              <NamePicker id="bk-rule-payee" name="nameId" value={r.nameId} onChange={(id: ID | null, n) => set({ nameId: id, renameTo: r.renameTo || (n?.fullName ?? '') })} />
            </Field>
            <Field label="Category (account)" htmlFor="bk-rule-cat" width={250}>
              <AccountPicker id="bk-rule-cat" name="targetAccountId" excludeTypes={LINE_EXCLUDED_TYPES} value={r.targetAccountId} onChange={(id) => set({ targetAccountId: id })} />
            </Field>
          </FieldRow>
          <FieldRow>
            <Field label="Show payee as" htmlFor="bk-rule-rename" width={250} hint="Text shown instead of the bank description">
              <TextField id="bk-rule-rename" name="renameTo" value={r.renameTo} onChange={(v) => set({ renameTo: v })} />
            </Field>
            <Field label="Priority" htmlFor="bk-rule-prio" width={100} help="When several rules match, the lowest number wins.">
              <NumberField id="bk-rule-prio" name="priority" value={r.priority} decimals={0} nullable={false} onChange={(v) => set({ priority: v ?? 0 })} />
            </Field>
          </FieldRow>
        </div>
      </EditDialog>
    </div>
  );
}

/** Opens the rule editor (new when `initial.id` is 0); resolves the saved rule or null. */
export function editBankRule(initial: Partial<BankRule> = {}): Promise<BankRule | null> {
  const rule = { ...emptyRule(), ...initial };
  return showDialog<BankRule | null>({
    title: rule.id ? `Edit Rule: ${rule.name}` : 'New Bank Rule',
    width: 600,
    cancelValue: null,
    render: (close) => <RuleForm initial={rule} onDone={close} />,
  });
}

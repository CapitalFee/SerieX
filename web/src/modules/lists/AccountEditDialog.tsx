// New / Edit Account dialog.
// New accounts start with an "Add New Account: Choose Account Type" step (main types,
// "Other Account Types", plain-English explanation of the selected type), then the form: type,
// number (when account numbers are on), name, subaccount of, description, bank account / routing
// or card number, tax-line mapping, note, opening balance + as of (balance sheet types, new only),
// inactive (edit). Save and close / Save and new. props.name / props.type / props.parentId prefill.
// A save sends the account's updatedAt as it was opened: when someone else changed it since, the
// server refuses and the dialog offers to reload the latest version (useStaleCopy).
import { useEffect, useState } from 'react';
import { Info } from 'lucide-react';
import { api, ApiError } from '@/api/client';
import { invalidateAll, useAccounts, usePrefValues } from '@/api/hooks';
import { BALANCE_SHEET_TYPES, type Account, type AccountType, type ID } from '@/api/types';
import {
  AccountPicker,
  Checkbox,
  DateField,
  EditDialog,
  Field,
  MoneyField,
  notifyCreated,
  Select,
  Spinner,
  TextField,
  toast,
  useFormErrors,
} from '@/components';
import { todayIso } from '@/util/dates';
import { useWindow } from '@/windows/WindowContext';
import { descendantIds, focusLater, snapshotOf, useStaleCopy } from './common';
import './lists.css';

export interface AccountEditDialogProps {
  id?: number;
  type?: AccountType;
  parentId?: number;
  /** Name typed in a picker ("Add with details…"). */
  name?: string;
}

// ---------------------------------------------------------------------------
// account types: the chooser and the explanations

interface TypeInfo {
  title: string;
  text: string;
  examples: string;
}

const MAIN_CHOICES: { key: string; label: string; type: AccountType }[] = [
  { key: 'Income', label: 'Income', type: 'Income' },
  { key: 'Expense', label: 'Expense', type: 'Expense' },
  { key: 'Fixed Asset', label: 'Fixed Asset (major purchases)', type: 'Fixed Asset' },
  { key: 'Bank', label: 'Bank', type: 'Bank' },
  { key: 'Loan', label: 'Loan', type: 'Long Term Liability' },
  { key: 'Credit Card', label: 'Credit Card', type: 'Credit Card' },
  { key: 'Equity', label: 'Equity', type: 'Equity' },
];

const OTHER_TYPES: AccountType[] = [
  'Accounts Receivable',
  'Other Current Asset',
  'Other Asset',
  'Accounts Payable',
  'Other Current Liability',
  'Long Term Liability',
  'Cost of Goods Sold',
  'Other Income',
  'Other Expense',
];

/** Every type a user can pick (Non-Posting accounts are only made by the program). */
const ALL_TYPES: AccountType[] = [
  'Bank',
  'Accounts Receivable',
  'Other Current Asset',
  'Fixed Asset',
  'Other Asset',
  'Accounts Payable',
  'Credit Card',
  'Other Current Liability',
  'Long Term Liability',
  'Equity',
  'Income',
  'Cost of Goods Sold',
  'Expense',
  'Other Income',
  'Other Expense',
];

const TYPE_INFO: Record<string, TypeInfo> = {
  Income: {
    title: 'Income account',
    text: 'Tracks money you earn from your normal business: selling products, doing services, fees you charge.',
    examples: 'Sales, Service income, Consulting fees, Delivery income.',
  },
  Expense: {
    title: 'Expense account',
    text: 'Tracks money you spend to run the business day to day.',
    examples: 'Rent, Utilities, Office supplies, Advertising, Insurance, Telephone.',
  },
  'Fixed Asset': {
    title: 'Fixed asset account',
    text: 'Tracks major purchases you keep and use for more than a year. Their cost is usually spread over their useful life (depreciation).',
    examples: 'Vehicles, Equipment, Furniture, Buildings, Computers.',
  },
  Bank: {
    title: 'Bank account',
    text: 'Tracks money in a checking, savings or money market account, or cash you keep on hand. Create one for each account you have at the bank so you can reconcile it with the statement.',
    examples: 'Checking, Savings, Money market, Petty cash.',
  },
  Loan: {
    title: 'Loan (long term liability)',
    text: 'Tracks money your business borrowed and pays back over more than a year. SerieX Books creates it as a Long Term Liability account. For a loan you will repay within a year, choose Other Current Liability under Other Account Types.',
    examples: 'Truck loan, Equipment loan, Mortgage, Notes payable.',
  },
  'Credit Card': {
    title: 'Credit card account',
    text: 'Tracks what you charge on a business credit card and what you owe on it. Create one account for each card so you can reconcile it with the card statement.',
    examples: 'Business Visa, Company MasterCard, Store card.',
  },
  Equity: {
    title: 'Equity account',
    text: "Tracks the owners' investment in the business and the money they take out. The difference between what the business owns and owes belongs here.",
    examples: "Owner's equity, Owner's draw, Capital stock, Partner contributions.",
  },
  'Accounts Receivable': {
    title: 'Accounts receivable (A/R)',
    text: 'Tracks money customers owe you for invoices. SerieX Books already has one; most businesses never need a second A/R account.',
    examples: 'Accounts Receivable, Retainers receivable.',
  },
  'Other Current Asset': {
    title: 'Other current asset',
    text: 'Tracks things of value you expect to use up or turn into cash within a year, other than bank accounts and customer balances.',
    examples: 'Prepaid insurance, Employee advances, Security deposits, Inventory.',
  },
  'Other Asset': {
    title: 'Other asset',
    text: 'Tracks long-term assets that are not equipment or property.',
    examples: 'Long-term notes receivable, Intangible assets, Deposits held over a year.',
  },
  'Accounts Payable': {
    title: 'Accounts payable (A/P)',
    text: 'Tracks money you owe vendors for bills you have entered. SerieX Books already has one; most businesses never need a second A/P account.',
    examples: 'Accounts Payable.',
  },
  'Other Current Liability': {
    title: 'Other current liability',
    text: 'Tracks money your business owes and expects to pay within a year.',
    examples: 'Sales tax payable, Payroll liabilities, Short-term loans, Customer deposits.',
  },
  'Long Term Liability': {
    title: 'Long term liability',
    text: 'Tracks money your business owes and will pay back over more than a year.',
    examples: 'Notes payable, Mortgages, Equipment loans.',
  },
  'Cost of Goods Sold': {
    title: 'Cost of goods sold',
    text: 'Tracks the direct cost of the products and services you sell, so you can see your gross profit.',
    examples: 'Materials, Subcontractors, Freight in, Job supplies.',
  },
  'Other Income': {
    title: 'Other income',
    text: 'Tracks income that does not come from your normal business activities.',
    examples: 'Interest earned, Gain on sale of equipment, Insurance proceeds.',
  },
  'Other Expense': {
    title: 'Other expense',
    text: 'Tracks expenses that are not part of normal operations.',
    examples: 'Income taxes, Loss on sale of assets, Penalties.',
  },
};

const typeInfo = (t: AccountType): TypeInfo => TYPE_INFO[t] ?? { title: t, text: '', examples: '' };

// common tax form lines (free text in the account; this list just offers the usual ones)
const TAX_LINES: Record<string, string[]> = {
  income: ['Gross receipts or sales', 'Other income', 'Interest income'],
  cogs: ['COGS: Purchases', 'COGS: Cost of labor', 'COGS: Materials and supplies', 'COGS: Other costs'],
  expense: [
    'Advertising',
    'Car and truck expenses',
    'Commissions and fees',
    'Contract labor',
    'Depreciation',
    'Employee benefit programs',
    'Insurance (other than health)',
    'Interest: Mortgage',
    'Interest: Other',
    'Legal and professional services',
    'Meals (deductible)',
    'Office expense',
    'Rent: Vehicles, machinery, equipment',
    'Rent: Other business property',
    'Repairs and maintenance',
    'Supplies',
    'Taxes and licenses',
    'Travel',
    'Utilities',
    'Wages',
    'Other business expenses',
  ],
  asset: ['B/S-Assets: Cash', 'B/S-Assets: Accounts receivable', 'B/S-Assets: Inventories', 'B/S-Assets: Other current assets', 'B/S-Assets: Buildings and other depreciable assets', 'B/S-Assets: Other assets'],
  liability: ['B/S-Liabs/Eq.: Accounts payable', 'B/S-Liabs/Eq.: Other current liabilities', 'B/S-Liabs/Eq.: Mortgages, notes, bonds payable', 'B/S-Liabs/Eq.: Loans from owners'],
  equity: ['B/S-Liabs/Eq.: Capital stock', 'B/S-Liabs/Eq.: Paid-in or capital surplus', 'B/S-Liabs/Eq.: Retained earnings', "B/S-Liabs/Eq.: Owner's draws"],
};

function taxLineGroup(t: AccountType): string {
  switch (t) {
    case 'Income':
    case 'Other Income':
      return 'income';
    case 'Cost of Goods Sold':
      return 'cogs';
    case 'Expense':
    case 'Other Expense':
      return 'expense';
    case 'Accounts Payable':
    case 'Credit Card':
    case 'Other Current Liability':
    case 'Long Term Liability':
      return 'liability';
    case 'Equity':
      return 'equity';
    default:
      return 'asset';
  }
}

// ---------------------------------------------------------------------------
// form state

interface AccountForm {
  id: ID;
  type: AccountType;
  number: string;
  name: string;
  isSub: boolean;
  parentId: ID | null;
  description: string;
  bankAcctNumber: string;
  routingNumber: string;
  taxLine: string;
  note: string;
  active: boolean;
  openingBalance: number;
  openingDate: string;
  special: string;
  hasTxns: boolean;
}

function blankForm(type: AccountType, name = '', parentId: ID | null = null): AccountForm {
  return {
    id: 0,
    type,
    number: '',
    name,
    isSub: parentId !== null,
    parentId,
    description: '',
    bankAcctNumber: '',
    routingNumber: '',
    taxLine: '',
    note: '',
    active: true,
    openingBalance: 0,
    openingDate: todayIso(),
    special: '',
    hasTxns: false,
  };
}

function fromAccount(a: Account): AccountForm {
  return {
    id: a.id,
    type: a.type,
    number: a.number,
    name: a.name,
    isSub: a.parentId !== null,
    parentId: a.parentId,
    description: a.description,
    bankAcctNumber: a.bankAcctNumber,
    routingNumber: a.routingNumber,
    taxLine: a.taxLine,
    note: a.note,
    active: a.active,
    openingBalance: 0,
    openingDate: todayIso(),
    special: a.special,
    hasTxns: a.hasTxns,
  };
}

const canHaveOpening = (t: AccountType) => BALANCE_SHEET_TYPES.includes(t) && t !== 'Accounts Receivable' && t !== 'Accounts Payable';

// ---------------------------------------------------------------------------

export default function AccountEditDialog(props: AccountEditDialogProps) {
  const win = useWindow();
  const prefs = usePrefValues();
  const fe = useFormErrors();
  const { data: accounts } = useAccounts({ active: 'all' });
  const [isNew, setIsNew] = useState(!props.id);
  const [step, setStep] = useState<'type' | 'form'>(props.id || props.type || props.parentId ? 'form' : 'type');
  const [choice, setChoice] = useState<string>(props.type ?? 'Income');
  const [form, setForm] = useState<AccountForm | null>(() => (props.id ? null : props.type && !props.parentId ? blankForm(props.type, props.name ?? '') : null));
  /** The form as it was opened (a new account without its name), to tell whether anything changed. */
  const [baseline, setBaseline] = useState<string | null>(() => (props.id ? null : props.type && !props.parentId ? snapshotOf(blankForm(props.type)) : null));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [originalName, setOriginalName] = useState('');
  /** Version of the account when it was opened: the server refuses the save when someone changed it since. */
  const [loadedUpdatedAt, setLoadedUpdatedAt] = useState<string | undefined>(undefined);
  /** Starts a new account form (a name typed in a picker counts as a change). */
  const startNew = (type: AccountType, name = '', parentId: ID | null = null) => {
    setForm(blankForm(type, name, parentId));
    setBaseline(snapshotOf(blankForm(type, '', parentId)));
  };

  // EditDialog marks the window changed and asks "Do you want to save your changes?" on close
  const dirty = step === 'form' && !!form && baseline !== null && snapshotOf(form) !== baseline;

  /** Shows an existing account as stored (and remembers the version it was opened at). */
  const loadAccount = (a: Account) => {
    setForm(fromAccount(a));
    setBaseline(snapshotOf(fromAccount(a)));
    setLoadedUpdatedAt(a.updatedAt);
    setOriginalName(a.fullName);
  };

  // load an existing account / prefill a new subaccount from its parent
  useEffect(() => {
    let off = false;
    if (props.id) {
      api
        .get<Account>(`/accounts/${props.id}`)
        .then((a) => {
          if (off) return;
          loadAccount(a);
        })
        .catch((e) => !off && setLoadError((e as Error).message));
    } else if (props.parentId && !form && accounts) {
      const p = accounts.find((a) => a.id === props.parentId);
      startNew(p?.type ?? props.type ?? 'Expense', props.name ?? '', p ? p.id : null);
    }
    return () => {
      off = true;
    };
  }, [props.id, props.parentId, accounts]); // eslint-disable-line react-hooks/exhaustive-deps

  // someone else saved the account after it was opened: load their version (false: it is gone)
  const stale = useStaleCopy(fe, 'account', async () => {
    try {
      loadAccount(await api.get<Account>(`/accounts/${props.id}`));
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) throw e;
      setLoadError(`${e.message} It may have been deleted.`);
      return false;
    }
  });

  const set = (patch: Partial<AccountForm>) => setForm((f) => (f ? { ...f, ...patch } : f));

  // ---- step 1: choose the type
  if (step === 'type') {
    const chosenType: AccountType = MAIN_CHOICES.find((c) => c.key === choice)?.type ?? (choice as AccountType);
    const info = TYPE_INFO[choice] ?? typeInfo(chosenType);
    const go = () => {
      startNew(chosenType, props.name ?? '');
      setStep('form');
    };
    const otherSel = OTHER_TYPES.includes(choice as AccountType) ? choice : '';
    return (
      <EditDialog title="Add New Account: Choose Account Type" okLabel="Continue" onOk={go}>
        <div className="fl-typechooser">
          <div>
            <div className="fl-typelist" role="radiogroup" aria-label="Account type">
              {MAIN_CHOICES.map((c, i) => (
                <button
                  key={c.key}
                  type="button"
                  role="radio"
                  aria-checked={choice === c.key}
                  autoFocus={choice === c.key || (i === 0 && !MAIN_CHOICES.some((m) => m.key === choice))}
                  className={'fl-typeopt' + (choice === c.key ? ' fl-on' : '')}
                  onClick={() => setChoice(c.key)}
                  onDoubleClick={() => {
                    setChoice(c.key);
                    startNew(c.type, props.name ?? '');
                    setStep('form');
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                      e.preventDefault();
                      const n = MAIN_CHOICES[(i + (e.key === 'ArrowDown' ? 1 : -1) + MAIN_CHOICES.length) % MAIN_CHOICES.length];
                      setChoice(n.key);
                      const el = (e.currentTarget.parentElement?.children[(i + (e.key === 'ArrowDown' ? 1 : -1) + MAIN_CHOICES.length) % MAIN_CHOICES.length] as HTMLElement | undefined);
                      el?.focus();
                    } else if (e.key === 'Enter') {
                      e.preventDefault();
                      go();
                    }
                  }}
                >
                  <span className="fl-typeopt-dot" aria-hidden="true" />
                  {c.label}
                </button>
              ))}
            </div>
            <div className="fl-typelist-sep">Other account types</div>
            <Select
              aria-label="Other account types"
              value={otherSel}
              onChange={(v) => v && setChoice(v)}
              options={[{ value: '', label: '<Select>' }, ...OTHER_TYPES.map((t) => ({ value: t, label: t }))]}
            />
          </div>
          <div className="fl-typeinfo" aria-live="polite">
            <div className="fl-typeinfo-title">{info.title}</div>
            <div className="fl-typeinfo-text">{info.text}</div>
            {info.examples && (
              <div className="fl-typeinfo-ex">
                <b>Examples:</b> {info.examples}
              </div>
            )}
            <div className="fl-note">You can change the type later, as long as the account is not used for customer or vendor balances.</div>
          </div>
        </div>
      </EditDialog>
    );
  }

  if (loadError) {
    return (
      <EditDialog title="Edit Account" onOk={() => win.close(true)} okLabel="Close">
        <div className="fl-info">
          <Info size={16} />
          <span>The account could not be loaded: {loadError}</span>
        </div>
      </EditDialog>
    );
  }
  if (!form) {
    return (
      <div className="fl-page" style={{ alignItems: 'center', justifyContent: 'center', background: '#fff' }}>
        <Spinner label="Loading account…" />
      </div>
    );
  }

  // ---- step 2: the form
  const f = form;
  const all = accounts ?? [];
  const excluded = f.id ? [...descendantIds(all, f.id)] : [];
  const special = f.special !== '';
  const showOpening = isNew && canHaveOpening(f.type);
  const taxOptions = TAX_LINES[taxLineGroup(f.type)];
  const taxChoices = [{ value: '', label: '<Unassigned>' }, ...(f.taxLine && !taxOptions.includes(f.taxLine) ? [f.taxLine] : []).map((t) => ({ value: t, label: t })), ...taxOptions.map((t) => ({ value: t, label: t }))];
  const bank = f.type === 'Bank';
  const card = f.type === 'Credit Card';
  const openingLabel = bank ? 'Statement ending balance' : card ? 'Amount you owe' : 'Opening balance';

  const changeType = (t: AccountType) => {
    const parent = all.find((a) => a.id === f.parentId);
    set({ type: t, ...(parent && parent.type !== t ? { parentId: null, isSub: false } : {}) });
  };

  const save = async (): Promise<Account | null> => {
    fe.clearAll();
    const name = f.name.trim();
    const problems: Record<string, string> = {};
    if (!name) problems.name = 'Enter a name for the account.';
    else if (name.includes(':')) problems.name = 'An account name cannot contain a colon (:). Use "Subaccount of" to put it under another account.';
    if (f.isSub && !f.parentId) problems.parentId = 'Choose the account this one goes under, or clear "Subaccount of".';
    const num = f.number.trim();
    const sameNumber = num ? all.find((a) => a.id !== f.id && a.number === num) : undefined;
    if (sameNumber) problems.number = `Number ${num} is already used by "${sameNumber.fullName}".`;
    const parent = f.isSub ? f.parentId : null;
    const sameName = name ? all.find((a) => a.id !== f.id && a.parentId === parent && a.name.toLowerCase() === name.toLowerCase()) : undefined;
    if (sameName && !problems.name)
      problems.name = `There is already an account named "${sameName.fullName}"${sameName.active ? '' : ' (inactive)'}. Use a different name, or make this one a subaccount.`;
    if (Object.keys(problems).length) {
      fe.setErrors(problems);
      return null;
    }
    const body: Record<string, unknown> = {
      id: f.id,
      name,
      number: f.number.trim(),
      type: f.type,
      parentId: f.isSub ? f.parentId : null,
      description: f.description,
      note: f.note,
      bankAcctNumber: bank || card ? f.bankAcctNumber : '',
      routingNumber: bank ? f.routingNumber : '',
      taxLine: f.taxLine,
      active: f.active,
    };
    if (!isNew && loadedUpdatedAt) body.updatedAt = loadedUpdatedAt;
    if (showOpening && f.openingBalance) {
      body.openingBalance = f.openingBalance;
      body.openingDate = f.openingDate || todayIso();
    }
    try {
      const saved = isNew ? await api.post<Account>('/accounts', body) : await api.put<Account>(`/accounts/${f.id}`, body);
      await invalidateAll();
      if (isNew) notifyCreated({ kind: 'account', id: saved.id });
      toast(isNew ? `Account "${saved.fullName}" created` : `Account "${saved.fullName}" saved`);
      return saved;
    } catch (e) {
      if (!(await stale.handle(e))) fe.fromError(e);
      return null;
    }
  };

  const title = isNew ? 'New Account' : `Edit Account: ${originalName}`;

  return (
    <EditDialog
      title={title}
      errors={fe}
      dirty={dirty}
      okLabel="Save and close"
      onOk={async () => {
        if (!(await save())) return false;
        await win.close(true);
      }}
      onSaveNew={
        isNew
          ? async () => {
              const saved = await save();
              if (!saved) return;
              setIsNew(true);
              startNew(f.type, '', f.isSub ? f.parentId : null);
              focusLater(win.id, 'name');
            }
          : undefined
      }
      footerLeft={!isNew ? <Checkbox checked={!f.active} onChange={(v) => set({ active: !v })} label="Account is inactive" /> : undefined}
      extraButtons={
        isNew && !props.type && !props.parentId && !props.id ? (
          <button type="button" className="fl-linkbtn" style={{ marginRight: 8 }} onClick={() => setStep('type')}>
            ‹ Back to account types
          </button>
        ) : (
          stale.button
        )
      }
    >
      <div className="fl-form">
        {special && (
          <div className="fl-info">
            <Info size={16} />
            <span>SerieX Books uses this account for special purposes, so it cannot be deleted and its type cannot be changed.</span>
          </div>
        )}
        <div className="fl-grid" style={{ gridTemplateColumns: prefs.useAccountNumbers ? '200px 110px minmax(0, 1fr)' : '210px minmax(0, 1fr)' }}>
          <Field label="Account type" help={typeInfo(f.type).text}>
            <Select
              name="type"
              value={f.type}
              disabled={special}
              title={special ? 'The type of this account cannot be changed.' : undefined}
              onChange={(v) => changeType(v as AccountType)}
              options={(ALL_TYPES.includes(f.type) ? ALL_TYPES : [...ALL_TYPES, f.type]).map((t) => ({ value: t, label: t }))}
              aria-label="Account type"
            />
          </Field>
          {prefs.useAccountNumbers && (
            <Field label="Number">
              <TextField name="number" value={f.number} onChange={(v) => set({ number: v })} aria-label="Account number" />
            </Field>
          )}
          <Field label="Account name" required>
            <TextField name="name" value={f.name} onChange={(v) => set({ name: v })} autoFocus aria-label="Account name" maxLength={100} />
          </Field>
        </div>
        <div className="fl-sub-row">
          <Checkbox checked={f.isSub} onChange={(v) => set({ isSub: v, ...(v ? {} : { parentId: null }) })} label="Subaccount of" />
          <div className="fl-sub-picker">
            <AccountPicker
              name="parentId"
              aria-label="Parent account"
              types={[f.type]}
              excludeIds={excluded}
              addNew={false}
              showRecent={false}
              disabled={!f.isSub}
              placeholder={f.isSub ? `Choose a ${f.type} account` : ''}
              value={f.isSub ? f.parentId : null}
              onChange={(id) => set({ parentId: id, isSub: f.isSub || id !== null })}
            />
          </div>
        </div>
        <Field label="Description">
          <TextField name="description" value={f.description} onChange={(v) => set({ description: v })} aria-label="Description" />
        </Field>
        {bank && (
          <div className="fl-grid fl-g2">
            <Field label="Bank account no.">
              <TextField name="bankAcctNumber" value={f.bankAcctNumber} onChange={(v) => set({ bankAcctNumber: v })} aria-label="Bank account number" />
            </Field>
            <Field label="Routing number">
              <TextField name="routingNumber" value={f.routingNumber} onChange={(v) => set({ routingNumber: v })} aria-label="Routing number" />
            </Field>
          </div>
        )}
        {card && (
          <Field label="Credit card no.">
            <TextField name="bankAcctNumber" value={f.bankAcctNumber} onChange={(v) => set({ bankAcctNumber: v })} aria-label="Credit card number" />
          </Field>
        )}
        <div className="fl-grid fl-g2">
          <Field label="Tax-line mapping" help="The line of your income tax return this account's total goes to. Your accountant can use it to prepare the return.">
            <Select name="taxLine" value={f.taxLine} onChange={(v) => set({ taxLine: v })} options={taxChoices} aria-label="Tax-line mapping" />
          </Field>
          <Field label="Note">
            <TextField name="note" value={f.note} onChange={(v) => set({ note: v })} aria-label="Note" />
          </Field>
        </div>
        {showOpening && (
          <div className="fl-section">
            <div className="fl-section-title">
              Opening balance <span className="fl-note">(optional)</span>
            </div>
            <div className="fl-grid fl-g2">
              <Field
                label={openingLabel}
                help={
                  bank
                    ? 'The ending balance of the last bank statement before you start tracking this account here.'
                    : 'What the account held on the day you start tracking it here. SerieX Books records it against Opening Balance Equity.'
                }
              >
                <MoneyField name="openingBalance" value={f.openingBalance} onChange={(v) => set({ openingBalance: v ?? 0 })} aria-label={openingLabel} />
              </Field>
              <Field label={bank ? 'Statement ending date' : 'As of'}>
                <DateField name="openingDate" value={f.openingDate} onChange={(v) => set({ openingDate: v })} aria-label="Opening balance date" />
              </Field>
            </div>
          </div>
        )}
      </div>
    </EditDialog>
  );
}

// Edit > Preferences: the preference categories (Accounting, Bills, Checking, Workspace,
// General, Items and Inventory, Reminders, Reports, Sales, Sales Tax), one
// section each, mapping the company preferences (store.Prefs) that the app acts on (no
// controls that do nothing). props.section opens a category.
// Company-wide preferences are read-only for users who are not administrators. Everybody can change
// the personal preferences the server accepts from any user (the per-user "My Preferences"): Workspace,
// automatic recall (General), the Reminders list on open and the default accounts (Checking).
// When sales tax is on, "Your most common sales tax" is required; its picker can add a new Sales
// Tax Item (name, rate, tax agency) on the spot.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BarChart3, Bell, Calculator, Landmark, Lock, Monitor, Package, Percent, Receipt, Settings2, Users } from 'lucide-react';
import { api } from '@/api/client';
import { invalidateAll, queryClient, useItems, usePrefs } from '@/api/hooks';
import { INVOICE_TEMPLATE_OPTIONS, type ID, type Item, type Prefs } from '@/api/types';
import {
  AccountPicker,
  Button,
  Checkbox,
  ComboBox,
  EditDialog,
  ErrorBanner,
  Field,
  FormErrorsProvider,
  NamePicker,
  NumberField,
  RadioGroup,
  Select,
  ShipViaPicker,
  Spinner,
  TextField,
  confirmBox,
  newItemRecord,
  showDialog,
  toast,
  useFormErrors,
  type ComboColumn,
  type EditDialogSection,
} from '@/components';
import { HelpTip } from '@/components/HelpTip';
import { useOptionalWindow } from '@/windows/WindowContext';
import { openWindow } from '@/windows/windowStore';
import { useSession } from '@/state/session';
import { useView } from '@/state/view';
import { fmtDate, fmtPercent } from '@/util/format';
import { ADMIN_ONLY_NOTE, SALES_TAX_FREQUENCIES, useClosingDate, useIsAdmin } from './shared';
import './company.css';

export interface PreferencesDialogProps {
  /** Category to open: accounting, bills, checking, desktop, general, items, reminders, reports, sales, salesTax. */
  section?: string;
}

const SECTIONS: EditDialogSection[] = [
  {
    key: 'accounting',
    label: 'Accounting',
    icon: Calculator,
    fields: [
      'useAccountNumbers',
      'showLowestSubaccountOnly',
      'useClassTracking',
      'autoAssignJournalNumbers',
      'datePastWarnDays',
      'dateFutureWarnDays',
    ],
  },
  { key: 'bills', label: 'Bills', icon: Receipt, fields: ['billsDueDays', 'warnDuplicateBillNumbers', 'autoUseVendorDiscounts', 'vendorDiscountAccountId'] },
  {
    key: 'checking',
    label: 'Checking',
    icon: Landmark,
    fields: [
      'warnDuplicateCheckNumbers',
      'defaultCheckAccountId',
      'defaultBillPayAccountId',
      'defaultDepositAccountId',
    ],
  },
  { key: 'desktop', label: 'Workspace', icon: Monitor, fields: ['windowMode', 'iconBar', 'showHomePageOnOpen'] },
  { key: 'general', label: 'General', icon: Settings2, fields: ['autoRecall'] },
  {
    key: 'items',
    label: 'Items and Inventory',
    icon: Package,
    fields: ['inventoryEnabled', 'purchaseOrdersEnabled', 'warnDuplicatePONumbers', 'warnNotEnoughInventory'],
  },
  { key: 'reminders', label: 'Reminders', icon: Bell, fields: ['showRemindersOnOpen'] },
  { key: 'reports', label: 'Reports', icon: BarChart3, fields: ['reportBasis', 'agingFrom', 'reportAccountDisplay'] },
  {
    key: 'sales',
    label: 'Sales',
    icon: Users,
    fields: [
      'estimatesEnabled',
      'warnDuplicateInvoiceNumbers',
      'useUndepositedFunds',
      'autoApplyPayments',
      'autoCalcPayments',
      'customerDiscountAccountId',
      'defaultShipViaId',
      'defaultFob',
      'defaultInvoiceTemplate',
    ],
  },
  {
    key: 'salesTax',
    label: 'Sales Tax',
    icon: Percent,
    fields: ['salesTaxEnabled', 'defaultSalesTaxItemId', 'salesTaxBasis', 'salesTaxFrequency'],
  },
];

/** Preferences any user may change (the server refuses other changes from users who are not administrators). */
const PERSONAL_KEYS = [
  'windowMode',
  'iconBar',
  'showHomePageOnOpen',
  'autoRecall',
  'showRemindersOnOpen',
  'defaultCheckAccountId',
  'defaultBillPayAccountId',
  'defaultDepositAccountId',
] as const satisfies readonly (keyof Prefs)[];

/** Accepts a few aliases for props.section (e.g. "sales tax", "salestax"). */
function sectionKey(s: string | undefined): string {
  if (!s) return 'accounting';
  const k = s.replace(/[^a-z]/gi, '').toLowerCase();
  const found = SECTIONS.find(
    (x) =>
      x.key.toLowerCase() === k ||
      String(x.label)
        .replace(/[^a-z]/gi, '')
        .toLowerCase() === k,
  );
  if (found) return found.key;
  if (k.startsWith('item') || k.startsWith('inventory')) return 'items';
  if (k.startsWith('sales') && k.includes('tax')) return 'salesTax';
  if (k.startsWith('sales') || k.startsWith('customer')) return 'sales';
  if (k.startsWith('report')) return 'reports';
  if (k.startsWith('desktop') || k.startsWith('view')) return 'desktop';
  return 'accounting';
}

export default function PreferencesDialog({ section }: PreferencesDialogProps) {
  const win = useOptionalWindow();
  const q = usePrefs();
  const fe = useFormErrors();
  const [p, setP] = useState<Prefs | null>(null);
  const [base, setBase] = useState<Prefs | null>(null);
  const [tab, setTab] = useState(() => sectionKey(section));
  const closing = useClosingDate();
  const admin = useIsAdmin();
  /** Not an administrator: company-wide preferences are shown but cannot be changed. */
  const ro = admin === false;

  useEffect(() => {
    if (section) setTab(sectionKey(section));
  }, [section]);

  useEffect(() => {
    if (q.data && !p) {
      // the workspace and navigation follow what is on screen now (they can also be changed from the View menu)
      const v = useView.getState();
      const start = { ...q.data, windowMode: v.windowMode, iconBar: v.iconBar };
      setP(start);
      setBase(start);
    }
  }, [q.data, p]);

  const dirty = useMemo(() => !!p && !!base && JSON.stringify(p) !== JSON.stringify(base), [p, base]);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  useEffect(() => {
    win?.setDirty(dirty);
  }, [dirty]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!win) return;
    win.setBeforeClose(async () => (dirtyRef.current ? confirmBox('Discard the changes you made to your preferences?', 'Preferences') : true));
    return () => win.setBeforeClose(null);
  }, [win?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!p || admin === undefined) {
    return (
      <div className="cx-dlg" style={{ display: 'grid', placeItems: 'center' }}>
        {q.error ? <span className="cx-muted">{(q.error as Error).message}</span> : <Spinner label="Loading preferences..." />}
      </div>
    );
  }

  const set = (patch: Partial<Prefs>) => setP((cur) => (cur ? { ...cur, ...patch } : cur));
  const chk = (key: keyof Prefs, label: ReactNode, opts: { help?: string; disabled?: boolean; hint?: ReactNode } = {}) => (
    <div>
      <div className="cx-row" style={{ gap: 4 }}>
        <Checkbox name={key} checked={!!p[key]} disabled={opts.disabled} onChange={(v) => set({ [key]: v } as Partial<Prefs>)} label={label} />
        {opts.help && <HelpTip {...(opts.help.includes(' ') && opts.help.length > 30 ? { text: opts.help } : { term: opts.help })} />}
      </div>
      {opts.hint && (
        <div className="cx-hint" style={{ marginLeft: 24 }}>
          {opts.hint}
        </div>
      )}
    </div>
  );

  const save = async (): Promise<boolean> => {
    fe.clearAll();
    if (!ro && p.salesTaxEnabled && !p.defaultSalesTaxItemId) {
      fe.setErrors({
        defaultSalesTaxItemId: 'Choose the sales tax you charge most often, or add it. New invoices and sales receipts charge this tax.',
      });
      return false;
    }
    if (p.datePastWarnDays < 0 || p.dateFutureWarnDays < 0) {
      fe.setErrors({ [p.datePastWarnDays < 0 ? 'datePastWarnDays' : 'dateFutureWarnDays']: 'Enter a number of days of 0 or more.' });
      return false;
    }
    try {
      // not an administrator: only the personal preferences are sent
      const body: Partial<Prefs> = ro ? Object.fromEntries(PERSONAL_KEYS.map((k) => [k, p[k]])) : p;
      const saved = await api.put<Prefs>('/prefs', body);
      queryClient.setQueryData(['prefs'], saved);
      const v = useView.getState();
      if (saved.windowMode !== v.windowMode) v.setWindowMode(saved.windowMode);
      if (saved.iconBar !== v.iconBar) v.setIconBar(saved.iconBar);
      setBase(saved);
      setP(saved);
      dirtyRef.current = false;
      await useSession.getState().reloadCompany();
      void invalidateAll();
      toast('Preferences saved');
      await win?.close(true);
      return true;
    } catch (e) {
      fe.fromError(e);
      return false;
    }
  };

  const days = (key: 'datePastWarnDays' | 'dateFutureWarnDays', def: number, before: string, after: string) => (
    <div className="cx-row" style={{ gap: 6, flexWrap: 'wrap' }}>
      <Checkbox checked={p[key] > 0} onChange={(v) => set({ [key]: v ? def : 0 } as Partial<Prefs>)} label={before} />
      <NumberField
        name={key}
        value={p[key] || null}
        width={64}
        decimals={0}
        disabled={p[key] <= 0}
        onChange={(v) => set({ [key]: Math.max(0, Math.round(v ?? 0)) } as Partial<Prefs>)}
        aria-label={before}
      />
      <span>{after}</span>
    </div>
  );

  return (
    <EditDialog
      title="Preferences"
      errors={fe}
      sections={SECTIONS}
      section={tab}
      onSectionChange={setTab}
      onOk={save}
      okLabel="Save and close"
      navWidth={186}
      top={
        ro ? (
          <div className="cx-note cx-info cx-small" role="note">
            <Lock size={15} />
            <div>
              {ADMIN_ONLY_NOTE} You can still change your own preferences: Workspace, automatic recall (General), the Reminders
              list and the default accounts under Checking.
            </div>
          </div>
        ) : undefined
      }
      footerLeft={<span className="cx-muted cx-small">These preferences apply to everyone who uses this company file.</span>}
    >
      {tab === 'accounting' && (
        <Ro disabled={ro}>
          <div className="cx-checks" style={{ gap: 10 }}>
            <div className="cx-section-title">Accounts</div>
            {chk('useAccountNumbers', 'Use account numbers', { hint: 'Show an account number before each account name in lists, forms and reports.' })}
            <div className="cx-sub">{chk('showLowestSubaccountOnly', 'Show only the last subaccount name', { disabled: !p.useAccountNumbers })}</div>
            <div className="cx-section-title">Class tracking</div>
            {chk('useClassTracking', 'Track classes on transactions', { help: 'Class' })}
            <div className="cx-section-title">Journal entries</div>
            {chk('autoAssignJournalNumbers', 'Number journal entries for me')}
            <div className="cx-section-title">Date warnings</div>
            {days('datePastWarnDays', 90, 'Warn me about dates more than', 'days back')}
            {days('dateFutureWarnDays', 30, 'Warn me about dates more than', 'days ahead')}
            <div className="cx-section-title">Closing date</div>
            <div className="cx-row" style={{ gap: 12 }}>
              <span>
                {closing.data?.closingDate ? (
                  <>
                    Books are closed through <b>{fmtDate(closing.data.closingDate)}</b>
                    {closing.data.hasPassword ? ' (password protected).' : '.'}
                  </>
                ) : (
                  'No closing date is set.'
                )}
              </span>
              <Button size="sm" label="Set Date/Password..." onClick={() => openWindow('closingDate')} />
            </div>
          </div>
        </Ro>
      )}

      {tab === 'bills' && (
        <Ro disabled={ro}>
          <div className="cx-checks" style={{ gap: 12 }}>
            <div className="cx-section-title">Entering bills</div>
            <div className="cx-row" style={{ gap: 6 }}>
              <span>Bills are due</span>
              <NumberField
                name="billsDueDays"
                value={p.billsDueDays}
                width={64}
                decimals={0}
                nullable={false}
                onChange={(v) => set({ billsDueDays: Math.max(0, Math.round(v ?? 0)) })}
                aria-label="Bills are due days after receipt"
              />
              <span>days after receipt (when the vendor has no terms)</span>
            </div>
            {chk('warnDuplicateBillNumbers', 'Warn about duplicate bill numbers from the same vendor')}
            <div className="cx-section-title">Paying bills</div>
            {chk('autoUseVendorDiscounts', 'Take early payment discounts for me', {
              hint: 'Pay Bills takes the early payment discount of the vendor terms when you pay in time.',
            })}
            <Field label="Default discount account" width={320}>
              <AccountPicker
                name="vendorDiscountAccountId"
                value={p.vendorDiscountAccountId}
                onChange={(id) => set({ vendorDiscountAccountId: id })}
                quickCreate={false}
              />
            </Field>
          </div>
        </Ro>
      )}

      {tab === 'checking' && (
        <div className="cx-checks" style={{ gap: 12 }}>
          <Ro disabled={ro}>{chk('warnDuplicateCheckNumbers', 'Warn about duplicate check numbers')}</Ro>
          <div className="cx-section-title">Default accounts to use</div>
          <Field label="Open the Write Checks form with" width={320}>
            <AccountPicker
              name="defaultCheckAccountId"
              types={['Bank']}
              value={p.defaultCheckAccountId}
              onChange={(id) => set({ defaultCheckAccountId: id })}
              quickCreate={false}
              placeholder="Last account used"
            />
          </Field>
          <Field label="Open the Pay Bills form with" width={320}>
            <AccountPicker
              name="defaultBillPayAccountId"
              types={['Bank', 'Credit Card']}
              value={p.defaultBillPayAccountId}
              onChange={(id) => set({ defaultBillPayAccountId: id })}
              quickCreate={false}
              placeholder="Last account used"
            />
          </Field>
          <Field label="Open the Make Deposits form with" width={320}>
            <AccountPicker
              name="defaultDepositAccountId"
              types={['Bank', 'Other Current Asset']}
              value={p.defaultDepositAccountId}
              onChange={(id) => set({ defaultDepositAccountId: id })}
              quickCreate={false}
              placeholder="Last account used"
            />
          </Field>
        </div>
      )}

      {tab === 'desktop' && (
        <div className="cx-checks" style={{ gap: 12 }}>
          <div className="cx-section-title">Workspace</div>
          <RadioGroup
            name="windowMode"
            value={p.windowMode}
            onChange={(v) => set({ windowMode: v })}
            options={[
              { value: 'one', label: 'Tabs: each window is a full page with a tab at the top (recommended)' },
              { value: 'multiple', label: 'Floating windows: windows you can move, resize and arrange, like a classic desktop program' },
            ]}
          />
          <div className="cx-section-title">Navigation</div>
          <RadioGroup
            name="iconBar"
            value={p.iconBar}
            onChange={(v) => set({ iconBar: v })}
            options={[
              { value: 'left', label: 'Left navigation bar' },
              { value: 'top', label: 'Toolbar at the top' },
              { value: 'hidden', label: 'Hide the navigation (use the menus)' },
            ]}
          />
          <div className="cx-section-title">When a company file opens</div>
          {chk('showHomePageOnOpen', 'Show the Home page')}
        </div>
      )}

      {tab === 'general' && (
        <div className="cx-checks" style={{ gap: 12 }}>
          {chk('autoRecall', "Fill in a payee's last accounts and amounts", {
            hint: 'When you choose a vendor or payee on a check, bill or credit card charge, the accounts and amounts of their last transaction are filled in for you.',
          })}
          <div className="cx-note" style={{ marginTop: 6 }}>
            Date warnings, account numbers and class tracking are under{' '}
            <button type="button" className="sx-linkbtn" onClick={() => setTab('accounting')}>
              Accounting
            </button>
            . The workspace and navigation are under{' '}
            <button type="button" className="sx-linkbtn" onClick={() => setTab('desktop')}>
              Workspace
            </button>
            .
          </div>
        </div>
      )}

      {tab === 'items' && (
        <Ro disabled={ro}>
          <div className="cx-checks" style={{ gap: 12 }}>
            {chk('inventoryEnabled', 'Track inventory', { hint: 'Track quantity on hand and average cost of inventory parts, and adjust quantities.' })}
            {chk('purchaseOrdersEnabled', 'Use purchase orders', { hint: 'Create purchase orders and receive items against them.' })}
            <div className="cx-sub cx-checks">
              {chk('warnDuplicatePONumbers', 'Warn about duplicate purchase order numbers', { disabled: !p.purchaseOrdersEnabled })}
            </div>
            {chk('warnNotEnoughInventory', 'Warn me when a sale needs more than the quantity on hand', { disabled: !p.inventoryEnabled })}
          </div>
        </Ro>
      )}

      {tab === 'reminders' && (
        <div className="cx-checks" style={{ gap: 12 }}>
          {chk('showRemindersOnOpen', 'Show the Reminders list when opening a company file')}
          <div className="cx-hint">
            Reminders list overdue invoices, bills to pay, money to deposit, checks and invoices to print, inventory to reorder, memorized transactions due,
            open purchase orders, sales tax due and your to dos. The Home page shows them too.
          </div>
        </div>
      )}

      {tab === 'reports' && (
        <Ro disabled={ro}>
          <div className="cx-checks" style={{ gap: 12 }}>
            <div className="cx-section-title">Summary reports basis</div>
            <RadioGroup
              name="reportBasis"
              row
              value={p.reportBasis}
              onChange={(v) => set({ reportBasis: v })}
              options={[
                { value: 'accrual', label: 'Accrual' },
                { value: 'cash', label: 'Cash' },
              ]}
            />
            <div className="cx-hint" style={{ marginTop: -6 }}>
              Accrual counts income when you invoice and expenses when you enter bills. Cash counts them when money changes hands.
            </div>
            <div className="cx-section-title">Aging reports</div>
            <RadioGroup
              name="agingFrom"
              value={p.agingFrom}
              onChange={(v) => set({ agingFrom: v })}
              options={[
                { value: 'due', label: 'Age from due date' },
                { value: 'transaction', label: 'Age from transaction date' },
              ]}
            />
            <div className="cx-section-title">Reports show accounts by</div>
            <RadioGroup
              name="reportAccountDisplay"
              value={p.reportAccountDisplay}
              onChange={(v) => set({ reportAccountDisplay: v })}
              options={[
                { value: 'name', label: 'Name only' },
                { value: 'description', label: 'Description only' },
                { value: 'both', label: 'Name and description' },
              ]}
            />
          </div>
        </Ro>
      )}

      {tab === 'sales' && (
        <Ro disabled={ro}>
          <div className="cx-checks" style={{ gap: 11 }}>
            <div className="cx-section-title">Sales forms</div>
            <div className="cx-row" style={{ gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <Field label="Usual invoice layout" width={210}>
                <Select
                  name="defaultInvoiceTemplate"
                  value={p.defaultInvoiceTemplate}
                  onChange={(v) => set({ defaultInvoiceTemplate: v as Prefs['defaultInvoiceTemplate'] })}
                  options={INVOICE_TEMPLATE_OPTIONS}
                />
              </Field>
              <Field label="Usual shipping method" width={190}>
                <ShipViaPicker name="defaultShipViaId" value={p.defaultShipViaId} onChange={(id) => set({ defaultShipViaId: id })} />
              </Field>
              <Field label="Usual FOB" width={120} help="FOB">
                <TextField name="defaultFob" value={p.defaultFob} onChange={(v) => set({ defaultFob: v })} maxLength={13} />
              </Field>
            </div>
            {chk('warnDuplicateInvoiceNumbers', 'Warn about duplicate invoice numbers')}
            {chk('estimatesEnabled', 'Use estimates', { hint: 'Create estimates and turn them into invoices.' })}
            <div className="cx-section-title">Receive payments</div>
            {chk('autoApplyPayments', 'Apply payments to open invoices for me', {
              hint: 'The amount received is applied to the open invoices (exact match first, else the oldest).',
            })}
            {chk('autoCalcPayments', 'Add up the invoices I check into the payment amount', { hint: 'Checking an invoice adds its amount due to the payment amount.' })}
            {chk('useUndepositedFunds', 'Keep payments in Undeposited Funds until I deposit them', { help: 'Undeposited Funds' })}
            <div className="cx-section-title">Customer discounts</div>
            <Field
              label="Default account for customer discounts"
              width={320}
              hint="Receive Payments posts early payment discounts to this account."
            >
              <AccountPicker
                name="customerDiscountAccountId"
                value={p.customerDiscountAccountId}
                onChange={(id) => set({ customerDiscountAccountId: id })}
                quickCreate={false}
              />
            </Field>
          </div>
        </Ro>
      )}

      {tab === 'salesTax' && (
        <Ro disabled={ro}>
          <div className="cx-checks" style={{ gap: 12 }}>
            <div className="cx-section-title">Do you charge sales tax?</div>
            <RadioGroup
              name="salesTaxEnabled"
              row
              value={p.salesTaxEnabled ? 'yes' : 'no'}
              onChange={(v) => set({ salesTaxEnabled: v === 'yes' })}
              options={[
                { value: 'yes', label: 'Yes' },
                { value: 'no', label: 'No' },
              ]}
            />
            <Field
              label="Your most common sales tax"
              help="Sales tax item"
              width={320}
              required={p.salesTaxEnabled}
              hint="New invoices and sales receipts charge this tax. Type a new name to add a sales tax with its rate and tax agency."
            >
              <SalesTaxItemPicker
                value={p.defaultSalesTaxItemId}
                onChange={(id) => set({ defaultSalesTaxItemId: id })}
                disabled={!p.salesTaxEnabled || ro}
              />
            </Field>
            <div className="cx-section-title">When do you owe sales tax?</div>
            <RadioGroup
              name="salesTaxBasis"
              value={p.salesTaxBasis}
              onChange={(v) => set({ salesTaxBasis: v })}
              disabled={!p.salesTaxEnabled}
              options={[
                { value: 'accrual', label: 'As of invoice date (accrual basis)' },
                { value: 'cash', label: 'Upon receipt of payment (cash basis)' },
              ]}
            />
            <div className="cx-section-title">When do you pay sales tax?</div>
            <RadioGroup
              name="salesTaxFrequency"
              row
              value={p.salesTaxFrequency}
              onChange={(v) => set({ salesTaxFrequency: v })}
              disabled={!p.salesTaxEnabled}
              options={SALES_TAX_FREQUENCIES}
            />
          </div>
        </Ro>
      )}
    </EditDialog>
  );
}

/** Company-wide settings: shown disabled to users who are not administrators. */
function Ro({ disabled, children }: { disabled: boolean; children: ReactNode }) {
  return (
    <fieldset className="cx-fieldset" disabled={disabled}>
      {children}
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// "Your most common sales tax": Sales Tax Items and Groups, with quick create

const TAX_COLUMNS: ComboColumn<Item>[] = [
  { width: 110, render: (i) => (i.type === 'Sales Tax Group' ? 'Tax group' : 'Tax item'), className: 'sx-muted', label: 'Type' },
  { width: 70, align: 'right', render: (i) => fmtPercent(i.taxRate), label: 'Rate' },
];

/** Picks a Sales Tax Item or Group; a name that is not in the list adds a new sales tax. */
function SalesTaxItemPicker({ value, onChange, disabled }: { value: ID | null; onChange: (id: ID | null) => void; disabled?: boolean }) {
  const { data } = useItems({ active: 'all' });
  const list = useMemo(() => (data ?? []).filter((i) => i.type === 'Sales Tax Item' || i.type === 'Sales Tax Group'), [data]);
  const add = async (typed: string) => {
    const created = await showDialog<Item | null>({
      title: 'New Sales Tax',
      width: 460,
      cancelValue: null,
      render: (close) => <NewSalesTaxForm initialName={typed} taxItems={list} onDone={close} />,
    });
    if (created) onChange(created.id);
  };
  return (
    <ComboBox<Item>
      name="defaultSalesTaxItemId"
      items={list}
      value={value}
      onChange={(k) => onChange(k === null ? null : Number(k))}
      getKey={(i) => i.id}
      getLabel={(i) => i.name}
      getSearchText={(i) => i.description}
      isInactive={(i) => !i.active}
      columns={TAX_COLUMNS}
      listWidth={360}
      onAddNew={(t) => void add(t)}
      addNewLabel="Add a sales tax"
      onQuickAdd={(t) => void add(t)}
      quickAddLabel={(t) => `Add "${t}" as a new sales tax`}
      disabled={disabled}
      placeholder={list.length ? 'Choose a sales tax' : 'Type a name to add your sales tax'}
      aria-label="Your most common sales tax"
    />
  );
}

/** Quick create of a Sales Tax Item: name, rate and tax agency (a vendor, which can be added too). */
function NewSalesTaxForm({ initialName, taxItems, onDone }: { initialName: string; taxItems: Item[]; onDone: (item: Item | null) => void }) {
  const fe = useFormErrors();
  const [name, setName] = useState(initialName);
  const [rate, setRate] = useState<number | null>(null);
  // the agency of the existing sales taxes is the likely one
  const [agencyId, setAgencyId] = useState<ID | null>(() => taxItems.find((i) => i.type === 'Sales Tax Item' && i.taxAgencyId)?.taxAgencyId ?? null);
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLFormElement>(null);

  const submit = async () => {
    fe.clearAll();
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = 'Enter a name for the sales tax, for example "CA Sales Tax".';
    if (rate === null || !(rate > 0) || rate > 100) errs.taxRate = 'Enter the tax rate as a percentage, for example 7.25.';
    if (!agencyId) errs.taxAgencyId = 'Choose the tax agency you pay this tax to, or type its name to add it as a vendor.';
    if (Object.keys(errs).length) {
      fe.setErrors(errs);
      return;
    }
    setBusy(true);
    try {
      const item = await api.post<Item>(
        '/items',
        newItemRecord('Sales Tax Item', name.trim(), { description: name.trim(), taxRate: rate ?? 0, taxAgencyId: agencyId }),
      );
      await queryClient.invalidateQueries({ queryKey: ['items'] });
      toast(`Sales tax ${item.name} added`);
      onDone(item);
    } catch (e) {
      fe.fromError(e);
      setBusy(false);
    }
  };

  return (
    <FormErrorsProvider value={fe}>
      <form
        ref={root}
        onSubmit={(e) => {
          e.preventDefault();
          // the vendor quick create popover is a form too: its submit bubbles here through React
          if (e.target !== e.currentTarget) return;
          if (!busy) void submit();
        }}
      >
        <div className="cx-stack" style={{ gap: 10, padding: '16px 20px 14px' }}>
          {fe.message && <ErrorBanner message={fe.message} root={root.current} onDismiss={() => fe.setMessage(null)} />}
          <div className="cx-row" style={{ gap: 12, alignItems: 'flex-start' }}>
            <Field label="Sales tax name" required width={230}>
              <TextField name="name" value={name} onChange={setName} autoFocus />
            </Field>
            <Field label="Tax rate (%)" required width={150} hint="For example 7.25">
              <NumberField name="taxRate" value={rate} decimals={4} onChange={setRate} aria-label="Tax rate in percent" />
            </Field>
          </div>
          <Field label="Tax agency" required width={380} hint="The vendor you pay this tax to. Type a new name to add the agency.">
            <NamePicker
              name="taxAgencyId"
              kinds={['vendor']}
              value={agencyId}
              onChange={(id) => {
                setAgencyId(id);
                if (id) fe.clear('taxAgencyId');
              }}
              aria-label="Tax agency"
            />
          </Field>
        </div>
        <div className="sx-dlg-buttons">
          <button type="submit" className="sx-btn sx-btn-primary" disabled={busy}>
            OK
          </button>
          <button type="button" className="sx-btn sx-btn-secondary" onClick={() => onDone(null)}>
            Cancel
          </button>
        </div>
      </form>
    </FormErrorsProvider>
  );
}

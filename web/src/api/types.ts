// JSON contract with the server. Mirrors server/internal/model/model.go field
// for field. Money is dollars (number, 2 decimals). Dates are "YYYY-MM-DD".
// Fields commented (ro) are computed by the server and ignored on input.

export type ID = number;

// ---------------------------------------------------------------------------
// Account types

export const ACCOUNT_TYPES = [
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
  'Non-Posting',
] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const DEBIT_NORMAL_TYPES: AccountType[] = [
  'Bank', 'Accounts Receivable', 'Other Current Asset', 'Fixed Asset', 'Other Asset',
  'Cost of Goods Sold', 'Expense', 'Other Expense',
];
export const BALANCE_SHEET_TYPES: AccountType[] = [
  'Bank', 'Accounts Receivable', 'Other Current Asset', 'Fixed Asset', 'Other Asset',
  'Accounts Payable', 'Credit Card', 'Other Current Liability', 'Long Term Liability', 'Equity',
];
export const PROFIT_LOSS_TYPES: AccountType[] = ['Income', 'Cost of Goods Sold', 'Expense', 'Other Income', 'Other Expense'];

export type SpecialAccount =
  | ''
  | 'AccountsReceivable'
  | 'AccountsPayable'
  | 'UndepositedFunds'
  | 'OpeningBalanceEquity'
  | 'RetainedEarnings'
  | 'SalesTaxPayable'
  | 'InventoryAsset'
  | 'CostOfGoodsSold'
  | 'UncategorizedIncome'
  | 'UncategorizedExpenses'
  | 'AskMyAccountant';

// ---------------------------------------------------------------------------
// Transaction types

export type TxnType =
  | 'INV'
  | 'SALESRCPT'
  | 'PMT'
  | 'CREDMEM'
  | 'STMTCHG'
  | 'EST'
  | 'DEP'
  | 'CHK'
  | 'REFUND'
  | 'BILL'
  | 'BILLCRED'
  | 'BILLPMT'
  | 'ITEMRCPT'
  | 'PURCHORD'
  | 'CCCHARGE'
  | 'CCCREDIT'
  | 'TRANSFER'
  | 'GENJRNL'
  | 'INVADJ'
  | 'TAXPMT';

export const TXN_TYPE_LABELS: Record<TxnType, string> = {
  INV: 'Invoice',
  SALESRCPT: 'Sales Receipt',
  PMT: 'Payment',
  CREDMEM: 'Credit Memo',
  STMTCHG: 'Statement Charge',
  EST: 'Estimate',
  DEP: 'Deposit',
  CHK: 'Check',
  REFUND: 'Refund',
  BILL: 'Bill',
  BILLCRED: 'Credit',
  BILLPMT: 'Bill Pmt -Check',
  ITEMRCPT: 'Item Receipt',
  PURCHORD: 'Purchase Order',
  CCCHARGE: 'Credit Card Charge',
  CCCREDIT: 'Credit Card Credit',
  TRANSFER: 'Transfer',
  GENJRNL: 'General Journal',
  INVADJ: 'Inventory Adjust',
  TAXPMT: 'Sales Tax Payment',
};

// ---------------------------------------------------------------------------
// Item types

/**
 * Invoice layouts. The stored values (prefs.defaultInvoiceTemplate, txn.template) stay as they are;
 * only the labels are shown: Standard (with shipping fields), Services (no shipping fields) and
 * Services with Dates (a service date column).
 */
export const INVOICE_TEMPLATE_OPTIONS: { value: 'Product Invoice' | 'Service Invoice' | 'Professional Invoice'; label: string }[] = [
  { value: 'Product Invoice', label: 'Standard' },
  { value: 'Service Invoice', label: 'Services' },
  { value: 'Professional Invoice', label: 'Services with Dates' },
];

export const ITEM_TYPES = [
  'Service',
  'Inventory Part',
  'Non-inventory Part',
  'Other Charge',
  'Subtotal',
  'Group',
  'Discount',
  'Payment',
  'Sales Tax Item',
  'Sales Tax Group',
] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

// ---------------------------------------------------------------------------
// Simple lists

export type ListName =
  | 'class'
  | 'customer_type'
  | 'vendor_type'
  | 'job_type'
  | 'terms'
  | 'payment_method'
  | 'ship_via'
  | 'customer_message'
  | 'sales_rep';

export const LIST_TITLES: Record<ListName, string> = {
  class: 'Class',
  customer_type: 'Customer Type',
  vendor_type: 'Vendor Type',
  job_type: 'Job Type',
  terms: 'Terms',
  payment_method: 'Payment Method',
  ship_via: 'Shipping Method',
  customer_message: 'Customer Message',
  sales_rep: 'Sales Rep',
};

export interface TermsData {
  dateDriven?: boolean;
  netDays?: number;
  discountPct?: number;
  discountDays?: number;
  dueDay?: number;
  discountDay?: number;
  dueNextMonthDays?: number;
}

export interface ListEntry {
  id: ID;
  list: ListName;
  name: string;
  parentId: ID | null;
  fullName: string; // (ro)
  level: number; // (ro)
  active: boolean;
  data: Record<string, any>; // TermsData for terms, {type} for payment_method, {initials,nameId} for sales_rep
  updatedAt?: string; // (ro) send it back unchanged (body on PUT, If-Match header or ?updatedAt= on DELETE): a save based on an older copy is refused (409 conflict)
}

// ---------------------------------------------------------------------------
// Accounts

export interface Account {
  id: ID;
  name: string;
  number: string;
  type: AccountType;
  parentId: ID | null;
  fullName: string; // (ro)
  level: number; // (ro)
  description: string;
  note: string;
  bankAcctNumber: string;
  routingNumber: string;
  taxLine: string;
  special: SpecialAccount; // (ro)
  active: boolean;
  balance: number; // (ro) natural sign, incl. subaccounts
  ownBalance: number; // (ro)
  hasTxns: boolean; // (ro)
  openingBalance?: number; // create only
  openingDate?: string; // create only
  updatedAt?: string; // (ro) send it back unchanged: a save based on an older copy is refused (409 conflict)
}

// ---------------------------------------------------------------------------
// Names

export type NameKind = 'customer' | 'vendor' | 'other';

export interface Address {
  line1: string;
  line2: string;
  line3: string;
  city: string;
  state: string;
  zip: string;
  country: string;
}

export interface Name {
  id: ID;
  kind: NameKind;
  name: string;
  parentId: ID | null;
  fullName: string; // (ro) "Customer:Job"
  level: number; // (ro)
  companyName: string;
  salutation: string;
  firstName: string;
  middleName: string;
  lastName: string;
  jobTitle: string;
  phone: string;
  altPhone: string;
  mobile: string;
  fax: string;
  email: string;
  ccEmail: string;
  website: string;
  billAddress: Address;
  shipAddress: Address;
  accountNumber: string;
  termsId: ID | null;
  creditLimit: number | null;
  typeId: ID | null;
  repId: ID | null;
  paymentMethodId: ID | null;
  taxable: boolean;
  taxItemId: ID | null;
  resaleNumber: string;
  printOnCheckAs: string;
  taxIdent: string;
  is1099: boolean;
  prefillAccountIds: ID[];
  jobStatus: '' | 'Pending' | 'Awarded' | 'In progress' | 'Closed' | 'Not awarded';
  jobStartDate: string;
  jobProjectedEnd: string;
  jobEndDate: string;
  jobDescription: string;
  jobTypeId: ID | null;
  notes: string;
  active: boolean;
  balance: number; // (ro)
  ownBalance: number; // (ro)
  hasTxns: boolean; // (ro)
  openingBalance?: number; // create only
  openingDate?: string; // create only
  updatedAt?: string; // (ro) send it back unchanged: a save based on an older copy is refused (409 conflict)
}

// ---------------------------------------------------------------------------
// Items

export interface ItemGroupLine {
  itemId: ID;
  itemName: string; // (ro)
  qty: number;
}

export interface Item {
  id: ID;
  type: ItemType;
  name: string;
  parentId: ID | null;
  fullName: string; // (ro)
  level: number; // (ro)
  mpn: string;
  description: string;
  purchaseDescription: string;
  isPurchased: boolean;
  salesPrice: number;
  rateIsPercent: boolean;
  cost: number;
  incomeAccountId: ID | null;
  expenseAccountId: ID | null;
  assetAccountId: ID | null;
  preferredVendorId: ID | null;
  taxable: boolean;
  reorderPoint: number | null;
  maxQty: number | null;
  qtyOnHand: number; // (ro)
  avgCost: number; // (ro)
  assetValue: number; // (ro)
  qtyOnPo: number; // (ro)
  taxRate: number;
  taxAgencyId: ID | null;
  paymentMethodId: ID | null;
  depositAccountId: ID | null;
  groupLines: ItemGroupLine[];
  active: boolean;
  hasTxns: boolean; // (ro)
  openingQty?: number; // create only
  openingValue?: number; // create only
  openingDate?: string; // create only
  updatedAt?: string; // (ro) send it back unchanged: a save based on an older copy is refused (409 conflict)
}

// ---------------------------------------------------------------------------
// Transactions

export type LineKind = 'item' | 'expense' | 'je' | 'deposit';

export interface TxnLine {
  id: ID; // 0 for new lines
  seq: number;
  kind: LineKind;
  itemId: ID | null;
  accountId: ID | null;
  description: string;
  qty: number | null;
  rate: number | null;
  rateIsPercent: boolean;
  amount: number; // journal lines: + debit, - credit
  classId: ID | null;
  nameId: ID | null;
  billable: boolean;
  billedTxnId: ID | null; // (ro)
  taxable: boolean;
  serviceDate: string;
  paymentMethodId: ID | null;
  refNumber: string;
  linkedTxnId: ID | null;
  linkedLineId: ID | null;
  receivedQty: number; // (ro)
  closed: boolean;
  cogs: number; // (ro)
}

export interface TxnLink {
  id: ID;
  fromTxnId: ID | null; // null = this transaction
  toTxnId: ID;
  amount: number;
  discount: number;
  discountAccountId: ID | null;
  fromType: TxnType | ''; // (ro)
  fromRefNumber: string; // (ro)
  fromDate: string; // (ro)
  toType: TxnType | ''; // (ro)
  toRefNumber: string; // (ro)
  toDate: string; // (ro)
  toAmount: number; // (ro)
}

export interface LinkedTxn {
  txnId: ID;
  type: TxnType;
  typeLabel: string;
  date: string;
  refNumber: string;
  amount: number;
  relation: string;
}

export interface Txn {
  id: ID; // 0 = new
  type: TxnType;
  refNumber: string;
  date: string;
  nameId: ID | null;
  nameFull: string; // (ro)
  accountId: ID | null;
  arApAccountId: ID | null;
  toAccountId: ID | null;
  amount: number;
  openBalance: number; // (ro)
  subtotal: number; // (ro)
  dueDate: string;
  shipDate: string;
  termsId: ID | null;
  classId: ID | null;
  repId: ID | null;
  shipViaId: ID | null;
  customerMessageId: ID | null;
  paymentMethodId: ID | null;
  fob: string;
  poNumber: string;
  memo: string;
  billAddress: string;
  shipAddress: string;
  taxItemId: ID | null;
  taxRate: number; // (ro)
  taxAmount: number; // (ro)
  toBePrinted: boolean;
  toBeEmailed: boolean;
  isPending: boolean;
  status: string;
  voided: boolean; // (ro)
  cashBackAccountId: ID | null;
  cashBackAmount: number;
  cashBackMemo: string;
  template: string;
  extra: Record<string, any>;
  lines: TxnLine[];
  links: TxnLink[];
  linked: LinkedTxn[]; // (ro)
  cleared: '' | '*' | 'R'; // (ro)
  createdBy: string; // (ro)
  createdAt: string; // (ro)
  updatedAt: string; // (ro)
}

export interface TxnSummary {
  id: ID;
  type: TxnType;
  typeLabel: string;
  refNumber: string;
  date: string;
  dueDate: string;
  nameId: ID | null;
  nameFull: string;
  accountId: ID | null;
  accountName: string;
  amount: number;
  openBalance: number;
  memo: string;
  status: string;
  voided: boolean;
  isPending: boolean;
  toBePrinted: boolean;
}

export interface TxnListResult {
  rows: TxnSummary[];
  total: number;
}

export interface OpenDoc {
  txnId: ID;
  type: TxnType;
  typeLabel: string;
  date: string;
  dueDate: string;
  refNumber: string;
  nameId: ID;
  nameFull: string;
  amount: number;
  openBalance: number;
  termsId: ID | null;
  discountDate: string;
  suggestedDiscount: number;
  memo: string;
  poNumber: string;
  arApAccountId: ID;
}

export interface OpenDocsResult {
  charges: OpenDoc[];
  credits: OpenDoc[];
}

export interface UndepositedItem {
  txnId: ID;
  type: TxnType;
  typeLabel: string;
  date: string;
  refNumber: string;
  nameId: ID | null;
  nameFull: string;
  paymentMethodId: ID | null;
  paymentMethodName: string;
  amount: number;
  memo: string;
  classId: ID | null;
  /** Payment-item line of an invoice / sales receipt waiting in Undeposited Funds: deposit it with
   *  linkedTxnId = txnId and linkedLineId = lineId. Null (or absent) for whole payments. */
  lineId?: ID | null;
  /** Check number of the payment ('' when none). */
  checkNumber?: string;
}

export interface BillableCost {
  lineId: ID;
  txnId: ID;
  txnType: TxnType;
  date: string;
  refNumber: string;
  vendorName: string;
  itemId: ID | null;
  accountId: ID | null;
  description: string;
  qty: number | null;
  rate: number | null;
  amount: number;
  classId: ID | null;
  /** Customer:job the cost is billable to. */
  nameId: ID | null;
  nameFull: string;
}

export interface RegisterRow {
  txnId: ID;
  glId: ID;
  date: string;
  refNumber: string;
  type: TxnType;
  typeAbbrev: string;
  nameId: ID | null;
  nameFull: string;
  otherAccount: string;
  memo: string;
  increase: number;
  decrease: number;
  cleared: '' | '*' | 'R';
  balance: number;
  dueDate: string;
  openBalance: number;
  voided: boolean;
}

export interface RegisterResult {
  account: Account;
  increaseLabel: string;
  decreaseLabel: string;
  rows: RegisterRow[];
  endingBalance: number;
}

export interface PayBillCredit {
  creditId: ID;
  amount: number;
}
export interface PayBillItem {
  billId: ID;
  amount: number;
  discount: number;
  discountAccountId: ID | null;
  credits: PayBillCredit[];
}
export interface PayBillsRequest {
  date: string;
  accountId: ID;
  toBePrinted: boolean;
  firstCheckNumber: string;
  bills: PayBillItem[];
}
export interface PayBillsResult {
  payments: TxnSummary[];
}

export interface SalesTaxDue {
  taxItemId: ID;
  taxItemName: string;
  agencyId: ID | null;
  agencyName: string;
  amountDue: number;
}

// ---------------------------------------------------------------------------
// Company

export interface CompanyFile {
  id: string;
  name: string;
  fileName: string;
  path: string;
  modified: string;
  size: number;
}

/** How a backup was made: on the schedule, when the company closed, Back up now, before a restore, or a download. */
export type BackupKind = 'auto' | 'close' | 'manual' | 'restore' | 'download';

/** One backup of a company file (GET /backups). */
export interface BackupEntry {
  id: number;
  /** RFC3339 */
  time: string;
  kind: BackupKind;
  /** File name ('' for downloads). */
  file: string;
  /** Full location ('' for downloads). */
  path: string;
  size: number;
  /** The file is still in the backup folder. */
  exists: boolean;
}

/** Automatic backup settings (GET/PUT /backups/settings). */
export interface BackupSettings {
  enabled: boolean;
  /** '' = the default folder */
  folder: string;
  keep: number;
  /** The folder backups go to. */
  folderInUse: string;
  defaultFolder: string;
  /** The user may change the settings (administrator). */
  canChange: boolean;
}

/** GET /backups */
export interface BackupStatus extends BackupSettings {
  intervalSeconds: number;
  /** The newest backup of any kind (downloads too). */
  last: BackupEntry | null;
  /** When the next automatic backup is due if the file changed ('' when they are off). */
  nextDue: string;
  /** The file changed since its last backup in the folder. */
  changed: boolean;
  /** The last automatic backup failed with this message. */
  error: string;
  errorTime: string;
  /** The backups in the folder, newest first. */
  backups: BackupEntry[];
}

export interface CompanyInfo {
  name: string;
  legalName: string;
  address1: string;
  address2: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  phone: string;
  fax: string;
  email: string;
  website: string;
  taxId: string;
  industry: string;
  entityType: string;
  fiscalYearStartMonth: number;
  taxYearStartMonth: number;
  closingDate: string; // (ro)
  hasClosingPassword: boolean; // (ro)
  createdAt: string; // (ro)
  companyId: string; // (ro)
}

export interface NewCompanyRequest {
  name: string;
  legalName: string;
  industry: string;
  entityType: string;
  taxId: string;
  address1: string;
  address2: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  phone: string;
  email: string;
  website: string;
  fiscalYearStartMonth: number;
  adminPassword: string;
  createDefaultAccounts: boolean;
  salesTaxEnabled: boolean;
  inventoryEnabled: boolean;
}

export interface IndustryTemplate {
  key: string;
  label: string;
  description: string;
}

export interface Prefs {
  useAccountNumbers: boolean;
  showLowestSubaccountOnly: boolean;
  requireAccounts: boolean;
  useClassTracking: boolean;
  promptForClass: boolean;
  autoAssignJournalNumbers: boolean;
  datePastWarnDays: number;
  dateFutureWarnDays: number;
  billsDueDays: number;
  warnDuplicateBillNumbers: boolean;
  autoUseVendorDiscounts: boolean;
  vendorDiscountAccountId: ID | null;
  printAccountNamesOnVoucher: boolean;
  warnDuplicateCheckNumbers: boolean;
  autoFillPayee: boolean;
  defaultCheckAccountId: ID | null;
  defaultBillPayAccountId: ID | null;
  defaultDepositAccountId: ID | null;
  autoRecall: boolean;
  windowMode: 'multiple' | 'one';
  iconBar: 'left' | 'top' | 'hidden';
  inventoryEnabled: boolean;
  purchaseOrdersEnabled: boolean;
  warnDuplicatePONumbers: boolean;
  warnNotEnoughInventory: boolean;
  reportBasis: 'accrual' | 'cash';
  agingFrom: 'due' | 'transaction';
  reportAccountDisplay: 'name' | 'description' | 'both';
  estimatesEnabled: boolean;
  warnDuplicateInvoiceNumbers: boolean;
  useUndepositedFunds: boolean;
  autoApplyPayments: boolean;
  autoCalcPayments: boolean;
  useCustomerDiscounts: boolean;
  customerDiscountAccountId: ID | null;
  defaultShipViaId: ID | null;
  defaultFob: string;
  defaultMarkupPercent: number;
  defaultInvoiceTemplate: 'Product Invoice' | 'Service Invoice' | 'Professional Invoice';
  salesTaxEnabled: boolean;
  defaultSalesTaxItemId: ID | null;
  salesTaxBasis: 'accrual' | 'cash';
  salesTaxFrequency: 'monthly' | 'quarterly' | 'annually';
  markTaxableAmountsT: boolean;
  showHomePageOnOpen: boolean;
  showRemindersOnOpen: boolean;
}

export interface User {
  id: ID;
  name: string;
  isAdmin: boolean;
  active: boolean;
  hasPassword: boolean; // (ro)
  password?: string; // input only
}

/** An AI assistant app SerieX can set up by itself (POST /ai-assistants/setup). */
export type AiSetupTarget = 'claudeDesktop' | 'codex';

/** Settings file of an AI assistant app on this computer (GET /ai-assistants "setup"). */
export interface AiSetupFile {
  /** Full location of the app's settings file. */
  file: string;
  exists: boolean;
  /** The file already starts SerieX's helper program. */
  configured: boolean;
  /** The app was found on this computer (missing from older servers). */
  appFound?: boolean;
}

/** AI Assistants (GET/PUT /ai-assistants). */
export interface AiAssistantsStatus {
  /** false when the connection for AI assistants is off on this server. */
  available: boolean;
  /** Plain sentence when available is false, else ''. */
  unavailableReason: string;
  /** This company file is shared with AI assistants. */
  enabled: boolean;
  /** Assistants may make changes (create, record, void). */
  allowChanges: boolean;
  /** SerieX user the assistant works as ('' when not set yet). */
  user: string;
  /** Active user names (administrators only; [] otherwise). */
  users: string[];
  /** The company file has passwords. */
  passwordsRequired: boolean;
  /**
   * Changes whenever this company file's access key is made, replaced or dropped ('' when it has
   * no key that works). It tells nothing about the key itself. When it changes, a window that
   * holds an older key drops it.
   */
  keyVersion: string;
  /** The caller is an administrator of this company file. */
  isAdmin: boolean;
  /** Web address assistants connect to, e.g. http://127.0.0.1:47180/mcp */
  address: string;
  /** The helper program assistant apps start (the SerieX desktop app carries it). */
  helper: { available: boolean; path: string; args: string[] };
  platform: 'darwin' | 'windows' | 'linux';
  /** The request came from the computer SerieX Books runs on. */
  fromThisComputer: boolean;
  /** Apps SerieX can set up by itself (administrators on this computer, helper available); else null. */
  setup: { claudeDesktop: AiSetupFile; codex: AiSetupFile } | null;
}

/** GET /ai-assistants/key, POST /ai-assistants/new-key: the access key (administrators on this computer). */
export interface AiAccessKey {
  key: string;
  /** The status's keyVersion while this key is the one that works (missing from older servers). */
  keyVersion?: string;
}

/** PUT /ai-assistants */
export interface AiAssistantsSettings {
  enabled: boolean;
  allowChanges: boolean;
  user: string;
}

/** POST /ai-assistants/setup */
export interface AiSetupResult {
  /** The settings file that was written. */
  file: string;
  /** Copy of the file as it was before ('' when there was none, or nothing changed). */
  backup: string;
  message: string;
  /** What happened to the file (missing from older servers). */
  result?: 'created' | 'changed' | 'unchanged';
}

export interface AuditRow {
  id: ID;
  ts: string;
  user: string;
  action: string;
  txnId: ID | null;
  txnType: string;
  refNumber: string;
  txnDate: string;
  name: string;
  amount: number;
  details: Record<string, any>;
}

// ---------------------------------------------------------------------------
// Reports

export interface ReportColumn {
  key: string;
  label: string;
  type: 'text' | 'money' | 'number' | 'date' | 'percent';
}

export interface ReportDrill {
  report: string;
  params: Record<string, string>;
}

export interface ReportRow {
  kind: 'section' | 'data' | 'subtotal' | 'total' | 'grandtotal' | 'blank';
  level: number;
  cells: Record<string, string | number | null>;
  txnId?: ID;
  drill?: ReportDrill;
  group?: string;
  /** per-column drill-down targets keyed by column key (multi-column reports); use cellDrills[colKey] ?? drill */
  cellDrills?: Record<string, ReportDrill>;
}

export interface ReportResult {
  key: string;
  title: string;
  companyName: string;
  dateRangeLabel: string;
  basis: string;
  columns: ReportColumn[];
  rows: ReportRow[];
  params: Record<string, string>;
  generatedAt: string;
}

export type ReportParamKind =
  | 'dates'
  | 'asOf'
  | 'basis'
  | 'columns'
  | 'accountId'
  | 'nameId'
  | 'itemId'
  | 'classId'
  | 'filters'
  | 'budgetId'
  | 'agingInterval';

export interface ReportInfo {
  key: string;
  title: string;
  category: string;
  description: string;
  params: ReportParamKind[];
  defaultDates: string;
}

export interface StatementRow {
  txnId: ID;
  date: string;
  type: TxnType;
  refNumber: string;
  description: string;
  dueDate: string;
  amount: number;
  balance: number;
}

export interface StatementAging {
  current: number;
  d1_30: number;
  d31_60: number;
  d61_90: number;
  over90: number;
}

export interface Statement {
  customer: Name;
  billAddress: string;
  statementDate: string;
  from: string;
  to: string;
  openingBalance: number;
  rows: StatementRow[];
  endingBalance: number;
  aging: StatementAging;
  amountDue: number;
}

// ---------------------------------------------------------------------------
// Banking

export interface ReconcileEntry {
  glId: ID;
  txnId: ID;
  type: TxnType;
  typeLabel: string;
  date: string;
  refNumber: string;
  nameFull: string;
  memo: string;
  amount: number; // + increases the account balance, - decreases
  cleared: '' | '*';
}

export interface ReconcileAdj {
  amount: number;
  date: string;
  accountId: ID | null;
  classId: ID | null;
}

export interface ReconcileDraft {
  statementDate: string;
  endingBalance: number;
  serviceCharge: ReconcileAdj | null;
  interest: ReconcileAdj | null;
  markedGlIds: ID[];
}

export interface ReconcileStart {
  account: Account;
  lastStatementDate: string;
  beginningBalance: number;
  draft: ReconcileDraft | null;
  entries: ReconcileEntry[];
  /** Ending balance of the last statement (null when never reconciled). Differs from beginningBalance when
   *  reconciled transactions were changed since: see GET /reconcile/{accountId}/discrepancies. */
  lastEndingBalance?: number | null;
}

export interface ReconcileFinish {
  statementDate: string;
  endingBalance: number;
  clearedGlIds: ID[];
  serviceCharge: ReconcileAdj | null;
  interest: ReconcileAdj | null;
  enterAdjustment: boolean;
}

export interface Reconciliation {
  id: ID;
  accountId: ID;
  accountName: string;
  statementDate: string;
  beginningBalance: number;
  endingBalance: number;
  clearedBalance: number;
  completedAt: string;
  completedBy: string;
}

export interface ReconcileReport {
  reconciliation: Reconciliation;
  cleared: ReconcileEntry[]; // amounts as reconciled
  uncleared: ReconcileEntry[];
  clearedIncrease: number;
  clearedDecrease: number;
  registerBalance: number;
  /** Reconciled transactions changed, unmarked, voided or deleted after this reconciliation. */
  changes?: ReconcileChange[];
}

/** One reconciled transaction changed after its reconciliation. */
export interface ReconcileChange {
  reconciliationId: ID;
  statementDate: string;
  txnId: ID;
  type: TxnType;
  typeLabel: string;
  date: string;
  refNumber: string;
  nameFull: string;
  reconciledAmount: number; // natural sign, as reconciled
  currentAmount: number; // natural sign, still cleared by that reconciliation (0 when unmarked/deleted)
  change: 'Amount changed' | 'Uncleared' | 'Voided' | 'Deleted';
  effect: number; // currentAmount - reconciledAmount
}

/** GET /reconcile/{accountId}/discrepancies: Previous Reconciliation Discrepancy report. */
export interface ReconcileDiscrepancies {
  accountId: ID;
  accountName: string;
  lastStatementDate: string;
  lastEndingBalance: number;
  beginningBalance: number;
  difference: number; // beginningBalance - lastEndingBalance
  changes: ReconcileChange[];
}

export interface BankFeedMatch {
  txnId: ID;
  type: TxnType;
  typeLabel: string;
  date: string;
  refNumber: string;
  nameFull: string;
  amount: number;
}

export interface BankFeedItem {
  id: ID;
  accountId: ID;
  date: string;
  description: string;
  amount: number; // + money in, - money out
  checkNumber: string;
  status: 'new' | 'added' | 'matched' | 'ignored';
  txnId: ID | null;
  matches: BankFeedMatch[]; // (ro)
  suggestedNameId: ID | null; // (ro)
  suggestedAccountId: ID | null; // (ro)
  suggestedPayee: string; // (ro)
}

export interface BankFeedAdd {
  nameId: ID | null;
  accountId: ID;
  memo: string;
  classId: ID | null;
  refNumber: string;
}

export interface BankFeedImportResult {
  imported: number;
  skipped: number;
  batchId: string;
  format: 'ofx' | 'csv';
  /** Rows of the file that could not be read (bad date or amount); not imported. */
  invalid?: number;
  /** The first 20 unreadable rows with the reason. */
  problems?: BankFeedProblem[];
  /** "mdy" or "dmy": how the dates of a CSV file were read. */
  dateOrder?: string;
  /** True when the amounts of the file were imported with the sign reversed (flipSigns). */
  flipSigns?: boolean;
}

/** One row of a bank file that could not be read. */
export interface BankFeedProblem {
  row: number; // CSV line number, or OFX transaction number
  reason: string;
}

export interface BankRule {
  id: ID;
  name: string;
  accountId: ID | null;
  matchText: string;
  direction: 'any' | 'in' | 'out';
  renameTo: string;
  nameId: ID | null;
  targetAccountId: ID | null;
  priority: number;
}

// ---------------------------------------------------------------------------
// Memorized, budgets, to dos, reminders

export type MemorizedSchedule = 'none' | 'remind' | 'auto';
export type MemorizedFrequency =
  | 'never'
  | 'daily'
  | 'weekly'
  | 'biweekly'
  | 'semimonthly'
  | 'monthly'
  | 'quarterly'
  | 'semiannually'
  | 'annually';

export interface MemorizedTxn {
  id: ID;
  name: string;
  txnType: TxnType;
  template: Txn;
  schedule: MemorizedSchedule;
  frequency: MemorizedFrequency;
  nextDate: string;
  daysInAdvance: number;
  remaining: number | null;
  groupName: string;
  amount: number; // (ro)
}

export interface MemorizedReport {
  id: ID;
  name: string;
  reportKey: string;
  params: Record<string, string>;
  groupName: string;
}

export interface BudgetLine {
  accountId: ID;
  classId: ID | null;
  nameId: ID | null;
  amounts: number[]; // 12 fiscal months
}

export interface Budget {
  id: ID;
  name: string;
  fiscalYear: number;
  kind: 'pl' | 'bs';
  criteria: 'none' | 'class' | 'customer';
  lines: BudgetLine[];
}

export interface Todo {
  id: ID;
  title: string;
  notes: string;
  dueDate: string;
  nameId: ID | null;
  done: boolean;
}

export interface ReminderItem {
  label: string;
  date: string;
  amount: number;
  txnId: ID | null;
  itemId: ID | null;
  memorizedId: ID | null;
  note?: string; // e.g. an automatic memorized transaction that could not be entered
}

export interface ReminderGroup {
  key:
    | 'overdue_invoices'
    | 'bills_to_pay'
    | 'checks_to_print'
    | 'invoices_to_print'
    | 'money_to_deposit'
    | 'inventory_to_reorder'
    | 'memorized_due'
    | 'purchase_orders'
    | 'todos'
    | 'sales_tax_due';
  label: string;
  total: number;
  items: ReminderItem[];
}

// ---------------------------------------------------------------------------
// Helpers to build empty records for "new" forms

export function emptyAddress(): Address {
  return { line1: '', line2: '', line3: '', city: '', state: '', zip: '', country: '' };
}

export function emptyLine(kind: LineKind, seq = 0): TxnLine {
  return {
    id: 0,
    seq,
    kind,
    itemId: null,
    accountId: null,
    description: '',
    qty: null,
    rate: null,
    rateIsPercent: false,
    amount: 0,
    classId: null,
    nameId: null,
    billable: false,
    billedTxnId: null,
    taxable: false,
    serviceDate: '',
    paymentMethodId: null,
    refNumber: '',
    linkedTxnId: null,
    linkedLineId: null,
    receivedQty: 0,
    closed: false,
    cogs: 0,
  };
}

export function emptyTxn(type: TxnType, date: string): Txn {
  return {
    id: 0,
    type,
    refNumber: '',
    date,
    nameId: null,
    nameFull: '',
    accountId: null,
    arApAccountId: null,
    toAccountId: null,
    amount: 0,
    openBalance: 0,
    subtotal: 0,
    dueDate: '',
    shipDate: '',
    termsId: null,
    classId: null,
    repId: null,
    shipViaId: null,
    customerMessageId: null,
    paymentMethodId: null,
    fob: '',
    poNumber: '',
    memo: '',
    billAddress: '',
    shipAddress: '',
    taxItemId: null,
    taxRate: 0,
    taxAmount: 0,
    toBePrinted: false,
    toBeEmailed: false,
    isPending: false,
    status: '',
    voided: false,
    cashBackAccountId: null,
    cashBackAmount: 0,
    cashBackMemo: '',
    template: '',
    extra: {},
    lines: [],
    links: [],
    linked: [],
    cleared: '',
    createdBy: '',
    createdAt: '',
    updatedAt: '',
  };
}

export function emptyLink(toTxnId: ID): TxnLink {
  return {
    id: 0,
    fromTxnId: null,
    toTxnId,
    amount: 0,
    discount: 0,
    discountAccountId: null,
    fromType: '',
    fromRefNumber: '',
    fromDate: '',
    toType: '',
    toRefNumber: '',
    toDate: '',
    toAmount: 0,
  };
}

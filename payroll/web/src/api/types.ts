// JSON types of the SerieX Payroll API. Mirrors server/internal/model/*.go
// field for field. Money is dollars (number, 2 decimals), dates 'YYYY-MM-DD',
// optional ids are number | null. Fields marked (ro) are computed by the server.
// Ids named *AccountId, *VendorId, classId, jobNameId and booksNameId refer to
// records of the linked SerieX Books company file.

export type Id = number;

// ---------------------------------------------------------------------------
// Constants

export type Frequency = 'daily' | 'weekly' | 'biweekly' | 'semimonthly' | 'monthly' | 'quarterly' | 'semiannually' | 'annually';

export const PAY_PERIODS: Record<Frequency, number> = {
  daily: 260, weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12, quarterly: 4, semiannually: 2, annually: 1,
};

export const FREQUENCY_LABELS: Record<Frequency, string> = {
  daily: 'Daily', weekly: 'Weekly', biweekly: 'Biweekly', semimonthly: 'Semimonthly', monthly: 'Monthly',
  quarterly: 'Quarterly', semiannually: 'Semiannually', annually: 'Annually',
};

export type ItemType =
  | 'hourly' | 'overtime' | 'salary' | 'bonus' | 'commission' | 'tips' | 'reported_tips'
  | 'addition' | 'deduction' | 'contribution' | 'federal_tax' | 'state_tax' | 'other_tax';

export const ITEM_TYPE_ORDER: ItemType[] = [
  'salary', 'hourly', 'overtime', 'bonus', 'commission', 'tips', 'reported_tips',
  'addition', 'deduction', 'contribution', 'federal_tax', 'state_tax', 'other_tax',
];

export const ITEM_TYPE_LABELS: Record<ItemType, string> = {
  hourly: 'Hourly Wage', overtime: 'Hourly Overtime', salary: 'Yearly Salary', bonus: 'Bonus', commission: 'Commission',
  tips: 'Paid Tips', reported_tips: 'Reported Tips', addition: 'Addition', deduction: 'Deduction',
  contribution: 'Company Contribution', federal_tax: 'Federal Tax', state_tax: 'State Tax', other_tax: 'Other Tax',
};

export const WAGE_TYPES: ItemType[] = ['hourly', 'overtime', 'salary', 'bonus', 'commission', 'tips', 'reported_tips'];
export const isWageType = (t: string) => (WAGE_TYPES as string[]).includes(t);

export type TaxCode =
  | 'FIT' | 'SS_EE' | 'SS_ER' | 'MED_EE' | 'MED_ER' | 'ADDL_MED' | 'FUTA'
  | 'SIT' | 'SUI_ER' | 'SUI_EE' | 'ST_EE' | 'ST_ER' | 'LOCAL_EE' | 'LOCAL_ER';

export const TAX_CODE_LABELS: Record<TaxCode, string> = {
  FIT: 'Federal Withholding', SS_EE: 'Social Security (employee)', SS_ER: 'Social Security (company)',
  MED_EE: 'Medicare (employee)', MED_ER: 'Medicare (company)', ADDL_MED: 'Additional Medicare (employee)',
  FUTA: 'Federal Unemployment', SIT: 'State Withholding', SUI_ER: 'State Unemployment (company)',
  SUI_EE: 'State Unemployment (employee)', ST_EE: 'State Employee Tax', ST_ER: 'State Employer Tax',
  LOCAL_EE: 'Local Income Tax', LOCAL_ER: 'Local Employer Tax',
};

export const EMPLOYER_TAXES: TaxCode[] = ['SS_ER', 'MED_ER', 'FUTA', 'SUI_ER', 'ST_ER', 'LOCAL_ER'];

/** Wage base keys used by PayrollItem.taxability. */
export type WageBase = 'FIT' | 'SS' | 'MED' | 'FUTA' | 'SIT' | 'SUI' | 'SDI' | 'LOCAL';
export const WAGE_BASES: WageBase[] = ['FIT', 'SS', 'MED', 'FUTA', 'SIT', 'SUI', 'SDI', 'LOCAL'];
export const WAGE_BASE_LABELS: Record<WageBase, string> = {
  FIT: 'Federal Withholding', SS: 'Social Security', MED: 'Medicare', FUTA: 'Federal Unemployment',
  SIT: 'State Withholding', SUI: 'State Unemployment', SDI: 'State Disability / Leave', LOCAL: 'Local Taxes',
};

export type Category = 'earning' | 'addition' | 'deduction' | 'contribution' | 'employee_tax' | 'employer_tax';

export type Calc = 'fixed' | 'percent' | 'per_hour' | 'quantity' | 'match' | 'tax';

export type TaxTracking =
  | 'compensation' | 'none' | 'reported_tips' | 'paid_tips' | 'qualified_overtime' | '401k' | '403b' | '457b'
  | 'roth_401k' | 'roth_403b' | 'simple_ira' | 'section_125' | 'hsa' | 'dependent_care' | 'group_term_life'
  | 'health_coverage' | 'fringe' | 'other';

// ---------------------------------------------------------------------------
// Payroll items

export interface PayrollItem {
  id: Id;
  name: string;
  type: ItemType;
  taxCode: TaxCode | '';
  state: string;
  taxKey: string;
  pto: '' | 'sick' | 'vacation';
  calc: Calc;
  rate: number;
  annualLimit: number | null;
  limitKind: 'annual' | 'one_time';
  matchItemId: Id | null;
  matchCapPct: number;
  taxTracking: TaxTracking;
  w2Box12: string;
  w2Box14: string;
  taxability: Partial<Record<WageBase, boolean>>;
  supplemental: boolean;
  notPaid: boolean;
  expenseAccountId: Id | null;
  liabilityAccountId: Id | null;
  agencyVendorId: Id | null;
  paymentGroup: string;
  active: boolean;

  category: Category; // (ro)
  effectiveGroup: string; // (ro)
  expenseAccountName: string; // (ro)
  liabilityAccountName: string; // (ro)
  agencyName: string; // (ro)
  hasPaychecks: boolean; // (ro)
}

// ---------------------------------------------------------------------------
// Pay schedules

export interface PaySchedule {
  id: Id;
  name: string;
  frequency: Frequency;
  nextPeriodEnd: string;
  nextCheckDate: string;
  semiFirstDay: number;
  active: boolean;
  nextPeriodStart: string; // (ro)
  employeeCount: number; // (ro)
}

// ---------------------------------------------------------------------------
// Employees

export interface Address {
  line1: string;
  line2: string;
  city: string;
  state: string;
  zip: string;
}

export interface W4 {
  version: '2020' | 'pre2020';
  filingStatus: string; // 2020: single | mfj | hoh ; pre2020: single | married | married_single
  step2: boolean;
  dependents: number;
  otherIncome: number;
  deductions: number;
  extraWithholding: number;
  allowances: number;
  exempt: boolean;
  nonresidentAlien: boolean;
  exemptYear?: number; // year the exemption was claimed (the server sets it when exempt turns on); expires Feb 15 of the next year; 0 = unknown
}

export interface StateW4 {
  filingStatus: string;
  allowances: number;
  extraWithholding: number;
  exempt: boolean;
  data: Record<string, unknown>;
}

export interface DirectDeposit {
  enabled: boolean;
  bankName: string;
  routing: string;
  account: string;
  accountType: 'checking' | 'savings';
  clear?: boolean; // input: true erases the stored bank name and numbers and turns direct deposit off
}

export type Accrual = 'none' | 'per_paycheck' | 'per_hour' | 'beginning_of_year';

export interface PTOSettings {
  accrual: Accrual;
  hours: number;
  perHoursWorked: number;
  maxHours: number | null;
  resetEachYear: boolean;
  yearBeginsMonth: number;
  beginAccruingDate: string;
  available: number; // (ro)
  accruedYtd: number; // (ro)
  usedYtd: number; // (ro)
}

export interface EmployeeItem {
  itemId: Id;
  rate: number;
  annualLimit: number | null;
  qty: number | null;
  itemName: string; // (ro)
  itemType: ItemType | ''; // (ro)
  calc: Calc | ''; // (ro)
}

export type EmploymentType = 'regular' | 'officer' | 'statutory' | 'owner';

export interface Employee {
  id: Id;
  booksNameId: Id | null; // (ro)
  firstName: string;
  middleName: string;
  lastName: string;
  suffix: string;
  displayName: string;
  printAs: string;
  ssn: string;
  birthDate: string;
  gender: string;
  address: Address;
  phone: string;
  mobile: string;
  email: string;
  employeeNumber: string;
  hireDate: string;
  originalHireDate: string;
  releaseDate: string;
  employmentType: EmploymentType;
  payScheduleId: Id | null;
  payFrequency: Frequency;
  classId: Id | null;
  workState: string;
  earnings: EmployeeItem[];
  items: EmployeeItem[];
  w4: W4;
  subjectSs: boolean;
  subjectMedicare: boolean;
  subjectFuta: boolean;
  stateW4: StateW4;
  subjectSui: boolean;
  subjectSdi: boolean;
  directDeposit: DirectDeposit;
  sick: PTOSettings;
  vacation: PTOSettings;
  notes: string;
  active: boolean;

  ssnOnFile: boolean; // (ro)
  payScheduleName: string; // (ro)
  hourlyRate: number; // (ro)
  annualSalary: number; // (ro)
  ytdGross: number; // (ro)
  lastCheckDate: string; // (ro)
  hasPaychecks: boolean; // (ro)
  booksSyncError: string; // (ro)
}

export interface PTOAdjustment {
  id: Id;
  employeeId: Id;
  kind: 'sick' | 'vacation';
  date: string;
  hours: number;
  memo: string;
  createdAt: string; // (ro)
}

export interface EmployeeDefaults {
  payScheduleId: Id | null;
  payFrequency: Frequency;
  classId: Id | null;
  workState: string;
  earnings: EmployeeItem[];
  items: EmployeeItem[];
  sick: PTOSettings;
  vacation: PTOSettings;
  subjectSui: boolean;
  subjectSdi: boolean;
}

export interface EmployeeSummary {
  employeeId: Id;
  year: number;
  ytdGross: number;
  ytdNet: number;
  ytdTaxes: number;
  ytdDeductions: number;
  lastPaycheck: PaycheckSummary | null;
  sick: PTOSettings;
  vacation: PTOSettings;
  ytdByItem: SummaryRow[];
}

// ---------------------------------------------------------------------------
// Paychecks

export interface PaycheckLine {
  id: Id;
  itemId: Id;
  rate: number | null;
  qty: number | null;
  amount: number;
  wageBase: number;
  subjectWages: number; // (ro)
  computed: number; // (ro)
  jobNameId: Id | null;
  classId: Id | null;
  manual: boolean;
  itemName: string; // (ro)
  itemType: ItemType | ''; // (ro)
  category: Category | ''; // (ro)
  taxCode: TaxCode | ''; // (ro)
  pto: '' | 'sick' | 'vacation'; // (ro)
  jobName: string; // (ro)
  ytd: number; // (ro)
}

export type PaycheckKind = 'regular' | 'ytd';

export interface PaycheckInput {
  id: Id;
  employeeId: Id;
  kind: PaycheckKind;
  periodStart: string;
  periodEnd: string;
  checkDate: string;
  bankAccountId: Id | null;
  checkNumber: string;
  toBePrinted: boolean;
  directDeposit: boolean;
  memo: string;
  classId: Id | null;
  noAccrual: boolean;
  lines: PaycheckLine[];
  recalculate: boolean;
}

export interface SummaryRow {
  itemId: Id;
  itemName: string;
  category: Category;
  amount: number;
  ytd: number;
}

export interface PTOSnapshot {
  availableBefore: number;
  accrued: number;
  used: number;
  availableAfter: number;
}

export type SyncStatus = 'none' | 'pending' | 'posted' | 'error';

export interface Paycheck extends PaycheckInput {
  runId: Id | null;
  employeeName: string;
  gross: number;
  notPaid: number;
  deductions: number;
  employeeTaxes: number;
  net: number;
  employerTaxes: number;
  contributions: number;
  totalHours: number;
  employeeSummary: SummaryRow[];
  companySummary: SummaryRow[];
  sick: PTOSnapshot;
  vacation: PTOSnapshot;
  voided: boolean;
  booksTxnId: Id | null;
  syncStatus: SyncStatus;
  syncError: string;
  bankAccountName: string;
  warnings: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface PaycheckSummary {
  id: Id;
  runId: Id | null;
  kind: PaycheckKind;
  employeeId: Id;
  employeeName: string;
  periodStart: string;
  periodEnd: string;
  checkDate: string;
  checkNumber: string;
  toBePrinted: boolean;
  directDeposit: boolean;
  bankAccountId: Id | null;
  gross: number;
  employeeTaxes: number;
  deductions: number;
  net: number;
  employerTaxes: number;
  contributions: number;
  totalHours: number;
  memo: string;
  voided: boolean;
  booksTxnId: Id | null;
  syncStatus: SyncStatus;
  syncError: string;
}

// ---------------------------------------------------------------------------
// Payroll runs

export type RunKind = 'scheduled' | 'unscheduled' | 'termination';

export interface ScheduledPayroll {
  payScheduleId: Id;
  name: string;
  frequency: Frequency;
  periodStart: string;
  periodEnd: string;
  checkDate: string;
  status: 'Upcoming' | 'Due' | 'Overdue';
  employeeCount: number;
}

export interface StartPayrollRequest {
  kind: RunKind;
  payScheduleId: Id | null;
  employeeIds: Id[];
  periodEnd: string;
  checkDate: string;
  releaseDate: string;
}

export interface PayrollDraftEmployee {
  employeeId: Id;
  employeeName: string;
  selected: boolean;
  lines: PaycheckLine[];
  totalHours: number;
  directDeposit: boolean;
  payFrequency: Frequency;
  lastCheckDate: string;
  warnings: string[];
}

export interface PayrollDraft {
  kind: RunKind;
  payScheduleId: Id | null;
  scheduleName: string;
  periodStart: string;
  periodEnd: string;
  checkDate: string;
  bankAccountId: Id | null;
  nextCheckNumber: string;
  earningColumns: PayrollItem[];
  employees: PayrollDraftEmployee[];
}

export interface CreatePayrollRequest {
  kind: RunKind;
  payScheduleId: Id | null;
  periodStart: string;
  periodEnd: string;
  checkDate: string;
  bankAccountId: Id;
  printMode: 'print' | 'handwritten';
  firstCheckNumber: string;
  paychecks: PaycheckInput[];
  releaseDate?: string;
}

export interface SyncProblem {
  entity: 'paycheck' | 'liability_payment' | 'adjustment' | 'employee';
  id: Id;
  label: string;
  code: string;
  message: string;
}

export interface CreatePayrollResult {
  runId: Id;
  paychecks: PaycheckSummary[];
  posted: number;
  problems: SyncProblem[];
}

// ---------------------------------------------------------------------------
// Liabilities

export interface LiabilityItemAmount {
  itemId: Id;
  itemName: string;
  amount: number;
}

export interface LiabilityDue {
  paymentGroup: string;
  label: string;
  agencyVendorId: Id | null;
  agencyName: string;
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  status: 'Overdue' | 'Due' | 'Upcoming' | 'Paid';
  frequency: string;
  method: 'check' | 'e-pay';
  amountDue: number;
  items: LiabilityItemAmount[];
}

export interface LiabilityBalance {
  itemId: Id;
  itemName: string;
  itemType: ItemType;
  paymentGroup: string;
  agencyName: string;
  accrued: number;
  adjusted: number;
  paid: number;
  balance: number;
}

export interface LiabilityPaymentLine {
  kind: 'item' | 'expense';
  itemId: Id | null;
  accountId: Id | null;
  amount: number;
  memo: string;
  itemName: string; // (ro)
  accountName: string; // (ro)
}

export interface LiabilityPayment {
  id: Id;
  kind: 'payment' | 'prior';
  date: string;
  periodStart: string;
  periodEnd: string;
  agencyVendorId: Id | null;
  bankAccountId: Id | null;
  checkNumber: string;
  toBePrinted: boolean;
  method: 'check' | 'e-pay';
  memo: string;
  lines: LiabilityPaymentLine[];
  amount: number; // (ro)
  agencyName: string; // (ro)
  bankAccountName: string; // (ro)
  voided: boolean; // (ro)
  booksTxnId: Id | null; // (ro)
  syncStatus: SyncStatus; // (ro)
  syncError: string; // (ro)
  createdBy: string; // (ro)
  createdAt: string; // (ro)
}

export interface LiabilityAdjustmentLine {
  itemId: Id;
  amount: number;
  wageBase: number;
  memo: string;
  itemName: string; // (ro)
}

export interface LiabilityAdjustment {
  id: Id;
  date: string;
  effectiveDate: string;
  employeeId: Id | null;
  memo: string;
  affectsAccounts: boolean;
  classId: Id | null;
  lines: LiabilityAdjustmentLine[];
  employeeName: string; // (ro)
  booksTxnId: Id | null; // (ro)
  syncStatus: SyncStatus; // (ro)
  syncError: string; // (ro)
  createdBy: string; // (ro)
  createdAt: string; // (ro)
}

export type PaymentFrequency = 'semiweekly' | 'monthly' | 'quarterly' | 'annually' | 'after_payroll';

export interface PaymentSchedule {
  paymentGroup: string;
  label: string; // (ro)
  agencyVendorId: Id | null;
  agencyName: string; // (ro)
  frequency: PaymentFrequency;
  method: 'check' | 'e-pay';
  itemNames: string[]; // (ro)
}

// ---------------------------------------------------------------------------
// Tax forms

export interface FormLine {
  key: string;
  col: string;
  label: string;
  section: string;
  kind: 'money' | 'number' | 'count' | 'check' | 'text';
  value: number;
  text: string;
  checked: boolean;
  computed: number;
  editable: boolean;
  overridden: boolean;
}

export interface FormCompany {
  ein: string;
  name: string;
  tradeName: string;
  address: Address;
  stateId: string;
  contactName: string;
  contactPhone: string;
  email: string; // company e-mail
}

export interface TaxForm {
  form: '941' | '940' | 'STATE-UI';
  year: number;
  period: string;
  state: string;
  title: string;
  company: FormCompany;
  lines: FormLine[];
  status: 'new' | 'draft' | 'filed';
  filedAt: string;
  dueDate: string;
  warnings: string[];
  extra: Record<string, any>;
}

export interface SaveFormRequest {
  overrides: Record<string, number>;
  texts: Record<string, string>;
  checks: Record<string, boolean>;
  status: 'draft' | 'filed';
}

export interface StateWageRow {
  employeeId: Id;
  name: string;
  ssn: string;
  gross: number;
  suiWages: number;
  excessWages: number;
  sitWages: number;
  sitWithheld: number;
  weeksWorked: number;
  monthsEmployed: [boolean, boolean, boolean];
}

export interface Box12 {
  code: string;
  amount: number;
}
export interface Box14 {
  label: string;
  amount: number;
}
export interface W2State {
  state: string;
  stateId: string;
  wages: number;
  tax: number;
}
export interface W2Local {
  name: string;
  wages: number;
  tax: number;
}

export interface W2 {
  employeeId: Id;
  year: number;
  ssn: string;
  employeeName: string;
  firstName: string;
  middleInitial: string;
  lastName: string;
  suffix: string;
  address: Address;
  controlNumber: string;
  box1: number;
  box2: number;
  box3: number;
  box4: number;
  box5: number;
  box6: number;
  box7: number;
  box8: number;
  box10: number;
  box11: number;
  box12: Box12[];
  statutory: boolean;
  retirementPlan: boolean;
  thirdPartySick: boolean;
  box14: Box14[];
  states: W2State[];
  locals: W2Local[];
  reviewed: boolean;
  warnings: string[];
  box14b: string[]; // Treasury Tipped Occupation Codes (2026 box 14b; required with box 12 code TP)
}

export interface W3 {
  year: number;
  count: number;
  box1: number;
  box2: number;
  box3: number;
  box4: number;
  box5: number;
  box6: number;
  box7: number;
  box8: number;
  box10: number;
  box11: number;
  box12a: number;
  box14: number;
  states: W2State[];
  locals: W2Local[];
  kindOfPayer: string;
  kindOfEmployer: string;
}

export interface W2Result {
  year: number;
  company: FormCompany;
  employees: W2[];
  w3: W3;
  status: string;
  filedAt: string;
}

export interface FormFiling {
  id: Id;
  form: string;
  year: number;
  period: string;
  state: string;
  status: string;
  filedAt: string;
  updatedAt: string;
  dueDate: string; // (ro)
  title: string; // (ro)
}

// ---------------------------------------------------------------------------
// Company, preferences, setup

export interface PayrollCompany {
  booksCompanyId: string; // (ro)
  name: string;
  legalName: string;
  tradeName: string;
  address: Address;
  phone: string;
  email: string;
  ein: string;
  contactName: string;
  contactTitle: string;
  contactPhone: string;
  primaryState: string;
  federalDepositSchedule: 'monthly' | 'semiweekly';
  firstPayrollYear: number;
  setupDone: boolean;
  setupState: Record<string, unknown>;
  booksUrl: string; // (ro)
}

export interface StateSettings {
  state: string;
  withholdingId: string;
  uiId: string;
  uiRates: Record<string, number>;
  otherRates: Record<string, Record<string, number>>;
  stateName: string; // (ro)
}

export interface PayrollPrefs {
  defaultBankAccountId: Id | null;
  displayNameOrder: 'first' | 'last';
  copyEarningsFromPrevious: boolean;
  recallHours: boolean;
  jobCosting: boolean;
  classTracking: 'none' | 'paycheck' | 'earnings';
  showSsnOnReports: boolean;
  postToBooks: boolean;
  payStubShowCompanyAddress: boolean;
  payStubShowPto: boolean;
  payStubShowYtd: boolean;
  payStubShowSsnLast4: boolean;
  warnDuplicateCheckNumbers: boolean;
  dueSoonDays: number;
}

export interface SetupRequest {
  primaryState: string;
  ein: string;
  federalDepositSchedule: 'monthly' | 'semiweekly';
  firstPayrollYear: number;
  defaultBankAccountId: Id | null;
  createAccounts: boolean;
  createAgencies: boolean;
  payFrequency: Frequency;
  nextPeriodEnd: string;
  nextCheckDate: string;
  uiRate: number | null;
}

export interface PayrollCompanyFile {
  id: string;
  name: string;
  payrollSetUp: boolean;
  setupDone: boolean;
  booksModified: string;
}

export interface AuthInfo {
  required: boolean;
  users: string[];
}

export interface LoginResult {
  token: string;
  user: string;
  isAdmin: boolean;
}

export interface AppInfo {
  app: string;
  version: string;
  booksUrl: string;
  booksReachable: boolean;
  taxYears: number[];
}

// ---------------------------------------------------------------------------
// SerieX Books link

export interface BooksStatus {
  url: string;
  reachable: boolean;
  companyName: string;
  sessionOk: boolean;
  postToBooks: boolean;
  pendingCount: number;
  errorCount: number;
  message: string;
}

export interface SyncItem {
  entity: 'paycheck' | 'liability_payment' | 'adjustment';
  id: Id;
  date: string;
  label: string;
  amount: number;
  booksTxnId: Id | null;
  status: SyncStatus;
  error: string;
  syncedAt: string;
}

export interface SyncRef {
  entity: string;
  id: Id;
}

export interface RetryResult {
  posted: number;
  problems: SyncProblem[];
}

export interface VerifyProblem {
  entity: string;
  id: Id;
  label: string;
  booksTxnId: Id | null;
  problem: string;
}

export interface AccountTieOut {
  accountId: Id;
  accountName: string;
  payrollBalance: number;
  booksBalance: number;
  difference: number; // payrollBalance - notInBooks - notPosted - booksBalance (0 for a healthy file)
  notInBooks: number; // never posted by design: year-to-date entries, earlier tax payments, adjustments that do not affect accounts
  notPosted: number; // waiting to be posted (Books Sync: pending or error)
}

export interface VerifyResult {
  checked: number;
  problems: VerifyProblem[];
  accounts: AccountTieOut[];
}

export interface BooksAccount {
  id: Id;
  name: string;
  fullName: string;
  number: string;
  type: string;
  level: number;
  balance: number;
  active: boolean;
}

export interface BooksName {
  id: Id;
  kind: 'customer' | 'vendor' | 'other';
  name: string;
  fullName: string;
  level: number;
  active: boolean;
  address: string; // (ro) address block printed on checks to this name: print-as name, address lines, "City, ST ZIP" ("\n" separated)
}

export interface BooksListEntry {
  id: Id;
  name: string;
  fullName: string;
  level: number;
  active: boolean;
}

export interface NewBooksAccount {
  name: string;
  type: string;
  parentId: Id | null;
  number: string;
}

export interface NewBooksVendor {
  name: string;
  companyName: string;
  address: Address;
  phone: string;
  accountNumber: string;
}

// ---------------------------------------------------------------------------
// Pay stubs

export interface StubLine {
  name: string;
  rate: number | null;
  hours: number | null;
  amount: number;
  ytd: number;
}

export interface PayStub {
  paycheckId: Id;
  company: FormCompany;
  employeeName: string;
  employeeAddress: Address;
  ssnLast4: string;
  employeeNumber: string;
  periodStart: string;
  periodEnd: string;
  checkDate: string;
  checkNumber: string;
  directDeposit: boolean;
  depositAccount: string;
  earnings: StubLine[];
  taxes: StubLine[];
  deductions: StubLine[];
  additions: StubLine[];
  contributions: StubLine[];
  gross: number;
  grossYtd: number;
  net: number;
  netYtd: number;
  totalTaxes: number;
  totalDeductions: number;
  sick: PTOSnapshot | null;
  vacation: PTOSnapshot | null;
  memo: string;
  netInWords: string;
  printAs: string;
}

// ---------------------------------------------------------------------------
// Reports (same shapes as SerieX Books)

export interface ReportColumn {
  key: string;
  label: string;
  type: 'text' | 'money' | 'number' | 'date' | 'percent' | 'hours';
}

export interface ReportDrill {
  report: string;
  params: Record<string, string>;
}

export interface ReportTarget {
  kind: 'paycheck' | 'liability_payment' | 'adjustment' | 'employee' | 'item';
  id: Id;
}

export type ReportRowKind = 'section' | 'data' | 'subtotal' | 'total' | 'grandtotal' | 'blank';

export interface ReportRow {
  kind: ReportRowKind;
  level: number;
  cells: Record<string, string | number | null>;
  target?: ReportTarget;
  drill?: ReportDrill;
  group?: string;
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

export interface ReportInfo {
  key: string;
  title: string;
  category: string;
  description: string;
  params: string[];
  defaultDates: string;
}

// ---------------------------------------------------------------------------
// Audit

export interface AuditRow {
  id: Id;
  ts: string;
  user: string;
  action: string;
  entity: string;
  entityId: Id | null;
  summary: string;
  details: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Meta (GET /api/meta)

export interface Option {
  value: string;
  label: string;
}

export interface TaxTrackingType {
  key: TaxTracking;
  label: string;
  itemTypes: ItemType[];
  w2Box12: string;
  taxability: Partial<Record<WageBase, boolean>>;
}

export interface StateInfo {
  code: string;
  name: string;
  hasIncomeTax: boolean;
  filingStatuses: Option[];
  stateForm: string;
  programs: Option[];
  hasEmployeeSui: boolean;
  notes: string;
  inputs: Option[]; // state specific W-4 inputs: value = stateW4.data key (number), label = prompt
}

export interface Meta {
  itemTypes: Option[];
  taxCodes: Option[];
  frequencies: Option[];
  taxTracking: TaxTrackingType[];
  box12Codes: Option[];
  states: StateInfo[];
  fedStatus2020: Option[];
  fedStatusPre2020: Option[];
  taxYears: number[];
}

// ---------------------------------------------------------------------------
// Tax tables (Tax Tables window)

export interface Bracket {
  over: number;
  base: number;
  rate: number;
}

export interface FederalTax {
  year: number;
  ssRate: number;
  ssWageBase: number;
  medicareRate: number;
  addlMedicareRate: number;
  addlMedicareThreshold: number;
  futaGrossRate: number;
  futaRate: number;
  futaWageBase: number;
  creditReduction: Record<string, number>;
  line1gMfj: number;
  line1gOther: number;
  standard: Record<string, Bracket[]>;
  checkbox: Record<string, Bracket[]>;
  allowanceAmount: number;
  pre2020: Record<string, Bracket[]>;
  nra2020: number;
  nraPre2020: number;
  supplementalRate: number;
  supplementalOver1MRate: number;
  limits: Record<string, number>;
  sources: string[];
  verified: string;
  notes: string;
}

export interface StateStatus {
  label: string;
  standardDeduction: number;
  brackets: Bracket[];
  lowIncomeExemption: number;
}

export interface StateAllowance {
  kind: 'none' | 'deduction' | 'credit' | 'both';
  deductionPerAllowance: number;
  creditPerAllowance: number;
  notes: string;
}

export interface StateIncomeTax {
  has: boolean;
  method: 'none' | 'flat' | 'brackets' | 'special';
  flatRate: number;
  supplementalRate: number | null;
  defaultStatus: string;
  statuses: Record<string, StateStatus>;
  allowance: StateAllowance;
  usesFederalW4: boolean;
  stateForm: string;
  special: string;
  formula: string;
  deviations: string;
  localTaxes: string;
  params: Record<string, number>;
}

export interface StateSUI {
  wageBase: number;
  newEmployerRate: number;
  minRate: number;
  maxRate: number;
  employeeRate: number;
  employeeWageBase: number | null;
  agency: string;
  notes: string;
}

export interface StateProgram {
  key: string;
  name: string;
  employeeRate: number;
  employerRate: number;
  wageBase: number | null;
  maxEmployee: number | null;
  notes: string;
  maxEmployeePerWeek?: number | null; // weekly cap on the employee amount (NY DBL, HI TDI); a paycheck withholds at most this x the weeks of its pay period
}

export interface StateTax {
  state: string;
  name: string;
  year: number;
  income: StateIncomeTax;
  sui: StateSUI;
  programs: StateProgram[];
  agencyWithholding: string;
  agencyUnemployment: string;
  deposit: string;
  quarterlyReport: string;
  annualReconciliation: string;
  sources: string[];
  confidence: string;
  notes: string;
}

export interface StateTaxSummary {
  state: string;
  name: string;
  method: string;
  flatRate: number;
  suiWageBase: number;
  suiNewRate: number;
  programs: number;
  confidence: string;
  overridden: boolean;
}

export interface TaxTableInfo {
  year: number;
  version: string;
  federal: FederalTax;
  states: StateTaxSummary[];
  overrides: string[];
}

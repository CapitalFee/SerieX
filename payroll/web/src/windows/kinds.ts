// Every MDI window kind (shared by the shell and all modules).
export const WINDOW_KINDS = [
  // company
  'home', 'payrollSetup', 'companyPayroll', 'preferences', 'booksSync', 'auditTrail', 'taxTables', 'about',
  // employees & lists
  'employeeCenter', 'employeeEdit', 'employeeDefaults', 'payrollItemList', 'payrollItemEdit', 'paySchedules', 'payScheduleEdit',
  // payroll
  'payEmployees', 'paycheckDetail', 'paycheck', 'editVoidPaychecks', 'printPaychecks', 'printPayStubs', 'ytdSetup',
  // liabilities
  'payLiabilities', 'liabilityPayment', 'adjustLiabilities', 'paymentSchedules', 'priorPayments',
  // forms
  'processForms', 'form941', 'form940', 'formW2', 'stateWageReport',
  // reports
  'reportCenter', 'report',
] as const;

export type WindowKind = (typeof WINDOW_KINDS)[number];

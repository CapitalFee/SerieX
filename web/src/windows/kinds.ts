// Every MDI window kind (shared by the shell and all modules). The component, title and size of
// each kind are in windows/registry.tsx.
export const WINDOW_KINDS = [
  // company
  'home', 'snapshot', 'myCompany', 'newCompany', 'openCompany', 'backupCompany', 'backupSettings', 'companyInfo',
  'preferences', 'closingDate', 'users', 'journalEntry', 'find', 'search', 'reminders', 'todos',
  'calendar', 'budgets', 'verifyData', 'about', 'aiAssistants',
  // customers
  'customerCenter', 'customerEdit', 'invoice', 'salesReceipt', 'receivePayment', 'creditMemo',
  'estimate', 'statementCharges', 'createStatements', 'incomeTracker', 'refund',
  // vendors
  'vendorCenter', 'vendorEdit', 'bill', 'payBills', 'billPayment', 'purchaseOrder', 'receiveItems',
  'enterBillForReceived', 'billTracker', 'manageSalesTax', 'paySalesTax', 'salesTaxPayment', 'inventoryAdjust',
  // banking
  'writeCheck', 'makeDeposit', 'transferFunds', 'ccCharge', 'useRegister', 'register', 'reconcileBegin',
  'reconcile', 'reconcileReports', 'reconcileReport', 'bankFeeds', 'bankRules', 'printChecks',
  // lists
  'chartOfAccounts', 'accountEdit', 'itemList', 'itemEdit', 'classList', 'otherNames', 'otherNameEdit',
  'profileList', 'listEntryEdit', 'memorizedTxns', 'memorizeTxn', 'importData', 'exportData', 'qbImport',
  // reports
  'reportCenter', 'report', 'memorizedReports',
] as const;

export type WindowKind = (typeof WINDOW_KINDS)[number];

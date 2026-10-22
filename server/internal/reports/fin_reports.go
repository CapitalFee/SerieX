package reports

// Catalog entries of the financial, accountant and budget reports.

import "seriex/internal/model"

func init() {
	const cf, acct, bud = "Financial Statements", "For Your Accountant", "Budgets"
	reg := func(key, title, cat, desc string, params []string, dates string, fn Func) {
		register(model.ReportInfo{Key: key, Title: title, Category: cat, Description: desc, Params: params, DefaultDates: dates}, fn)
	}
	sum := []string{"dates", "basis", "columns", "filters"}
	det := []string{"dates", "basis", "filters"}

	reg("profit_loss", "Profit and Loss", cf,
		"How much money your company made or lost over a specific period of time.",
		sum, "thisMonthToDate", finProfitLoss)
	reg("profit_loss_detail", "Profit and Loss Detail", cf,
		"Year-to-date transactions that make up your total income and expenses.",
		det, "thisFiscalYearToDate", finProfitLossDetail)
	reg("profit_loss_ytd", "Profit and Loss: Year-to-Date Comparison", cf,
		"Income and expenses for the period compared with the fiscal year to date.",
		[]string{"dates", "basis", "filters"}, "thisMonthToDate", finProfitLossYTD)
	reg("profit_loss_prev_year", "Profit and Loss: This Year vs. Last Year", cf,
		"Income and expenses compared with the same period of the previous year ($ and % change).",
		[]string{"dates", "basis", "filters"}, "thisFiscalYearToDate", finProfitLossPrevYear)
	reg("profit_loss_prev_period", "Profit and Loss: This Period vs. Last Period", cf,
		"Income and expenses compared with the period just before, of the same length ($ and % change).",
		[]string{"dates", "basis", "filters"}, "thisMonthToDate", finProfitLossPrevPeriod)
	reg("profit_loss_by_job", "Profit and Loss by Job", cf,
		"How much money each customer or job made or lost.",
		[]string{"dates", "basis", "filters"}, "thisFiscalYearToDate", finProfitLossByJob)
	reg("profit_loss_by_class", "Profit and Loss by Class", cf,
		"How much money each class made or lost.",
		[]string{"dates", "basis", "filters"}, "thisFiscalYearToDate", finProfitLossByClass)
	reg("profit_loss_unclassified", "Profit and Loss: No Class", cf,
		"Income and expenses that have not been assigned a class.",
		sum, "thisFiscalYearToDate", finProfitLossUnclassified)
	reg("income_by_customer_summary", "Income by Customer Summary", cf,
		"Net income (income minus expenses) for each customer or job.",
		sum, "thisFiscalYearToDate", finIncomeByCustomerSummary)
	reg("income_by_customer_detail", "Income by Customer Detail", cf,
		"Income and expense transactions for each customer or job.",
		det, "thisFiscalYearToDate", finIncomeByCustomerDetail)
	reg("expenses_by_vendor_summary", "Expenses by Vendor Summary", cf,
		"Total expenses for each vendor.",
		sum, "thisFiscalYearToDate", finExpensesByVendorSummary)
	reg("expenses_by_vendor_detail", "Expenses by Vendor Detail", cf,
		"Expense transactions for each vendor.",
		det, "thisFiscalYearToDate", finExpensesByVendorDetail)
	reg("balance_sheet", "Balance Sheet", cf,
		"What your company owns (assets), what it owes (liabilities) and the equity, as of a date.",
		[]string{"asOf", "basis", "columns", "filters"}, "thisFiscalYearToDate", finBalanceSheet)
	reg("balance_sheet_detail", "Balance Sheet Detail", cf,
		"Beginning balance, transactions and ending balance of every asset, liability and equity account.",
		[]string{"dates", "basis"}, "thisMonthToDate", finBalanceSheetDetail)
	reg("balance_sheet_summary", "Balance Sheet Summary", cf,
		"Balance sheet totals by account type.",
		[]string{"asOf", "basis", "columns", "filters"}, "thisFiscalYearToDate", finBalanceSheetSummary)
	reg("balance_sheet_prev_year", "Balance Sheet: This Year vs. Last Year", cf,
		"Balances compared with the same date of the previous year ($ and % change).",
		[]string{"asOf", "basis", "filters"}, "thisFiscalYearToDate", finBalanceSheetPrevYear)
	reg("balance_sheet_prev_period", "Balance Sheet: This Period vs. Last Period", cf,
		"Balances compared with the end of the previous period ($ and % change).",
		[]string{"asOf", "basis", "filters"}, "thisMonthToDate", finBalanceSheetPrevPeriod)
	reg("cash_flows", "Statement of Cash Flows", cf,
		"Cash coming in and going out from operating, investing and financing activities.",
		[]string{"dates", "columns"}, "thisFiscalYearToDate", finCashFlows)

	reg("trial_balance", "Trial Balance", acct,
		"Debit and credit balance of every account as of the To date; the totals are equal.",
		[]string{"dates", "basis", "filters"}, "thisMonthToDate", finTrialBalance)
	reg("general_ledger", "General Ledger", acct,
		"Beginning balance, transactions and running balance of every account.",
		det, "thisMonthToDate", finGeneralLedger)
	reg("journal", "Journal", acct,
		"Every transaction with its debits and credits.", // txnId=<id> shows a single transaction
		[]string{"dates", "filters"}, "thisMonthToDate", finJournal)
	reg("transaction_detail_by_account", "Transaction Detail by Account", acct,
		"Transactions grouped by account with a running balance.",
		det, "thisMonthToDate", finTxnDetailByAccount)
	reg("transaction_list_by_date", "Transaction List by Date", acct,
		"Every transaction in the period, one line per transaction.",
		[]string{"dates", "filters"}, "thisMonthToDate", finTxnListByDate)
	reg("audit_trail", "Audit Trail", acct,
		"Transactions added, changed, voided or deleted in the period and their history.",
		[]string{"dates"}, "thisMonthToDate", finAuditTrail)
	reg("account_quickreport", "Account Activity", acct,
		"Transactions of one account (and its subaccounts) with a running balance.",
		[]string{"dates", "accountId", "basis"}, "all", finAccountActivity)
	reg("custom_summary", "Custom Summary Report", acct,
		"Summary of income and expenses by account, customer or job, vendor, item or class.", // rows=account|customer|vendor|item|class
		[]string{"dates", "basis", "columns", "filters"}, "thisMonthToDate", finCustomSummary)
	reg("custom_transaction_detail", "Custom Transaction Detail Report", acct,
		"Transaction lines with the columns and filters you choose, totaled the way you choose.", // cols=..., totalBy=account|name|class|type|item|none
		[]string{"dates", "basis", "filters"}, "thisMonthToDate", finCustomTxnDetail)

	reg("budget_overview", "Budget Overview", bud,
		"Budgeted amounts by account and month.",
		[]string{"budgetId", "dates", "columns", "classId", "nameId"}, "thisFiscalYear", finBudgetOverview)
	reg("budget_vs_actual", "Budget vs. Actual", bud,
		"Actual income and expenses compared with the budget ($ over budget and % of budget).",
		[]string{"budgetId", "dates", "columns", "basis", "classId", "nameId"}, "thisFiscalYear", finBudgetVsActual)
	reg("profit_loss_budget_performance", "Budget Progress (Profit and Loss)", bud,
		"This period and year to date actual amounts compared with the budget.",
		[]string{"budgetId", "dates", "basis", "classId", "nameId"}, "thisMonthToDate", finBudgetPerformance)
}

package reports

import (
	"sync"

	"seriexpayroll/internal/model"
)

var catalogOnce sync.Once

// registerCatalog registers every report (Reports > Payroll and Employees and
// Tax Forms) in menu order.
//
// Params tell the report window which filters to show: dates, asOf,
// employeeId, itemId, columns, year, quarter, state, active, includeVoided.
func registerCatalog() {
	catalogOnce.Do(func() {
		p := func(key, title, desc string, params []string, dates string, fn Func) {
			register(model.ReportInfo{Key: key, Title: title, Category: CatPayroll, Description: desc, Params: params, DefaultDates: dates}, fn)
		}
		p("payroll_summary", "Payroll Summary",
			"Total wages, taxes withheld, deductions from net pay, net pay and employer-paid taxes and contributions for each employee.",
			[]string{"dates", "employeeId", "columns"}, "thisFiscalQuarter", payrollSummary)
		p("payroll_item_detail", "Payroll Item Detail",
			"Each payroll transaction, grouped by payroll item.",
			[]string{"dates", "employeeId", "itemId", "includeVoided"}, "thisMonthToDate", payrollItemDetail)
		p("payroll_detail_review", "Payroll Detail Review",
			"Calculated and actual amounts of every paycheck line, with the difference when an amount was changed by hand.",
			[]string{"dates", "employeeId", "itemId", "differences"}, "thisMonthToDate", payrollDetailReview)
		p("payroll_register", "Payroll Register",
			"One line per paycheck: hours, gross pay, taxes, deductions, net pay and employer costs.",
			[]string{"dates", "employeeId", "includeVoided"}, "thisFiscalQuarter", payrollRegister)
		p("employee_earnings_summary", "Employee Earnings Summary",
			"Payroll item totals for each employee.",
			[]string{"dates", "employeeId"}, "thisFiscalQuarter", employeeEarningsSummary)
		p("payroll_liability_balances", "Payroll Liability Balances",
			"Payroll liabilities accrued, adjusted and paid, and what is still owed.",
			[]string{"dates", "columns"}, "thisFiscalYear", payrollLiabilityBalances)
		p("payroll_transactions_by_payee", "Payroll Transactions by Payee",
			"Paychecks, tax payments and tax balance adjustments, grouped by employee or agency.",
			[]string{"dates", "employeeId", "includeVoided"}, "thisMonthToDate", payrollTransactionsByPayee)
		p("payroll_transaction_detail", "Payroll Transaction Detail",
			"Every payroll transaction line with its payroll item, wage base and account.",
			[]string{"dates", "employeeId", "itemId", "includeVoided"}, "thisMonthToDate", payrollTransactionDetail)
		p("payroll_journal", "Payroll Journal (SerieX Books postings)",
			"The debits and credits payroll posted to SerieX Books, with account totals.",
			[]string{"dates", "employeeId"}, "thisMonthToDate", payrollJournal)
		p("employee_state_taxes_detail", "Employee State Taxes Detail",
			"State taxes withheld and paid for each employee, grouped by state.",
			[]string{"dates", "employeeId", "itemId", "state"}, "thisFiscalYearToDate", employeeStateTaxesDetail)
		p("employee_withholding", "Employee Withholding",
			"Federal and state withholding setup of each employee.",
			[]string{"employeeId", "active"}, "today", employeeWithholding)
		p("paid_time_off_list", "Paid Time Off List",
			"Sick and vacation hours available and used this year for each employee.",
			[]string{"asOf", "employeeId", "active"}, "today", paidTimeOffList)
		p("employee_contact_list", "Employee Contact List",
			"Address, phone, email and hire date of each employee.",
			[]string{"employeeId", "active"}, "today", employeeContactList)
		p("payroll_item_listing", "Payroll Item Settings",
			"Every payroll item with its rate, limit, accounts, tax treatment and agency.",
			[]string{"itemId", "active"}, "today", payrollItemListing)

		f := func(key, title, desc string, params []string, dates string, fn Func) {
			register(model.ReportInfo{Key: key, Title: title, Category: CatTaxForms, Description: desc, Params: params, DefaultDates: dates}, fn)
		}
		f("tax_form_941_worksheet", "Form 941 Worksheet",
			"Lines of the quarterly Form 941 as the Form 941 window computes them, with the amounts entered there.",
			[]string{"year", "quarter"}, "thisFiscalQuarter", form941Worksheet)
		f("tax_form_940_worksheet", "Form 940 Worksheet",
			"Lines of the annual Form 940 as the Form 940 window computes them, with the amounts entered there.",
			[]string{"year"}, "thisFiscalYear", form940Worksheet)
	})
}

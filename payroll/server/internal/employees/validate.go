package employees

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"seriexpayroll/internal/apperr"
	"seriexpayroll/internal/items"
	"seriexpayroll/internal/model"
	"seriexpayroll/internal/store"
	"seriexpayroll/internal/taxes"
)

var (
	fedStatus2020    = map[string]bool{"single": true, "mfj": true, "hoh": true}
	fedStatusPre2020 = map[string]bool{"single": true, "married": true, "married_single": true}
	employmentTypes  = map[string]bool{"regular": true, "officer": true, "statutory": true, "owner": true}
	stateRe          = regexp.MustCompile(`^[A-Z]{2}$`)
	// states whose withholding certificate has a "reduce withholding by" line
	stateAllowsReduction = map[string]bool{"CT": true, "LA": true}
)

var (
	maskedSSNRe     = regexp.MustCompile(`^[Xx*•]{3}-?[Xx*•]{2}-?[0-9]{0,4}$`)
	maskedAccountRe = regexp.MustCompile(`^[*•Xx]+[0-9]{0,4}$`)
)

// isMasked reports whether a value sent back by the client is the masked
// form we returned ("XXX-XX-1234", "****6789"); such values never replace the
// stored number.
func isMaskedSSN(s string) bool     { return maskedSSNRe.MatchString(strings.TrimSpace(s)) }
func isMaskedAccount(s string) bool { return maskedAccountRe.MatchString(strings.TrimSpace(s)) }

// defaultDisplayName follows the company preference ("First Last" or "Last, First").
func defaultDisplayName(first, last, order string) string {
	first, last = strings.TrimSpace(first), strings.TrimSpace(last)
	if order == "last" {
		if first == "" {
			return last
		}
		return last + ", " + first
	}
	return strings.TrimSpace(first + " " + last)
}

// validSSNPattern applies the SSA rules for numbers that are never issued.
func validSSNPattern(d string) bool {
	if len(d) != 9 {
		return false
	}
	area, group, serial := d[:3], d[3:5], d[5:]
	if area == "000" || area == "666" || area[0] == '9' || group == "00" || serial == "0000" {
		return false
	}
	return true
}

// validRouting checks an ABA routing number (9 digits with the check digit).
func validRouting(d string) bool {
	if len(d) != 9 {
		return false
	}
	w := []int{3, 7, 1, 3, 7, 1, 3, 7, 1}
	sum := 0
	for i, r := range d {
		sum += int(r-'0') * w[i]
	}
	return sum%10 == 0
}

func validOptionalDate(field, label, s string) error {
	if s != "" && !store.ValidDate(s) {
		return apperr.Validation(field, "The %s is not a valid date (YYYY-MM-DD).", label)
	}
	return nil
}

// stateTax returns the current year tax tables of a state (nil when unknown).
func stateTax(state string) (*model.StateTax, error) {
	tables, _, err := taxes.Tables(time.Now().Year())
	if err != nil {
		return nil, err
	}
	st, ok := tables.States[state]
	if !ok {
		return nil, nil
	}
	return &st, nil
}

func trimEmployee(e *model.Employee) {
	t := strings.TrimSpace
	e.FirstName, e.MiddleName, e.LastName, e.Suffix = t(e.FirstName), t(e.MiddleName), t(e.LastName), t(e.Suffix)
	e.DisplayName, e.PrintAs, e.SSN = t(e.DisplayName), t(e.PrintAs), t(e.SSN)
	e.BirthDate, e.Gender = t(e.BirthDate), t(e.Gender)
	e.Address.Line1, e.Address.Line2, e.Address.City = t(e.Address.Line1), t(e.Address.Line2), t(e.Address.City)
	e.Address.State, e.Address.Zip = strings.ToUpper(t(e.Address.State)), t(e.Address.Zip)
	e.Phone, e.Mobile, e.Email, e.EmployeeNumber = t(e.Phone), t(e.Mobile), t(e.Email), t(e.EmployeeNumber)
	e.HireDate, e.OriginalHireDate, e.ReleaseDate = t(e.HireDate), t(e.OriginalHireDate), t(e.ReleaseDate)
	e.EmploymentType, e.PayFrequency = strings.ToLower(t(e.EmploymentType)), strings.ToLower(t(e.PayFrequency))
	e.WorkState = strings.ToUpper(t(e.WorkState))
	e.W4.Version, e.W4.FilingStatus = t(e.W4.Version), strings.ToLower(t(e.W4.FilingStatus))
	e.StateW4.FilingStatus = t(e.StateW4.FilingStatus)
	e.DirectDeposit.BankName, e.DirectDeposit.Routing, e.DirectDeposit.Account = t(e.DirectDeposit.BankName), t(e.DirectDeposit.Routing), t(e.DirectDeposit.Account)
	e.DirectDeposit.AccountType = strings.ToLower(t(e.DirectDeposit.AccountType))
}

// prepareEmployee validates an employee before saving and fills the values
// kept from the stored record (old, unmasked; nil for a new employee). Yes/No
// questions are returned as one apperr.Confirm unless force.
func prepareEmployee(ctx context.Context, tx *sql.Tx, e *model.Employee, old *model.Employee, force bool) error {
	trimEmployee(e)
	var confirms []string

	if e.FirstName == "" {
		return apperr.Validation("firstName", "Enter the employee's first name.")
	}
	if e.LastName == "" {
		return apperr.Validation("lastName", "Enter the employee's last name.")
	}
	if e.DisplayName == "" {
		prefs, err := store.LoadPrefs(ctx, tx)
		if err != nil {
			return err
		}
		e.DisplayName = defaultDisplayName(e.FirstName, e.LastName, prefs.DisplayNameOrder)
	}
	if strings.ContainsAny(e.DisplayName, ":\n\r\t") {
		return apperr.Validation("displayName", "The employee name cannot contain a colon or line breaks.")
	}
	if len(e.DisplayName) > 100 {
		return apperr.Validation("displayName", "The employee name is too long (100 characters at most).")
	}
	var other int64
	err := tx.QueryRowContext(ctx, `SELECT id FROM employees WHERE display_name = ? COLLATE NOCASE AND id <> ?`, e.DisplayName, e.ID).Scan(&other)
	if err == nil {
		return apperr.Validation("displayName", "There is already an employee named %q. Use a different name (for example add a middle initial).", e.DisplayName)
	} else if !errors.Is(err, sql.ErrNoRows) {
		return err
	}

	// SSN: "" or the masked value keeps the stored number
	if e.SSN == "" || isMaskedSSN(e.SSN) {
		e.SSN = ""
		if old != nil {
			e.SSN = old.SSN
		}
	} else {
		if strings.Trim(e.SSN, "0123456789- ") != "" {
			return apperr.Validation("ssn", "The social security number can only contain digits.")
		}
		d := store.Digits(e.SSN)
		if len(d) != 9 {
			return apperr.Validation("ssn", "The social security number must have 9 digits.")
		}
		e.SSN = d
	}
	if e.SSN != "" && (old == nil || old.SSN != e.SSN) {
		if !validSSNPattern(e.SSN) {
			confirms = append(confirms, fmt.Sprintf("%s is not a valid social security number (the Social Security Administration never issues it).", store.FormatSSN(e.SSN)))
		}
		var dup string
		err := tx.QueryRowContext(ctx, `SELECT display_name FROM employees WHERE ssn = ? AND id <> ? ORDER BY id LIMIT 1`, e.SSN, e.ID).Scan(&dup)
		if err == nil {
			confirms = append(confirms, fmt.Sprintf("The social security number %s is already used by %s.", store.MaskSSN(e.SSN), dup))
		} else if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
	}

	for _, d := range []struct{ field, label, v string }{
		{"birthDate", "birth date", e.BirthDate}, {"hireDate", "hire date", e.HireDate},
		{"originalHireDate", "original hire date", e.OriginalHireDate}, {"releaseDate", "release date", e.ReleaseDate},
	} {
		if err := validOptionalDate(d.field, d.label, d.v); err != nil {
			return err
		}
	}
	if e.ReleaseDate != "" && e.HireDate != "" && e.ReleaseDate < e.HireDate {
		return apperr.Validation("releaseDate", "The release date cannot be before the hire date.")
	}
	if e.BirthDate != "" && e.BirthDate > store.Today() {
		return apperr.Validation("birthDate", "The birth date cannot be in the future.")
	}
	if e.Address.State != "" && !stateRe.MatchString(e.Address.State) {
		return apperr.Validation("address.state", "Use the 2-letter state code.")
	}
	if e.Email != "" && (!strings.Contains(e.Email, "@") || strings.ContainsAny(e.Email, " ,;")) {
		return apperr.Validation("email", "The email address is not valid.")
	}
	if len(e.Gender) > 20 {
		return apperr.Validation("gender", "Invalid gender.")
	}
	if e.EmploymentType == "" {
		e.EmploymentType = "regular"
	}
	if !employmentTypes[e.EmploymentType] {
		return apperr.Validation("employmentType", "The employee type must be regular, officer, statutory or owner.")
	}

	// pay schedule and frequency: an employee on a schedule is paid at its frequency
	if e.PayScheduleID != nil && *e.PayScheduleID <= 0 {
		e.PayScheduleID = nil
	}
	if e.PayScheduleID != nil {
		var freq string
		err := tx.QueryRowContext(ctx, `SELECT frequency FROM pay_schedules WHERE id = ?`, *e.PayScheduleID).Scan(&freq)
		if errors.Is(err, sql.ErrNoRows) {
			return apperr.Validation("payScheduleId", "The pay schedule does not exist.")
		} else if err != nil {
			return err
		}
		e.PayFrequency = freq
	}
	if e.PayFrequency == "" {
		return apperr.Validation("payFrequency", "Choose how often the employee is paid.")
	}
	if _, ok := model.PayPeriods[e.PayFrequency]; !ok {
		return apperr.Validation("payFrequency", "Unknown pay frequency %q.", e.PayFrequency)
	}

	// work state must have tax tables
	if e.WorkState == "" {
		return apperr.Validation("workState", "Choose the state where the employee works.")
	}
	st, err := stateTax(e.WorkState)
	if err != nil {
		return apperr.BadRequest("The tax tables could not be loaded: %v", err)
	}
	if st == nil {
		return apperr.Validation("workState", "There are no tax tables for the state %q.", e.WorkState)
	}

	// federal W-4
	w := &e.W4
	if w.Version == "" {
		w.Version = "2020"
	}
	switch w.Version {
	case "2020":
		if w.FilingStatus == "" {
			w.FilingStatus = "single"
		}
		if !fedStatus2020[w.FilingStatus] {
			return apperr.Validation("w4.filingStatus", "The filing status must be single, mfj (married filing jointly) or hoh (head of household).")
		}
		w.Allowances = 0
	case "pre2020":
		if w.FilingStatus == "" {
			w.FilingStatus = "single"
		}
		if !fedStatusPre2020[w.FilingStatus] {
			return apperr.Validation("w4.filingStatus", "The filing status must be single, married or married_single.")
		}
		w.Step2, w.Dependents, w.OtherIncome, w.Deductions = false, 0, 0, 0
	default:
		return apperr.Validation("w4.version", "The W-4 version must be 2020 (2020 or later) or pre2020 (2019 or earlier).")
	}
	if w.Allowances < 0 || w.Allowances > 99 {
		return apperr.Validation("w4.allowances", "The number of allowances must be between 0 and 99.")
	}
	// An exempt W-4 is good for the calendar year it was given in (it expires
	// February 15 of the next year): remember the year the exemption was claimed.
	switch {
	case !w.Exempt:
		w.ExemptYear = 0
	case w.ExemptYear > 0:
		if w.ExemptYear < 1900 || w.ExemptYear > 2200 {
			return apperr.Validation("w4.exemptYear", "Enter the year the employee claimed exemption from withholding.")
		}
	case old != nil && old.W4.Exempt && old.W4.ExemptYear > 0:
		w.ExemptYear = old.W4.ExemptYear // not sent: the year stored when the exemption was entered
	default:
		w.ExemptYear = store.Year(store.Today())
	}
	for _, f := range []struct {
		field string
		v     float64
	}{{"w4.dependents", w.Dependents}, {"w4.otherIncome", w.OtherIncome}, {"w4.deductions", w.Deductions}, {"w4.extraWithholding", w.ExtraWithholding}} {
		if f.v < 0 || f.v > 100000000 {
			return apperr.Validation(f.field, "The amount cannot be negative.")
		}
	}

	// state certificate
	sw := &e.StateW4
	if sw.Data == nil {
		sw.Data = map[string]any{}
	}
	if len(st.Income.Statuses) > 0 && sw.FilingStatus != "" {
		found := false
		for k := range st.Income.Statuses {
			if strings.EqualFold(k, sw.FilingStatus) {
				sw.FilingStatus = k
				found = true
			}
		}
		if !found {
			return apperr.Validation("stateW4.filingStatus", "%q is not a %s filing status.", sw.FilingStatus, e.WorkState)
		}
	}
	if sw.FilingStatus == "" && st.Income.Has && !st.Income.UsesFederalW4 {
		sw.FilingStatus = st.Income.DefaultStatus
	}
	if sw.Allowances < 0 || sw.Allowances > 99 {
		return apperr.Validation("stateW4.allowances", "The number of state allowances must be between 0 and 99.")
	}
	// CT-W4 line 3 and L-4 line 7 let the employee reduce the withholding
	// (a negative extra amount; the tax engine never goes below 0).
	if sw.ExtraWithholding < 0 && !stateAllowsReduction[e.WorkState] {
		return apperr.Validation("stateW4.extraWithholding", "The extra state withholding cannot be negative.")
	}

	// payroll items
	all, err := items.All(ctx, tx)
	if err != nil {
		return err
	}
	if e.Earnings == nil {
		e.Earnings = []model.EmployeeItem{}
	}
	if e.Items == nil {
		e.Items = []model.EmployeeItem{}
	}
	seen := map[int64]bool{}
	for i := range e.Earnings {
		it := &e.Earnings[i]
		p := all[it.ItemID]
		if p == nil {
			return apperr.Validation("earnings", "Earnings line %d: the payroll item does not exist.", i+1)
		}
		if !model.IsWageType(p.Type) {
			return apperr.Validation("earnings", "%s is not a wage item; add it under additions, deductions and company contributions.", p.Name)
		}
		if seen[p.ID] {
			return apperr.Validation("earnings", "%s is listed twice.", p.Name)
		}
		seen[p.ID] = true
		if it.Rate < 0 {
			return apperr.Validation("earnings", "%s: the rate cannot be negative.", p.Name)
		}
		if it.Qty != nil && *it.Qty < 0 {
			return apperr.Validation("earnings", "%s: the hours cannot be negative.", p.Name)
		}
		it.AnnualLimit = nil
		if (p.Type == model.ItemHourly || p.Type == model.ItemSalary) && it.Rate == 0 {
			confirms = append(confirms, fmt.Sprintf("%s has no rate (0.00).", p.Name))
		}
		it.ItemName, it.ItemType, it.Calc = p.Name, p.Type, p.Calc
	}
	for i := range e.Items {
		it := &e.Items[i]
		p := all[it.ItemID]
		if p == nil {
			return apperr.Validation("items", "Line %d: the payroll item does not exist.", i+1)
		}
		switch p.Type {
		case model.ItemAddition, model.ItemDeduction, model.ItemContribution, model.ItemOtherTax:
		default:
			if model.IsWageType(p.Type) {
				return apperr.Validation("items", "%s is a wage item; add it under earnings.", p.Name)
			}
			return apperr.Validation("items", "%s is calculated automatically from the employee's taxes and cannot be added here.", p.Name)
		}
		if seen[p.ID] {
			return apperr.Validation("items", "%s is listed twice.", p.Name)
		}
		seen[p.ID] = true
		if p.Type == model.ItemDeduction {
			// the Payroll Info grid shows deductions as negative numbers
			if it.Rate < 0 {
				it.Rate = -it.Rate
			}
			if it.AnnualLimit != nil && *it.AnnualLimit < 0 {
				v := -*it.AnnualLimit
				it.AnnualLimit = &v
			}
		}
		if it.Rate < 0 {
			return apperr.Validation("items", "%s: the amount or rate cannot be negative.", p.Name)
		}
		if (p.Calc == model.CalcPercent || p.Type == model.ItemOtherTax) && it.Rate > 100 {
			return apperr.Validation("items", "%s: the percent cannot be more than 100.", p.Name)
		}
		if it.AnnualLimit != nil && *it.AnnualLimit < 0 {
			return apperr.Validation("items", "%s: the limit cannot be negative.", p.Name)
		}
		if it.Qty != nil && *it.Qty < 0 {
			return apperr.Validation("items", "%s: the quantity cannot be negative.", p.Name)
		}
		it.ItemName, it.ItemType, it.Calc = p.Name, p.Type, p.Calc
	}

	// direct deposit: "" or a masked value keeps the stored number; clear
	// erases the stored bank information (Delete Direct Deposit Information)
	dd := &e.DirectDeposit
	keep := old
	if dd.Clear {
		*dd = model.DirectDeposit{AccountType: "checking"}
		keep = nil // nothing is kept from the stored record
	}
	if dd.AccountType == "" {
		dd.AccountType = "checking"
	}
	if dd.AccountType != "checking" && dd.AccountType != "savings" {
		return apperr.Validation("directDeposit.accountType", "The account type must be checking or savings.")
	}
	if dd.Routing == "" || isMaskedAccount(dd.Routing) {
		dd.Routing = ""
		if keep != nil {
			dd.Routing = keep.DirectDeposit.Routing
		}
	} else {
		d := store.Digits(dd.Routing)
		if strings.Trim(dd.Routing, "0123456789- ") != "" || !validRouting(d) {
			return apperr.Validation("directDeposit.routing", "The routing number must be a valid 9-digit bank routing number.")
		}
		dd.Routing = d
	}
	if dd.Account == "" || isMaskedAccount(dd.Account) {
		dd.Account = ""
		if keep != nil {
			dd.Account = keep.DirectDeposit.Account
		}
	} else {
		d := store.Digits(dd.Account)
		if strings.Trim(dd.Account, "0123456789- ") != "" || len(d) < 4 || len(d) > 17 {
			return apperr.Validation("directDeposit.account", "The bank account number must have 4 to 17 digits.")
		}
		dd.Account = d
	}
	if dd.Enabled && (dd.Routing == "" || dd.Account == "") {
		return apperr.Validation("directDeposit", "Enter the routing and account numbers to use direct deposit.")
	}

	if err := validatePTO("sick", &e.Sick); err != nil {
		return err
	}
	if err := validatePTO("vacation", &e.Vacation); err != nil {
		return err
	}
	if len(e.Notes) > 10000 {
		return apperr.Validation("notes", "The notes are too long.")
	}

	if len(confirms) > 0 && !force {
		return apperr.Confirm("%s Do you want to save the employee anyway?", strings.Join(confirms, " "))
	}
	return nil
}

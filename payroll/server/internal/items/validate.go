package items

import (
	"context"
	"database/sql"
	"errors"
	"regexp"
	"strconv"
	"strings"
	"time"

	"seriexpayroll/internal/apperr"
	"seriexpayroll/internal/model"
	"seriexpayroll/internal/taxes"
)

var trackingTypes = map[string]bool{
	model.TrackCompensation: true, model.TrackNone: true, model.TrackReportedTips: true, model.TrackPaidTips: true,
	model.TrackOvertime: true, model.Track401k: true, model.Track403b: true, model.Track457b: true, model.TrackRoth401k: true,
	model.TrackRoth403b: true, model.TrackSimpleIRA: true, model.Track125: true, model.TrackHSA: true,
	model.TrackDependentCare: true, model.TrackGroupTermLife: true, model.TrackHealthCoverage: true, model.TrackFringe: true,
	model.TrackOther: true,
}

// W-2 box 12 codes (2026 Instructions for Forms W-2 and W-3, including the
// new codes TA, TP and TT).
var box12Codes = map[string]bool{}

func init() {
	for _, c := range strings.Fields("A B C D E F G H J K L M N P Q R S T V W Y Z AA BB DD EE FF GG HH II TA TP TT") {
		box12Codes[c] = true
	}
}

var groupRe = regexp.MustCompile(`^(federal_941|federal_940|unassigned|state_wh:[A-Z]{2}|state_ui:[A-Z]{2}|vendor:[1-9][0-9]*)$`)

// stateTables returns the built-in tables of a state for the current year
// (nil when the state is unknown). err is set when the tax tables cannot be loaded.
func stateTables(state string) (*model.StateTax, error) {
	tables, _, err := taxes.Tables(time.Now().Year())
	if err != nil {
		return nil, err
	}
	st, ok := tables.States[strings.ToUpper(state)]
	if !ok {
		return nil, nil
	}
	return &st, nil
}

// normalize cleans an item sent by the client and checks the rules that do
// not need the database. Fields that do not apply to the item type are cleared.
func normalize(it *model.PayrollItem) error {
	it.Name = strings.TrimSpace(it.Name)
	it.Type = strings.TrimSpace(it.Type)
	it.TaxCode = strings.ToUpper(strings.TrimSpace(it.TaxCode))
	it.State = strings.ToUpper(strings.TrimSpace(it.State))
	it.TaxKey = strings.TrimSpace(it.TaxKey)
	it.Pto = strings.TrimSpace(it.Pto)
	it.Calc = strings.TrimSpace(it.Calc)
	it.TaxTracking = strings.TrimSpace(it.TaxTracking)
	it.W2Box12 = strings.ToUpper(strings.TrimSpace(it.W2Box12))
	it.W2Box14 = strings.TrimSpace(it.W2Box14)
	it.PaymentGroup = strings.TrimSpace(it.PaymentGroup)
	it.LimitKind = strings.TrimSpace(it.LimitKind)
	// (ro) fields sent back by the client are recomputed by the server
	it.Category, it.EffectiveGroup = "", ""
	it.ExpenseAccountName, it.LiabilityAccountName, it.AgencyName = "", "", ""
	it.HasPaychecks = false

	if it.Name == "" {
		return apperr.Validation("name", "Enter a name for the payroll item.")
	}
	if len(it.Name) > 100 {
		return apperr.Validation("name", "The payroll item name is too long (100 characters at most).")
	}
	if strings.ContainsAny(it.Name, ":\n\r\t") {
		return apperr.Validation("name", "The payroll item name cannot contain a colon or line breaks.")
	}
	if !validType(it.Type) {
		return apperr.Validation("type", "Choose a payroll item type.")
	}
	if it.Type == model.ItemDeduction {
		// deduction amounts and limits are shown as negative numbers in the item window
		if it.Rate < 0 {
			it.Rate = -it.Rate
		}
		if it.AnnualLimit != nil && *it.AnnualLimit < 0 {
			v := -*it.AnnualLimit
			it.AnnualLimit = &v
		}
	}
	if it.Rate < 0 {
		return apperr.Validation("rate", "The rate or amount cannot be negative.")
	}
	if it.AnnualLimit != nil && *it.AnnualLimit < 0 {
		return apperr.Validation("annualLimit", "The limit cannot be negative.")
	}
	switch it.LimitKind {
	case "":
		it.LimitKind = "annual"
	case "annual", "one_time":
	default:
		return apperr.Validation("limitKind", "The limit type must be annual or one_time.")
	}
	if it.TaxTracking == "" {
		it.TaxTracking = model.TrackCompensation
		if it.Type == model.ItemDeduction {
			it.TaxTracking = model.TrackOther // a plain after-tax deduction
		}
	}
	if !trackingTypes[it.TaxTracking] {
		return apperr.Validation("taxTracking", "Unknown tax treatment %q.", it.TaxTracking)
	}
	if it.W2Box12 != "" && !box12Codes[it.W2Box12] {
		return apperr.Validation("w2Box12", "%q is not a W-2 box 12 code.", it.W2Box12)
	}
	if len(it.W2Box14) > 40 {
		return apperr.Validation("w2Box14", "The W-2 box 14 label is too long.")
	}

	isTax := it.Type == model.ItemFederalTax || it.Type == model.ItemStateTax || it.Type == model.ItemOtherTax
	wage := model.IsWageType(it.Type)
	// fields that only some types have
	if !wage {
		it.Pto = ""
		it.Supplemental = false
	}
	it.NotPaid = it.Type == model.ItemReportedTips
	if it.Type != model.ItemContribution {
		it.MatchItemID = nil
		it.MatchCapPct = 0
	}
	if !isTax {
		it.TaxCode, it.TaxKey = "", ""
		if it.Type != model.ItemDeduction && it.Type != model.ItemContribution && it.Type != model.ItemAddition {
			it.State = ""
		}
	}
	if wage || it.Type == model.ItemAddition {
		it.LiabilityAccountID = nil
		it.AgencyVendorID = nil
		it.PaymentGroup = ""
	}
	if wage {
		it.AnnualLimit = nil
	}
	if isTax {
		it.Taxability = map[string]bool{}
		it.Pto = ""
		if it.Type != model.ItemOtherTax {
			it.AnnualLimit = nil
		}
	} else if it.Taxability == nil {
		it.Taxability = DefaultTaxability(it.TaxTracking, it.Type)
	}

	switch it.Pto {
	case "":
	case "sick", "vacation":
		if it.Type != model.ItemHourly && it.Type != model.ItemSalary {
			return apperr.Validation("pto", "Only hourly and salary wage items can use sick or vacation hours.")
		}
	default:
		return apperr.Validation("pto", "The paid time off kind must be sick or vacation.")
	}

	switch {
	case wage:
		switch it.Type {
		case model.ItemCommission:
			if it.Calc != model.CalcFixed && it.Calc != model.CalcQuantity {
				it.Calc = model.CalcQuantity
			}
		default:
			it.Calc = model.CalcFixed
		}
		if it.Type == model.ItemOvertime && it.Rate <= 0 {
			return apperr.Validation("rate", "Enter the overtime multiplier of the regular hourly rate (for example 1.5).")
		}
	case it.Type == model.ItemAddition || it.Type == model.ItemDeduction:
		if it.Calc == "" {
			it.Calc = model.CalcFixed
		}
		switch it.Calc {
		case model.CalcFixed, model.CalcPercent, model.CalcPerHour, model.CalcQuantity:
		default:
			return apperr.Validation("calc", "The calculation must be fixed amount, percent of gross, per hour or quantity.")
		}
	case it.Type == model.ItemContribution:
		if it.Calc == "" {
			it.Calc = model.CalcFixed
		}
		switch it.Calc {
		case model.CalcFixed, model.CalcPercent, model.CalcPerHour, model.CalcQuantity:
		case model.CalcMatch:
			if it.MatchItemID == nil || *it.MatchItemID <= 0 {
				return apperr.Validation("matchItemId", "Choose the employee deduction this contribution matches.")
			}
			if it.MatchCapPct < 0 || it.MatchCapPct > 100 {
				return apperr.Validation("matchCapPct", "The match limit must be a percent of gross pay between 0 and 100.")
			}
			if it.Rate <= 0 {
				return apperr.Validation("rate", "Enter the percent of the employee deduction the company matches.")
			}
		default:
			return apperr.Validation("calc", "The calculation must be fixed amount, percent of gross, per hour, quantity or match.")
		}
		if it.Calc != model.CalcMatch {
			it.MatchItemID = nil
			it.MatchCapPct = 0
		}
	default: // tax items
		it.Calc = model.CalcTax
	}
	if (it.Calc == model.CalcPercent || it.Type == model.ItemOtherTax || it.Calc == model.CalcTax) && it.Rate > 100 {
		return apperr.Validation("rate", "The percent cannot be more than 100.")
	}

	switch it.Type {
	case model.ItemFederalTax:
		if !isFederalCode(it.TaxCode) {
			return apperr.Validation("taxCode", "Choose the federal tax this item tracks.")
		}
		it.State, it.TaxKey = "", ""
		it.Rate = 0
	case model.ItemStateTax:
		if !isStateCode(it.TaxCode) {
			return apperr.Validation("taxCode", "Choose the state tax this item tracks.")
		}
		if it.State == "" {
			return apperr.Validation("state", "Choose the state of this tax.")
		}
		if it.TaxCode == model.TaxStateEE || it.TaxCode == model.TaxStateER {
			if it.TaxKey == "" {
				return apperr.Validation("taxKey", "Choose the state program (disability, family leave...) this item tracks.")
			}
		} else {
			it.TaxKey = ""
		}
		if it.TaxCode == model.TaxSIT || it.TaxCode == model.TaxSUIEE {
			it.Rate = 0 // computed from the tables and the employee's certificate
		}
	case model.ItemOtherTax:
		if it.TaxCode == "" {
			it.TaxCode = model.TaxLocalEE
		}
		if !isLocalCode(it.TaxCode) {
			return apperr.Validation("taxCode", "A local tax is paid by the employee (LOCAL_EE) or by the company (LOCAL_ER).")
		}
		it.TaxKey = ""
	}

	// accounts
	cat := model.ItemCategory(it.Type, it.TaxCode)
	switch cat {
	case model.CatEarning, model.CatAddition:
		if it.ExpenseAccountID == nil || *it.ExpenseAccountID <= 0 {
			return apperr.Validation("expenseAccountId", "Choose the expense account for this item.")
		}
	case model.CatDeduction, model.CatEmployeeTax:
		if it.LiabilityAccountID == nil || *it.LiabilityAccountID <= 0 {
			return apperr.Validation("liabilityAccountId", "Choose the liability account for this item.")
		}
	case model.CatEmployerTax, model.CatContribution:
		if it.ExpenseAccountID == nil || *it.ExpenseAccountID <= 0 {
			return apperr.Validation("expenseAccountId", "Choose the expense account for this item.")
		}
		if it.LiabilityAccountID == nil || *it.LiabilityAccountID <= 0 {
			return apperr.Validation("liabilityAccountId", "Choose the liability account for this item.")
		}
	}
	if cat == model.CatEmployeeTax && it.Type != model.ItemOtherTax {
		it.ExpenseAccountID = nil
	}
	if it.AgencyVendorID != nil && *it.AgencyVendorID <= 0 {
		it.AgencyVendorID = nil
	}

	// state programs: their vendor payment group follows the agency (checkItem)
	if (it.TaxCode == model.TaxStateEE || it.TaxCode == model.TaxStateER) && strings.HasPrefix(it.PaymentGroup, "vendor:") {
		it.PaymentGroup = ""
	}
	if it.PaymentGroup != "" {
		if !groupRe.MatchString(it.PaymentGroup) {
			return apperr.Validation("paymentGroup", "Unknown payment group %q.", it.PaymentGroup)
		}
		if strings.HasPrefix(it.PaymentGroup, "vendor:") {
			id, _ := strconv.ParseInt(strings.TrimPrefix(it.PaymentGroup, "vendor:"), 10, 64)
			if it.AgencyVendorID == nil || *it.AgencyVendorID != id {
				return apperr.Validation("paymentGroup", "A vendor payment group must be the item's own agency (vendor:<agency id>).")
			}
		}
		if model.DefaultPaymentGroup(it) == it.PaymentGroup {
			it.PaymentGroup = "" // same as the default: keep following the agency
		}
	}
	return nil
}

// checkItem runs the rules that need the database (inside the write transaction).
func checkItem(ctx context.Context, tx *sql.Tx, it *model.PayrollItem, old *model.PayrollItem) error {
	var other int64
	err := tx.QueryRowContext(ctx, `SELECT id FROM payroll_items WHERE name = ? COLLATE NOCASE AND id <> ?`, it.Name, it.ID).Scan(&other)
	if err == nil {
		return apperr.Validation("name", "There is already a payroll item named %q. Please use a different name.", it.Name)
	} else if !errors.Is(err, sql.ErrNoRows) {
		return err
	}

	if old != nil && old.Type != it.Type {
		// A used item keeps its type: employee records, the employee defaults
		// and recorded transactions read its rate and amounts by type (an
		// hourly rate would become a deduction amount).
		where, err := usage(ctx, tx, it.ID)
		if err != nil {
			return err
		}
		if where != "" {
			return apperr.Conflict("This payroll item is used in %s, so its type cannot be changed. Create a new item instead.", where)
		}
	}
	if old != nil && (old.TaxCode != it.TaxCode || old.State != it.State || !strings.EqualFold(old.TaxKey, it.TaxKey)) {
		where, err := usedInTransactions(ctx, tx, it.ID)
		if err != nil {
			return err
		}
		if where != "" {
			return apperr.Conflict("This payroll item has been used in %s, so its tax and state cannot be changed. Create a new item instead.", where)
		}
	}

	if it.Type == model.ItemStateTax || (it.State != "" && it.Type != model.ItemOtherTax) {
		st, err := stateTables(it.State)
		if err != nil {
			return apperr.BadRequest("The tax tables could not be loaded: %v", err)
		}
		if st == nil {
			return apperr.Validation("state", "There are no tax tables for the state %q.", it.State)
		}
		if it.TaxCode == model.TaxStateEE || it.TaxCode == model.TaxStateER {
			found := false
			for _, p := range st.Programs {
				if strings.EqualFold(p.Key, it.TaxKey) {
					it.TaxKey = p.Key
					found = true
				}
			}
			if !found {
				return apperr.Validation("taxKey", "%s has no state program %q in the tax tables.", it.State, it.TaxKey)
			}
		}
	}

	if err := programGroup(ctx, tx, it); err != nil {
		return err
	}

	if it.MatchItemID != nil {
		if *it.MatchItemID == it.ID {
			return apperr.Validation("matchItemId", "A contribution cannot match itself.")
		}
		m, err := Get(ctx, tx, *it.MatchItemID)
		if errors.Is(err, sql.ErrNoRows) {
			return apperr.Validation("matchItemId", "The matched deduction does not exist.")
		} else if err != nil {
			return err
		}
		if m.Type != model.ItemDeduction {
			return apperr.Validation("matchItemId", "A company match must match an employee deduction item.")
		}
	}

	// one active item per federal/state tax (code + state + program)
	if it.Active && (it.Type == model.ItemFederalTax || it.Type == model.ItemStateTax) {
		rows, err := tx.QueryContext(ctx, `SELECT id, name, tax_code, state, tax_key FROM payroll_items
			WHERE active = 1 AND type IN (?, ?) AND tax_code = ? AND id <> ?`, model.ItemFederalTax, model.ItemStateTax, it.TaxCode, it.ID)
		if err != nil {
			return err
		}
		defer rows.Close()
		me := taxIdentity(it.TaxCode, it.State, it.TaxKey)
		for rows.Next() {
			var id int64
			var name, code, st, key string
			if err := rows.Scan(&id, &name, &code, &st, &key); err != nil {
				return err
			}
			if taxIdentity(code, st, key) == me {
				return apperr.Validation("taxCode", "The active payroll item %q already tracks this tax. Make it inactive first or edit it instead.", name)
			}
		}
		if err := rows.Err(); err != nil {
			return err
		}
	}
	return nil
}

// programGroup: a state program collected for an insurer or another agency
// (NY DBL / PFL insurer, a private disability plan) is paid to its own agency,
// not with the state unemployment tax. When the item's agency is not the payee
// of the state's unemployment payment group, the item is paid in the vendor
// group of its agency; with the state's payee (or no agency) it stays in the
// state group.
func programGroup(ctx context.Context, tx *sql.Tx, it *model.PayrollItem) error {
	if it.Type != model.ItemStateTax || (it.TaxCode != model.TaxStateEE && it.TaxCode != model.TaxStateER) || it.PaymentGroup != "" {
		return nil
	}
	if it.AgencyVendorID == nil || *it.AgencyVendorID <= 0 {
		return nil
	}
	group := "state_ui:" + it.State
	var payee sql.NullInt64
	err := tx.QueryRowContext(ctx, `SELECT agency_vendor_id FROM payment_schedules WHERE payment_group = ?`, group).Scan(&payee)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if !payee.Valid {
		// no schedule saved yet: the agency of the state's unemployment tax item
		err := tx.QueryRowContext(ctx, `SELECT agency_vendor_id FROM payroll_items WHERE type = ? AND tax_code = ? AND state = ?
			AND agency_vendor_id IS NOT NULL ORDER BY active DESC, id LIMIT 1`, model.ItemStateTax, model.TaxSUIER, it.State).Scan(&payee)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
	}
	if payee.Valid && payee.Int64 != *it.AgencyVendorID {
		it.PaymentGroup = "vendor:" + strconv.FormatInt(*it.AgencyVendorID, 10)
	}
	return nil
}

// usedMessage is the conflict returned when a used item is deleted.
func usedMessage(where string) error {
	return apperr.Conflict("This payroll item is used in %s and cannot be deleted. You can make it inactive instead.", where)
}

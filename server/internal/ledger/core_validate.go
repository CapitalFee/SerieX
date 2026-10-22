package ledger

import (
	"fmt"
	"math"
	"strings"
	"unicode/utf8"

	"seriex/internal/apperr"
	"seriex/internal/model"
	"seriex/internal/store"
)

// name kinds required per type
func requiredNameKind(t string) (kind string, required bool) {
	switch t {
	case model.TxInvoice, model.TxPayment, model.TxCreditMemo, model.TxStatementCharge, model.TxEstimate, model.TxRefund:
		return model.NameCustomer, true
	case model.TxBill, model.TxVendorCredit, model.TxBillPayment, model.TxItemReceipt, model.TxPurchaseOrder, model.TxSalesTaxPayment:
		return model.NameVendor, true
	case model.TxSalesReceipt:
		return model.NameCustomer, false
	}
	return "", false
}

func lineErr(i int, format string, args ...any) error {
	return apperr.Validation("lines", "Line %d: %s", i+1, fmt.Sprintf(format, args...))
}

// Text length limits of transaction fields (characters).
const (
	maxRefLen     = 20
	maxMemoLen    = 4095
	maxAddressLen = 1000
	maxShortLen   = 100
)

// checkNumbers refuses amounts and quantities the books cannot store exactly
// (before they are converted to cents).
func checkNumbers(t *model.Txn) error {
	if err := store.MoneyErr("amount", "The amount", t.Amount); err != nil {
		return err
	}
	if err := store.MoneyErr("cashBackAmount", "The cash back amount", t.CashBackAmount); err != nil {
		return err
	}
	for i, l := range t.Lines {
		lbl := fmt.Sprintf("Line %d: the amount", i+1)
		if err := store.MoneyErr("lines", lbl, l.Amount); err != nil {
			return err
		}
		if l.Qty != nil {
			if err := store.QtyErr("lines", fmt.Sprintf("Line %d: the quantity", i+1), *l.Qty); err != nil {
				return err
			}
		}
		if l.Rate != nil {
			if err := store.MoneyErr("lines", fmt.Sprintf("Line %d: the rate", i+1), *l.Rate); err != nil {
				return err
			}
			if l.Qty != nil && !l.RateIsPercent {
				if err := store.MoneyErr("lines", fmt.Sprintf("Line %d: quantity × rate", i+1), *l.Qty**l.Rate); err != nil {
					return err
				}
			}
		}
	}
	for _, l := range t.Links {
		if err := store.MoneyErr("links", "An applied amount", l.Amount); err != nil {
			return err
		}
		if err := store.MoneyErr("links", "A discount", l.Discount); err != nil {
			return err
		}
	}
	return nil
}

// checkLengths refuses text fields longer than the books keep.
func checkLengths(s *stxn) error {
	long := func(v string, n int) bool { return utf8.RuneCountInString(v) > n }
	switch {
	case long(s.Ref, maxRefLen):
		return apperr.Validation("refNumber", "The number is too long (%d characters maximum).", maxRefLen)
	case long(s.Memo, maxMemoLen):
		return apperr.Validation("memo", "The memo is too long (%d characters maximum).", maxMemoLen)
	case long(s.BillAddress, maxAddressLen):
		return apperr.Validation("billAddress", "The address is too long (%d characters maximum).", maxAddressLen)
	case long(s.ShipAddress, maxAddressLen):
		return apperr.Validation("shipAddress", "The ship-to address is too long (%d characters maximum).", maxAddressLen)
	case long(s.PONumber, 25):
		return apperr.Validation("poNumber", "The P.O. number is too long (25 characters maximum).")
	case long(s.FOB, maxShortLen):
		return apperr.Validation("fob", "The F.O.B. is too long (%d characters maximum).", maxShortLen)
	case long(s.CashBackMemo, maxMemoLen):
		return apperr.Validation("cashBackMemo", "The cash back memo is too long (%d characters maximum).", maxMemoLen)
	case long(s.Template, maxShortLen):
		return apperr.Validation("template", "The template name is too long (%d characters maximum).", maxShortLen)
	}
	for i, l := range s.Lines {
		if long(l.Description, maxMemoLen) {
			return lineErr(i, "the description is too long (%d characters maximum).", maxMemoLen)
		}
		if long(l.RefNumber, maxRefLen) {
			return lineErr(i, "the number is too long (%d characters maximum).", maxRefLen)
		}
	}
	return nil
}

// checkTotals refuses computed amounts beyond the limit (sums of many large lines).
func checkTotals(s *stxn) error {
	const max = int64(999_999_999_999)
	if abs64(s.Amount) > max || abs64(s.Subtotal) > max || abs64(s.TaxAmount) > max {
		return apperr.Validation("lines", "The total of this transaction is too large. The largest amount allowed is 9,999,999,999.99.")
	}
	for i, l := range s.Lines {
		if abs64(l.Amount) > max {
			return lineErr(i, "the amount is too large. The largest amount allowed is 9,999,999,999.99.")
		}
	}
	return nil
}

// validate checks the input before the amounts are computed.
func (e *env) validate(s *stxn, old *stxn) error {
	t := s.Type
	if err := checkLengths(s); err != nil {
		return err
	}
	if !store.ValidDate(s.Date) {
		return apperr.Validation("date", "Please enter a valid date for this transaction.")
	}
	if s.DueDate != "" && !store.ValidDate(s.DueDate) {
		return apperr.Validation("dueDate", "Please enter a valid due date.")
	}
	if s.ShipDate != "" && !store.ValidDate(s.ShipDate) {
		return apperr.Validation("shipDate", "Please enter a valid ship date.")
	}

	// name
	nm, err := e.name(s.NameID)
	if err != nil {
		return err
	}
	if s.NameID != 0 && nm == nil {
		return apperr.Validation("nameId", "The name you selected no longer exists. Please choose another one.")
	}
	kind, required := requiredNameKind(t)
	if kind != "" {
		label := "customer or job"
		if kind == model.NameVendor {
			label = "vendor"
			if t == model.TxSalesTaxPayment {
				label = "sales tax agency (vendor)"
			}
		}
		if nm == nil && required {
			return apperr.Validation("nameId", "Please choose a %s for this transaction.", label)
		}
		if nm != nil && nm.Kind != kind {
			return apperr.Validation("nameId", "%s is not a %s. Please choose a %s.", e.nameFull(s.NameID), strings.Split(label, " (")[0], label)
		}
	}

	// list entries
	for _, f := range []struct {
		id    int64
		field string
	}{{s.TermsID, "termsId"}, {s.ClassID, "classId"}, {s.RepID, "repId"}, {s.ShipViaID, "shipViaId"},
		{s.CustMsgID, "customerMessageId"}, {s.PayMethodID, "paymentMethodId"}} {
		ok, err := e.listExists(f.id)
		if err != nil {
			return err
		}
		if !ok {
			return apperr.Validation(f.field, "The selected list entry no longer exists. Please choose another one.")
		}
	}

	// header accounts
	if err := e.validateHeaderAccounts(s); err != nil {
		return err
	}

	// tax item
	if s.TaxItemID != 0 {
		it, err := e.item(s.TaxItemID)
		if err != nil {
			return err
		}
		if it == nil || (it.Type != model.ItemSalesTax && it.Type != model.ItemSalesTaxGroup) {
			return apperr.Validation("taxItemId", "Please choose a sales tax item or sales tax group.")
		}
	}

	// lines
	needLines := isSalesForm(t) || isPurchaseForm(t) || typeIn(t, model.TxPurchaseOrder, model.TxDeposit, model.TxInventoryAdjust, model.TxJournal)
	if needLines && len(s.Lines) == 0 && !s.Voided {
		return apperr.Validation("lines", "You cannot record a blank transaction. Please enter at least one line.")
	}
	if t == model.TxSalesTaxPayment && len(s.Lines) == 0 && s.Amount == 0 {
		return apperr.Validation("lines", "You cannot record a blank transaction. Please enter the sales tax to pay.")
	}
	for i := range s.Lines {
		if err := e.validateLine(s, i); err != nil {
			return err
		}
	}
	switch t {
	case model.TxJournal:
		if len(s.Lines) < 2 {
			return apperr.Validation("lines", "A journal entry needs at least two lines: one debit and one credit.")
		}
		var debits, credits int64
		for _, l := range s.Lines {
			if l.Amount > 0 {
				debits += l.Amount
			} else {
				credits -= l.Amount
			}
		}
		if debits != credits {
			return apperr.Validation("lines", "Transaction not in balance. The total debits (%s) must equal the total credits (%s).", fmtMoney(debits), fmtMoney(credits))
		}
	case model.TxTransfer:
		if s.Amount <= 0 && !s.Voided {
			return apperr.Validation("amount", "Please enter the amount to transfer.")
		}
	case model.TxPayment:
		if s.Amount < 0 {
			return apperr.Validation("amount", "The payment amount cannot be negative.")
		}
	case model.TxRefund, model.TxBillPayment:
		if s.Amount < 0 {
			return apperr.Validation("amount", "The amount cannot be negative.")
		}
	case model.TxDeposit:
		if s.CashBackAmount < 0 {
			return apperr.Validation("cashBackAmount", "The cash back amount cannot be negative.")
		}
		if s.CashBackAmount != 0 {
			a, err := e.acct(s.CashBackAcctID)
			if err != nil {
				return err
			}
			if a == nil {
				return apperr.Validation("cashBackAccountId", "Please choose an account for the cash back amount.")
			}
			if a.Type == model.AcctAR || a.Type == model.AcctAP || a.Type == model.AcctNonPosting {
				return apperr.Validation("cashBackAccountId", "Cash back cannot go to an %s account.", a.Type)
			}
		}
	}
	return nil
}

func (e *env) validateHeaderAccounts(s *stxn) error {
	need := func(id int64, field, msg string, types ...string) (*acctInfo, error) {
		a, err := e.acct(id)
		if err != nil {
			return nil, err
		}
		if a == nil || (len(types) > 0 && !typeIn(a.Type, types...)) {
			return nil, apperr.Validation(field, "%s", msg)
		}
		return a, nil
	}
	var err error
	switch s.Type {
	case model.TxInvoice, model.TxCreditMemo, model.TxStatementCharge:
		_, err = need(s.AccountID, "accountId", "Please choose an Accounts Receivable account.", model.AcctAR)
	case model.TxSalesReceipt:
		_, err = need(s.AccountID, "accountId", "Please choose the account to deposit this sale to.", model.AcctBank, model.AcctOCA)
	case model.TxPayment:
		if _, err = need(s.ArApID, "arApAccountId", "Please choose an Accounts Receivable account.", model.AcctAR); err == nil {
			_, err = need(s.AccountID, "accountId", "Please choose the account to deposit this payment to.", model.AcctBank, model.AcctOCA)
		}
	case model.TxRefund:
		if _, err = need(s.ArApID, "arApAccountId", "Please choose an Accounts Receivable account.", model.AcctAR); err == nil {
			_, err = need(s.AccountID, "accountId", "Please choose the bank or credit card account the refund is issued from.", model.AcctBank, model.AcctCreditCard)
		}
	case model.TxBill, model.TxVendorCredit, model.TxItemReceipt:
		_, err = need(s.AccountID, "accountId", "Please choose an Accounts Payable account.", model.AcctAP)
	case model.TxBillPayment:
		if _, err = need(s.ArApID, "arApAccountId", "Please choose an Accounts Payable account.", model.AcctAP); err == nil {
			_, err = need(s.AccountID, "accountId", "Please choose the bank or credit card account to pay from.", model.AcctBank, model.AcctCreditCard)
		}
	case model.TxCheck:
		_, err = need(s.AccountID, "accountId", "Please choose a bank account.", model.AcctBank)
	case model.TxSalesTaxPayment:
		_, err = need(s.AccountID, "accountId", "Please choose the bank account to pay the sales tax from.", model.AcctBank)
	case model.TxCCCharge, model.TxCCCredit:
		_, err = need(s.AccountID, "accountId", "Please choose a credit card account.", model.AcctCreditCard)
	case model.TxDeposit:
		var a *acctInfo
		if a, err = need(s.AccountID, "accountId", "Please choose the bank account to deposit to.", model.AcctBank, model.AcctOCA); err == nil && a.Special == store.SpecialUndepositedFunds {
			err = apperr.Validation("accountId", "You cannot deposit to Undeposited Funds. Please choose a bank account.")
		}
	case model.TxTransfer:
		var from, to *acctInfo
		if from, err = need(s.AccountID, "accountId", "Please choose the account to transfer funds from."); err != nil {
			return err
		}
		if to, err = need(s.ToAcctID, "toAccountId", "Please choose the account to transfer funds to."); err != nil {
			return err
		}
		if from.ID == to.ID {
			return apperr.Validation("toAccountId", "The accounts to transfer funds from and to must be different.")
		}
		for _, a := range []*acctInfo{from, to} {
			if !model.IsBalanceSheet(a.Type) || a.Type == model.AcctAR || a.Type == model.AcctAP {
				return apperr.Validation("toAccountId", "Funds can only be transferred between bank, asset, liability, credit card and equity accounts (not Accounts Receivable or Accounts Payable).")
			}
		}
	case model.TxInventoryAdjust:
		var a *acctInfo
		if a, err = need(s.AccountID, "accountId", "Please choose an adjustment account."); err == nil &&
			typeIn(a.Type, model.AcctAR, model.AcctAP, model.AcctNonPosting) {
			err = apperr.Validation("accountId", "An inventory adjustment cannot use an %s account.", a.Type)
		}
	}
	return err
}

// lineAccount checks a line account: lines may not post to A/R, A/P or
// non-posting accounts (journal entries may use A/R and A/P).
func (e *env) lineAccount(i int, id int64, journal bool) (*acctInfo, error) {
	a, err := e.acct(id)
	if err != nil {
		return nil, err
	}
	if a == nil {
		return nil, lineErr(i, "please choose an account.")
	}
	if a.Type == model.AcctNonPosting {
		return nil, lineErr(i, "%s is a non-posting account and cannot be used here.", e.acctFull(id))
	}
	if !journal && (a.Type == model.AcctAR || a.Type == model.AcctAP) {
		return nil, lineErr(i, "you cannot use the %s account %s on this line. Use a %s instead.", a.Type, e.acctFull(id),
			map[string]string{model.AcctAR: "customer transaction", model.AcctAP: "vendor transaction"}[a.Type])
	}
	return a, nil
}

func (e *env) validateLine(s *stxn, i int) error {
	l := &s.Lines[i]
	t := s.Type
	if l.ServiceDate != "" && !store.ValidDate(l.ServiceDate) {
		return lineErr(i, "the service date is not valid.")
	}
	for _, id := range []int64{l.ClassID, l.PayMethodID} {
		ok, err := e.listExists(id)
		if err != nil {
			return err
		}
		if !ok {
			return lineErr(i, "the selected class or payment method no longer exists.")
		}
	}
	if l.NameID != 0 {
		n, err := e.name(l.NameID)
		if err != nil {
			return err
		}
		if n == nil {
			return lineErr(i, "the name no longer exists.")
		}
		if (isPurchaseForm(t) || t == model.TxPurchaseOrder) && n.Kind != model.NameCustomer {
			return lineErr(i, "%s is not a customer or job.", e.nameFull(l.NameID))
		}
	}
	it, err := e.item(l.ItemID)
	if err != nil {
		return err
	}
	if l.ItemID != 0 && it == nil {
		return lineErr(i, "the item no longer exists.")
	}
	// amount = quantity x rate (the client computes it; forms round the rate to
	// 5 decimals when the amount is typed, so allow that much difference)
	if (isSalesForm(t) || isPurchaseForm(t) || t == model.TxPurchaseOrder) && l.Qty != nil && l.Rate != nil && !l.RateIsPercent &&
		(it == nil || !typeIn(it.Type, model.ItemSubtotal, model.ItemPayment, model.ItemSalesTax, model.ItemSalesTaxGroup)) {
		want := *l.Qty * *l.Rate
		tol := 0.5 + math.Abs(*l.Qty)*0.0005 // cents
		if math.Abs(float64(l.Amount)-want*100) > tol {
			return lineErr(i, "the amount (%s) does not equal quantity × rate (%s × %s = %s).", fmtMoney(l.Amount),
				fmtQty(*l.Qty), strconvRate(*l.Rate), fmtMoney(rnd(want*100)))
		}
	}

	switch {
	case t == model.TxJournal:
		a, err := e.lineAccount(i, l.AccountID, true)
		if err != nil {
			return err
		}
		if a.Type == model.AcctAR || a.Type == model.AcctAP {
			want, label := model.NameCustomer, "customer"
			if a.Type == model.AcctAP {
				want, label = model.NameVendor, "vendor"
			}
			n, _ := e.name(l.NameID)
			if n == nil || n.Kind != want {
				return lineErr(i, "when you use %s in a journal entry, you must choose a %s in the Name column.", e.acctFull(l.AccountID), label)
			}
		}
	case t == model.TxDeposit:
		if _, err := e.lineAccount(i, l.AccountID, false); err != nil {
			return err
		}
	case l.Kind == model.LineExpense:
		if _, err := e.lineAccount(i, l.AccountID, false); err != nil {
			return err
		}
	case t == model.TxInventoryAdjust:
		if it == nil || it.Type != model.ItemInventoryPart {
			return lineErr(i, "please choose an inventory part.")
		}
		if !s.valueAdjust() && (l.Qty == nil || *l.Qty == 0) {
			return lineErr(i, "please enter the change in quantity.")
		}
	case t == model.TxSalesTaxPayment:
		if it == nil {
			if l.AccountID == 0 {
				return lineErr(i, "please choose a sales tax item.")
			}
			if _, err := e.lineAccount(i, l.AccountID, false); err != nil {
				return err
			}
		} else if it.Type != model.ItemSalesTax {
			return lineErr(i, "%s is not a sales tax item.", e.itemFull(it.ID))
		}
	case isPurchaseForm(t) || t == model.TxPurchaseOrder:
		if it == nil {
			if l.AccountID != 0 {
				if _, err := e.lineAccount(i, l.AccountID, false); err != nil {
					return err
				}
			} else if l.Amount != 0 {
				return lineErr(i, "please choose an item.")
			}
			break
		}
		switch it.Type {
		case model.ItemPayment, model.ItemSalesTaxGroup:
			return lineErr(i, "%s items cannot be used on purchase forms.", it.Type)
		case model.ItemSubtotal:
		default:
			if t != model.TxPurchaseOrder {
				acct := purchaseAccount(it)
				if acct == 0 && it.Type != model.ItemInventoryPart {
					return lineErr(i, "the item %s has no expense account. Edit the item and choose one.", e.itemFull(it.ID))
				}
			}
		}
	case isSalesForm(t):
		if it == nil {
			if l.AccountID != 0 {
				if _, err := e.lineAccount(i, l.AccountID, false); err != nil {
					return err
				}
			} else if l.Amount != 0 {
				return lineErr(i, "this line has an amount but no item. Please choose an item.")
			}
			break
		}
		switch it.Type {
		case model.ItemSubtotal, model.ItemPayment, model.ItemSalesTax, model.ItemSalesTaxGroup:
		default:
			if it.Income == 0 && it.Expense == 0 {
				return lineErr(i, "the item %s has no income account. Edit the item and choose one.", e.itemFull(it.ID))
			}
		}
		if t == model.TxStatementCharge && it.Type == model.ItemPayment {
			return lineErr(i, "payment items cannot be used on statement charges.")
		}
	}

	// linked lines: invoice lines from an estimate or a billable cost; purchase lines from a PO
	if l.LinkedLineID != 0 {
		var srcTxn int64
		var srcType string
		var billed int64
		err := e.q.QueryRowContext(e.ctx, `SELECT l.txn_id, t.type, IFNULL(l.billed_txn_id, 0) FROM txn_lines l JOIN txns t ON t.id = l.txn_id WHERE l.id = ?`,
			l.LinkedLineID).Scan(&srcTxn, &srcType, &billed)
		if err != nil {
			l.LinkedLineID = 0 // the source line is gone
		} else {
			switch {
			case isCostSource(t) && srcType == model.TxPurchaseOrder:
			case typeIn(t, model.TxInvoice, model.TxSalesReceipt, model.TxCreditMemo) && srcType == model.TxEstimate:
			case t == model.TxDeposit && typeIn(srcType, model.TxInvoice, model.TxSalesReceipt):
				// a payment-item line waiting in Undeposited Funds
				if l.LinkedTxnID != 0 && l.LinkedTxnID != srcTxn {
					return lineErr(i, "this transaction has nothing waiting in Undeposited Funds.")
				}
			case typeIn(t, model.TxInvoice, model.TxSalesReceipt) && isCostSource(srcType):
				if billed != 0 && billed != s.ID {
					b, _ := e.brief(billed)
					what := "another invoice"
					if b != nil {
						what = docLabel(b)
					}
					return lineErr(i, "this billable cost has already been billed on %s.", what)
				}
			default:
				l.LinkedLineID = 0
			}
			if l.LinkedLineID != 0 && l.LinkedTxnID == 0 {
				l.LinkedTxnID = srcTxn
			}
		}
	}
	if l.LinkedTxnID != 0 && t != model.TxDeposit {
		b, err := e.brief(l.LinkedTxnID)
		if err != nil {
			return err
		}
		if b == nil {
			l.LinkedTxnID = 0
		}
	}
	return nil
}

// purchaseAccount is the account an item posts to on purchase forms.
func purchaseAccount(it *itemInfo) int64 {
	if it.Type == model.ItemInventoryPart {
		return it.Asset
	}
	return or64(it.Expense, it.Income)
}

// ---------------------------------------------------------------------------
// Checks that need the computed amounts: totals and applied links.

func (e *env) validateComputed(s *stxn, old *stxn) error {
	t := s.Type
	if s.Amount < 0 && !s.Voided {
		switch t {
		case model.TxInvoice:
			return apperr.Validation("lines", "An invoice cannot have a negative total. Enter a credit memo instead.")
		case model.TxSalesReceipt:
			return apperr.Validation("lines", "A sales receipt cannot have a negative total. Use a refund or a credit memo instead.")
		case model.TxCreditMemo:
			return apperr.Validation("lines", "A credit memo cannot have a negative total. Enter an invoice instead.")
		case model.TxCheck:
			return apperr.Validation("lines", "A check cannot have a negative amount. Record a deposit instead.")
		case model.TxBill, model.TxItemReceipt:
			return apperr.Validation("lines", "A bill cannot have a negative total. Enter a vendor credit instead.")
		case model.TxVendorCredit:
			return apperr.Validation("lines", "A vendor credit cannot have a negative total. Enter a bill instead.")
		case model.TxCCCharge:
			return apperr.Validation("lines", "A credit card charge cannot have a negative amount. Enter a credit card credit instead.")
		case model.TxCCCredit:
			return apperr.Validation("lines", "A credit card credit cannot have a negative amount. Enter a credit card charge instead.")
		case model.TxDeposit:
			return apperr.Validation("lines", "The deposit total cannot be negative. Reduce the cash back amount.")
		case model.TxPurchaseOrder, model.TxEstimate, model.TxStatementCharge:
			return apperr.Validation("lines", "The total of this transaction cannot be negative.")
		}
	}
	if t == model.TxDeposit && !s.Voided {
		if err := e.validateDepositLines(s); err != nil {
			return err
		}
	}
	if err := e.validateLinks(s); err != nil {
		return err
	}
	if err := e.validateNameChange(s, old); err != nil {
		return err
	}
	// payments and credits applied to this transaction by others must still fit
	if old != nil && typeIn(t, model.TxInvoice, model.TxStatementCharge, model.TxBill, model.TxItemReceipt) {
		var applied int64
		if err := e.q.QueryRowContext(e.ctx, `SELECT IFNULL(SUM(amount + discount), 0) FROM txn_links WHERE to_txn_id = ?`, s.ID).Scan(&applied); err != nil {
			return err
		}
		eff := s.Amount
		if s.IsPending {
			eff = 0
		}
		if applied > eff {
			return apperr.Validation("lines", "Payments and credits of %s are applied to this transaction, which is more than its new total of %s. Remove or reduce them first.", fmtMoney(applied), fmtMoney(eff))
		}
	}
	if old != nil && t == model.TxJournal {
		if err := e.validateJournalDoc(s); err != nil {
			return err
		}
	}
	if old != nil && t == model.TxVendorCredit {
		var used int64
		if err := e.q.QueryRowContext(e.ctx, `SELECT IFNULL(SUM(amount), 0) FROM txn_links WHERE from_txn_id = ? OR to_txn_id = ?`, s.ID, s.ID).Scan(&used); err != nil {
			return err
		}
		if used > s.Amount {
			return apperr.Validation("lines", "%s of this credit has already been used, which is more than its new total of %s.", fmtMoney(used), fmtMoney(s.Amount))
		}
	}
	return nil
}

// validateNameChange: an invoice, credit memo, payment or bill whose
// customer or vendor changes may not keep payments, credits or refunds of
// another name applied to it (the save is refused). Moving it to another job
// of the same customer is allowed; the payments are re-posted after the save.
func (e *env) validateNameChange(s *stxn, old *stxn) error {
	if old == nil || old.NameID == s.NameID || !typeIn(s.Type, model.TxInvoice, model.TxStatementCharge, model.TxCreditMemo,
		model.TxPayment, model.TxBill, model.TxItemReceipt, model.TxVendorCredit) {
		return nil
	}
	deps, err := e.dependents(s.ID)
	if err != nil {
		return err
	}
	if len(deps) == 0 {
		return nil
	}
	vendor := typeIn(s.Type, model.TxBill, model.TxItemReceipt, model.TxVendorCredit)
	newRoot, err := e.rootName(s.NameID)
	if err != nil {
		return err
	}
	for _, l := range deps {
		other := l.Owner
		if other == s.ID {
			continue
		}
		ob, err := e.brief(other)
		if err != nil {
			return err
		}
		if ob == nil {
			continue
		}
		ok := ob.NameID == s.NameID
		if !ok && !vendor {
			r, err := e.rootName(ob.NameID)
			if err != nil {
				return err
			}
			ok = r == newRoot
		}
		if ok {
			continue
		}
		what := strings.ToLower(TypeLabel(s.Type, ""))
		who := map[bool]string{true: "vendor", false: "customer"}[vendor]
		switch s.Type {
		case model.TxCreditMemo, model.TxPayment, model.TxVendorCredit:
			return apperr.Validation("nameId", "This %s is used by %s of %s. Remove it from there first, or keep the same %s.",
				what, docLabel(ob), e.nameFull(ob.NameID), who)
		}
		return apperr.Validation("nameId", "%s of %s is applied to this %s. Remove it first, or keep the same %s.",
			capFirst(docLabel(ob)), e.nameFull(ob.NameID), what, who)
	}
	return nil
}

// validateJournalDoc: a journal entry whose A/R or A/P line has payments or
// credits applied must keep that line (same account type, name and side) and
// an amount covering what is applied.
func (e *env) validateJournalDoc(s *stxn) error {
	var applied int64
	if err := e.q.QueryRowContext(e.ctx, `SELECT IFNULL(SUM(amount + discount), 0) FROM txn_links
		WHERE (to_txn_id = ? OR from_txn_id = ?) AND owner_txn_id <> ?`, s.ID, s.ID, s.ID).Scan(&applied); err != nil {
		return err
	}
	if applied == 0 {
		return nil
	}
	oldType, oldAmt, oldName, err := jeArApLine(e.ctx, e.q, s.ID)
	if err != nil {
		return err
	}
	var newType string
	var newAmt, newName int64
	n := 0
	for _, l := range s.Lines {
		if typ := e.acctType(l.AccountID); (typ == model.AcctAR || typ == model.AcctAP) && l.Amount != 0 {
			newType, newAmt, newName = typ, l.Amount, l.NameID
			n++
		}
	}
	if n != 1 || newType != oldType || newName != oldName || (newAmt > 0) != (oldAmt > 0) {
		return apperr.Validation("lines", "Payments or credits of %s are applied to this journal entry. Remove them before changing its %s line.", fmtMoney(applied), orStr(oldType, "Accounts Receivable"))
	}
	if abs64(newAmt) < applied {
		return apperr.Validation("lines", "Payments and credits of %s are applied to this journal entry, which is more than its new amount of %s. Remove or reduce them first.", fmtMoney(applied), fmtMoney(abs64(newAmt)))
	}
	return nil
}

// validateDepositedLine checks a deposit line taking a payment-item line of an
// invoice or sales receipt out of Undeposited Funds.
func (e *env) validateDepositedLine(s *stxn, i int, b *brief, uf int64, seen map[int64]bool) error {
	l := &s.Lines[i]
	nothing := lineErr(i, "this transaction has nothing waiting in Undeposited Funds.")
	var srcTxn int64
	var itemType string
	var waiting int64
	err := e.q.QueryRowContext(e.ctx, `SELECT l.txn_id, IFNULL(it.type, ''),
			(SELECT IFNULL(SUM(g.amount), 0) FROM gl_entries g WHERE g.line_id = l.id AND g.account_id = ?)
		FROM txn_lines l LEFT JOIN items it ON it.id = l.item_id WHERE l.id = ?`, uf, l.LinkedLineID).Scan(&srcTxn, &itemType, &waiting)
	if err != nil || srcTxn != b.ID || itemType != model.ItemPayment || !typeIn(b.Type, model.TxInvoice, model.TxSalesReceipt) {
		return nothing
	}
	if seen[l.LinkedLineID] {
		return lineErr(i, "this payment is already on the deposit.")
	}
	seen[l.LinkedLineID] = true
	if b.Voided || b.Pending || waiting == 0 {
		if l.Amount == 0 {
			return nil // zeroed line of a voided transaction
		}
		return nothing
	}
	if l.AccountID != uf {
		return lineErr(i, "a payment from Undeposited Funds must use the Undeposited Funds account.")
	}
	if l.Amount != waiting {
		return lineErr(i, "the amount must equal the payment received on %s (%s).", docLabel(b), fmtMoney(waiting))
	}
	var other int
	if err := e.q.QueryRowContext(e.ctx, `SELECT COUNT(*) FROM txn_lines l JOIN txns d ON d.id = l.txn_id
		WHERE l.linked_line_id = ? AND d.type = 'DEP' AND d.voided = 0 AND d.id <> ?`, l.LinkedLineID, s.ID).Scan(&other); err != nil {
		return err
	}
	if other > 0 {
		return lineErr(i, "the payment received on %s has already been deposited.", docLabel(b))
	}
	return nil
}

func (e *env) validateDepositLines(s *stxn) error {
	uf, err := e.specialAcct(store.SpecialUndepositedFunds)
	if err != nil {
		return err
	}
	seen := map[int64]bool{}
	seenLine := map[int64]bool{}
	for i := range s.Lines {
		l := &s.Lines[i]
		if l.LinkedTxnID == 0 {
			continue
		}
		b, err := e.brief(l.LinkedTxnID)
		if err != nil {
			return err
		}
		if b == nil {
			return lineErr(i, "the payment being deposited no longer exists.")
		}
		if l.LinkedLineID != 0 {
			if err := e.validateDepositedLine(s, i, b, uf, seenLine); err != nil {
				return err
			}
			continue
		}
		if !typeIn(b.Type, model.TxPayment, model.TxSalesReceipt) {
			return lineErr(i, "this transaction has nothing waiting in Undeposited Funds.")
		}
		if seen[b.ID] {
			return lineErr(i, "this payment is already on the deposit.")
		}
		seen[b.ID] = true
		if b.Voided || b.Pending {
			if l.Amount == 0 {
				continue // zeroed line of a voided payment
			}
			return lineErr(i, "this payment is voided or pending and cannot be deposited.")
		}
		if b.AccountID != uf {
			return lineErr(i, "this payment was not received into Undeposited Funds.")
		}
		if l.AccountID != uf {
			return lineErr(i, "a payment from Undeposited Funds must use the Undeposited Funds account.")
		}
		if l.Amount != b.Amount {
			return lineErr(i, "the amount must equal the payment amount (%s).", fmtMoney(b.Amount))
		}
		var other int64
		err = e.q.QueryRowContext(e.ctx, `SELECT COUNT(*) FROM txn_lines l JOIN txns d ON d.id = l.txn_id
			WHERE l.linked_txn_id = ? AND l.linked_line_id IS NULL AND d.type = 'DEP' AND d.voided = 0 AND d.id <> ?`, b.ID, s.ID).Scan(&other)
		if err != nil {
			return err
		}
		if other > 0 {
			return lineErr(i, "%s has already been deposited.", docLabel(b))
		}
	}
	return nil
}

// chargeOpen: open balance of an invoice/bill ignoring the links owned by excl.
func (e *env) chargeOpen(id, excl int64) (int64, error) {
	b, err := e.brief(id)
	if err != nil || b == nil {
		return 0, err
	}
	var applied int64
	err = e.q.QueryRowContext(e.ctx, `SELECT IFNULL(SUM(amount + discount), 0) FROM txn_links WHERE to_txn_id = ? AND owner_txn_id <> ?`, id, excl).Scan(&applied)
	return b.Amount - applied, err
}

// creditAvail: unused amount of a credit memo / payment / vendor credit ignoring the links owned by excl.
func (e *env) creditAvail(id, excl int64, amount int64) (int64, error) {
	var used int64
	err := e.q.QueryRowContext(e.ctx, `SELECT IFNULL(SUM(amount), 0) FROM txn_links WHERE (from_txn_id = ? OR to_txn_id = ?) AND owner_txn_id <> ?`, id, id, excl).Scan(&used)
	return amount - used, err
}

// validateLinks filters and checks the links the transaction owns.
func (e *env) validateLinks(s *stxn) error {
	t := s.Type
	if s.Voided || s.IsPending || !typeIn(t, model.TxPayment, model.TxCreditMemo, model.TxRefund, model.TxBillPayment, model.TxJournal) {
		s.Links = nil
		return nil
	}
	selfName := s.NameID
	customer := t != model.TxBillPayment
	// a journal entry crediting a customer (A/R) or debiting a vendor (A/P) can
	// apply itself to invoices / bills, like a credit memo
	var jeKind string
	var jeAvail int64
	if t == model.TxJournal {
		var amt int64
		n := 0
		for _, l := range s.Lines {
			if typ := e.acctType(l.AccountID); (typ == model.AcctAR || typ == model.AcctAP) && l.Amount != 0 {
				jeKind, amt, selfName = typ, l.Amount, l.NameID
				n++
			}
		}
		credit := n == 1 && ((jeKind == model.AcctAR && amt < 0) || (jeKind == model.AcctAP && amt > 0))
		hasLinks := false
		for _, l := range s.Links {
			if l.To != 0 && (l.Amount != 0 || l.Discount != 0) {
				hasLinks = true
			}
		}
		if !credit {
			if hasLinks {
				return apperr.Validation("links", "Only a journal entry with one line crediting a customer (Accounts Receivable) or debiting a vendor (Accounts Payable) can be applied to invoices or bills.")
			}
			s.Links = nil
			return nil
		}
		customer = jeKind == model.AcctAR
		jeAvail = abs64(amt)
	}
	// the A/R or A/P account the applications happen in
	ownAcct := s.ArApID
	switch t {
	case model.TxCreditMemo:
		ownAcct = s.AccountID
	case model.TxJournal:
		for _, l := range s.Lines {
			if typ := e.acctType(l.AccountID); (typ == model.AcctAR || typ == model.AcctAP) && l.Amount != 0 {
				ownAcct = l.AccountID
			}
		}
	}
	sameAcct := func(b *brief) error {
		if b == nil || b.ArApAcct == 0 || ownAcct == 0 || b.ArApAcct == ownAcct {
			return nil
		}
		kind := "A/R"
		if !customer {
			kind = "A/P"
		}
		if t == model.TxJournal || t == model.TxCreditMemo {
			return apperr.Validation("links", "%s is in %s. Only documents in the same %s account (%s) can be paid or credited by this %s.",
				capFirst(docLabel(b)), e.acctFull(b.ArApAcct), kind, e.acctFull(ownAcct), typeWord(t))
		}
		return apperr.Validation("arApAccountId", "%s is in %s. Choose that %s account for this %s.",
			capFirst(docLabel(b)), e.acctFull(b.ArApAcct), kind, typeWord(t))
	}
	root, err := e.rootName(selfName)
	if err != nil {
		return err
	}
	sameName := func(nameID int64) (bool, error) {
		if !customer || t == model.TxJournal {
			// vendors, and journal entries (whose lines are posted as entered),
			// must match the name exactly; jobs of one customer may mix
			return nameID == selfName, nil
		}
		r, err := e.rootName(nameID)
		return r == root, err
	}
	var kept []slink
	for _, l := range s.Links {
		if l.From == s.ID {
			l.From = 0
		}
		if l.To == 0 || l.To == s.ID || (l.Amount == 0 && l.Discount == 0) {
			continue
		}
		if l.Amount < 0 || l.Discount < 0 {
			return apperr.Validation("links", "Applied amounts and discounts cannot be negative.")
		}
		kept = append(kept, l)
	}
	s.Links = kept

	perTarget := map[int64]int64{}
	perCredit := map[int64]int64{}
	var own, ownDisc int64
	for i := range s.Links {
		l := &s.Links[i]
		to, err := e.brief(l.To)
		if err != nil {
			return err
		}
		if to == nil {
			return apperr.Validation("links", "A transaction you applied this to no longer exists.")
		}
		var okTypes []string
		okJE := false // journal entry lines to A/R / A/P are open documents too
		switch t {
		case model.TxPayment, model.TxCreditMemo:
			okTypes = []string{model.TxInvoice, model.TxStatementCharge}
			okJE = to.jeCharge() && to.ArAp == model.AcctAR
		case model.TxRefund:
			okTypes = []string{model.TxCreditMemo, model.TxPayment}
			okJE = to.jeCredit() && to.ArAp == model.AcctAR
		case model.TxBillPayment:
			okTypes = []string{model.TxBill}
			okJE = to.jeCharge() && to.ArAp == model.AcctAP
		case model.TxJournal:
			if customer {
				okTypes = []string{model.TxInvoice, model.TxStatementCharge}
				okJE = to.jeCharge() && to.ArAp == model.AcctAR
			} else {
				okTypes = []string{model.TxBill}
				okJE = to.jeCharge() && to.ArAp == model.AcctAP
			}
		}
		if !(typeIn(to.Type, okTypes...) || okJE) || to.Voided || to.Pending {
			return apperr.Validation("links", "%s cannot be paid or credited by this transaction.", capFirst(docLabel(to)))
		}
		if ok, err := sameName(to.NameID); err != nil {
			return err
		} else if !ok {
			return apperr.Validation("links", "%s belongs to a different %s.", capFirst(docLabel(to)), map[bool]string{true: "customer", false: "vendor"}[customer])
		}
		if err := sameAcct(to); err != nil {
			return err
		}
		if l.From != 0 {
			// a credit applied through this payment
			from, err := e.brief(l.From)
			if err != nil {
				return err
			}
			okFrom := []string{model.TxCreditMemo, model.TxPayment}
			fromJE := from.jeCredit() && from.ArAp == model.AcctAR
			if t == model.TxBillPayment {
				// vendor credits, and bill payments left unapplied when their bill went
				okFrom = []string{model.TxVendorCredit, model.TxBillPayment}
				fromJE = from.jeCredit() && from.ArAp == model.AcctAP
			}
			if from == nil || from.Voided || !(typeIn(from.Type, okFrom...) || fromJE) || !typeIn(t, model.TxPayment, model.TxBillPayment) {
				return apperr.Validation("links", "The credit you applied is not available.")
			}
			if ok, err := sameName(from.NameID); err != nil {
				return err
			} else if !ok {
				return apperr.Validation("links", "The credit %s belongs to a different name.", docLabel(from))
			}
			if err := sameAcct(from); err != nil {
				return err
			}
			if l.Discount != 0 {
				return apperr.Validation("links", "A discount cannot be taken on a credit.")
			}
			perCredit[l.From] += l.Amount
		} else {
			own += l.Amount
			ownDisc += l.Discount
		}
		if l.Discount != 0 && t == model.TxJournal {
			return apperr.Validation("links", "A discount cannot be taken when applying a journal entry.")
		}
		if l.Discount != 0 {
			if l.DiscAcctID == 0 {
				if customer {
					l.DiscAcctID = idOf(e.prefs.CustomerDiscountAccountID)
				} else {
					l.DiscAcctID = idOf(e.prefs.VendorDiscountAccountID)
				}
			}
			a, err := e.acct(l.DiscAcctID)
			if err != nil {
				return err
			}
			if a == nil {
				return apperr.Validation("links", "Please choose a discount account for the discount on %s.", docLabel(to))
			}
			if typeIn(a.Type, model.AcctAR, model.AcctAP, model.AcctNonPosting) {
				return apperr.Validation("links", "The discount account cannot be an %s account.", a.Type)
			}
		} else {
			l.DiscAcctID = 0
		}
		perTarget[l.To] += l.Amount + l.Discount
	}

	// each target: applied + discount + credits <= its open balance
	for id, applied := range perTarget {
		to, _ := e.brief(id)
		var open int64
		if t == model.TxRefund {
			open, err = e.creditAvail(id, s.ID, to.Amount)
		} else {
			open, err = e.chargeOpen(id, s.ID)
		}
		if err != nil {
			return err
		}
		if applied > open {
			what := "open balance"
			if t == model.TxRefund {
				what = "credit available"
			}
			return apperr.Validation("links", "The amount applied to %s (%s) is more than its %s (%s).", docLabel(to), fmtMoney(applied), what, fmtMoney(open))
		}
	}
	for id, used := range perCredit {
		from, _ := e.brief(id)
		avail, err := e.creditAvail(id, s.ID, from.Amount)
		if err != nil {
			return err
		}
		if used > avail {
			return apperr.Validation("links", "The credit used from %s (%s) is more than the credit available (%s).", docLabel(from), fmtMoney(used), fmtMoney(avail))
		}
	}

	switch t {
	case model.TxJournal:
		usedByOthers := int64(0)
		if s.ID != 0 {
			avail, err := e.creditAvail(s.ID, s.ID, jeAvail)
			if err != nil {
				return err
			}
			usedByOthers = jeAvail - avail
		}
		if own+usedByOthers > jeAvail {
			return apperr.Validation("links", "The amounts applied (%s) are more than the credit of this journal entry (%s).", fmtMoney(own), fmtMoney(jeAvail-usedByOthers))
		}
	case model.TxPayment, model.TxCreditMemo:
		// what others already took from this payment / credit (later payments, refunds)
		usedByOthers := int64(0)
		if s.ID != 0 {
			avail, err := e.creditAvail(s.ID, s.ID, s.Amount)
			if err != nil {
				return err
			}
			usedByOthers = s.Amount - avail
		}
		if own+usedByOthers > s.Amount {
			what := "payment amount"
			if t == model.TxCreditMemo {
				what = "credit memo total"
			}
			if usedByOthers > 0 {
				return apperr.Validation("links", "The amounts applied (%s) plus the %s already used elsewhere are more than the %s (%s).", fmtMoney(own), fmtMoney(usedByOthers), what, fmtMoney(s.Amount))
			}
			return apperr.Validation("links", "The total amount applied (%s) is more than the %s (%s).", fmtMoney(own), what, fmtMoney(s.Amount))
		}
	case model.TxRefund:
		if len(s.Links) == 0 {
			return apperr.Validation("links", "Choose the credit memo or unapplied payment this refund is for.")
		}
		if s.Amount == 0 {
			s.Amount = own
		}
		if s.Amount != own {
			return apperr.Validation("amount", "The refund amount (%s) must equal the total of the credits refunded (%s).", fmtMoney(s.Amount), fmtMoney(own))
		}
		if s.Amount <= 0 {
			return apperr.Validation("amount", "Please enter the refund amount.")
		}
	case model.TxBillPayment:
		// A saved bill payment whose amount is not changed may keep an
		// unapplied amount (its bill was deleted or voided): it stays a credit
		// for the vendor, and other bill payments may use it (usedByOthers).
		keep := false
		usedByOthers := int64(0)
		if s.ID != 0 {
			old, err := e.brief(s.ID)
			if err != nil {
				return err
			}
			keep = old != nil && !old.Voided && old.Type == model.TxBillPayment && old.Amount == s.Amount && s.Amount != 0
			avail, err := e.creditAvail(s.ID, s.ID, s.Amount)
			if err != nil {
				return err
			}
			usedByOthers = s.Amount - avail
		}
		if keep {
			if own+usedByOthers > s.Amount {
				if usedByOthers > 0 {
					return apperr.Validation("links", "The amounts applied (%s) plus the %s already used as a credit on other bill payments are more than the payment amount (%s).",
						fmtMoney(own), fmtMoney(usedByOthers), fmtMoney(s.Amount))
				}
				return apperr.Validation("links", "The total amount applied (%s) is more than the payment amount (%s).", fmtMoney(own), fmtMoney(s.Amount))
			}
			break
		}
		if len(s.Links) == 0 {
			return apperr.Validation("links", "Please select at least one bill to pay.")
		}
		if s.Amount == 0 {
			s.Amount = own
		}
		if s.Amount != own {
			return apperr.Validation("amount", "The payment amount (%s) must equal the total of the amounts applied to bills (%s).", fmtMoney(s.Amount), fmtMoney(own))
		}
		if usedByOthers > 0 {
			return apperr.Validation("amount", "%s of this bill payment is used as a credit on other bill payments. Remove it there before changing the amount.", fmtMoney(usedByOthers))
		}
	}
	return nil
}

func strconvRate(r float64) string { return fmtQty(math.Round(r*100000) / 100000) }

func capFirst(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

// ---------------------------------------------------------------------------
// Warnings (apperr.Confirm unless the user already said Yes)

// warnings asks each confirmation question in turn (apperr.ConfirmKind), skipping
// the kinds the user already answered Yes to (SaveOptions.Accepts).
func (e *env) warnings(s *stxn, old *stxn, post *posting, oldPost *oldPosting) error {
	if e.quiet {
		return nil
	}
	p := e.prefs
	t := s.Type
	ask := func(kind string) bool { return !e.opt.Accepts(kind) }
	refChanged := old == nil || old.Ref != s.Ref || old.Type != s.Type || old.AccountID != s.AccountID || old.NameID != s.NameID
	if refChanged && s.Ref != "" && ask(apperr.WarnDuplicateNumber) {
		var n int
		var err error
		switch {
		case t == model.TxInvoice && p.WarnDuplicateInvoiceNumbers:
			err = e.q.QueryRowContext(e.ctx, `SELECT COUNT(*) FROM txns WHERE type = 'INV' AND ref_number = ? AND id <> ?`, s.Ref, s.ID).Scan(&n)
			if err == nil && n > 0 {
				return apperr.ConfirmKind(apperr.WarnDuplicateNumber, "There is another invoice # %s. Do you want to keep this number anyway?", s.Ref)
			}
		case t == model.TxPurchaseOrder && p.WarnDuplicatePONumbers:
			err = e.q.QueryRowContext(e.ctx, `SELECT COUNT(*) FROM txns WHERE type = 'PURCHORD' AND ref_number = ? AND id <> ?`, s.Ref, s.ID).Scan(&n)
			if err == nil && n > 0 {
				return apperr.ConfirmKind(apperr.WarnDuplicateNumber, "There is another purchase order # %s. Do you want to keep this number anyway?", s.Ref)
			}
		case t == model.TxBill && p.WarnDuplicateBillNumbers:
			err = e.q.QueryRowContext(e.ctx, `SELECT COUNT(*) FROM txns WHERE type = 'BILL' AND name_id = ? AND ref_number = ? AND id <> ?`, s.NameID, s.Ref, s.ID).Scan(&n)
			if err == nil && n > 0 {
				return apperr.ConfirmKind(apperr.WarnDuplicateNumber, "You have already used the reference number %s on another bill from %s. Do you want to keep it anyway?", s.Ref, e.nameFull(s.NameID))
			}
		case typeIn(t, model.TxCheck, model.TxBillPayment, model.TxRefund, model.TxSalesTaxPayment) && p.WarnDuplicateCheckNumbers && e.acctType(s.AccountID) == model.AcctBank:
			err = e.q.QueryRowContext(e.ctx, `SELECT COUNT(*) FROM txns WHERE type IN ('CHK','BILLPMT','REFUND','TAXPMT') AND account_id = ? AND ref_number = ? AND id <> ?`, s.AccountID, s.Ref, s.ID).Scan(&n)
			if err == nil && n > 0 {
				return apperr.ConfirmKind(apperr.WarnDuplicateNumber, "Check number %s has already been used in %s. Do you want to keep this number anyway?", s.Ref, e.acctFull(s.AccountID))
			}
		}
		if err != nil {
			return err
		}
	}

	// inactive records newly used
	if ask(apperr.WarnInactive) {
		if err := e.inactiveCheck(s, old); err != nil {
			return err
		}
	}

	// credit limit
	if typeIn(t, model.TxInvoice, model.TxStatementCharge) && !s.IsPending && !s.Voided && ask(apperr.WarnCreditLimit) {
		if err := e.creditLimitCheck(s, old); err != nil {
			return err
		}
	}

	// selling more than on hand
	if typeIn(t, model.TxInvoice, model.TxSalesReceipt) && !s.IsPending && !s.Voided && p.WarnNotEnoughInventory && ask(apperr.WarnInventory) {
		need := map[int64]float64{}
		var order []int64
		for _, m := range post.moves {
			if m.Qty < 0 {
				if _, ok := need[m.ItemID]; !ok {
					order = append(order, m.ItemID)
				}
				need[m.ItemID] += -m.Qty
			}
		}
		for _, id := range order {
			var onHand float64
			if err := e.q.QueryRowContext(e.ctx, `SELECT qty_on_hand FROM items WHERE id = ?`, id).Scan(&onHand); err != nil {
				return err
			}
			onHand -= oldPost.moveQty[id] // what this transaction already took
			if need[id] > onHand+qtyEps {
				return apperr.ConfirmKind(apperr.WarnInventory, "You don't have sufficient quantity available to sell %s of the item %s. The quantity on hand is %s. Do you want to continue?",
					fmtQty(need[id]), e.itemFull(id), fmtQty(onHand))
			}
		}
	}

	// reconciled entries whose amount or account changes
	if old != nil && ask(apperr.WarnReconciled) {
		oldSum := map[int64]int64{}
		recon := map[int64]bool{}
		for _, o := range oldPost.entries {
			oldSum[o.acct] += o.amount
			if o.cleared == "R" {
				recon[o.acct] = true
			}
		}
		if len(recon) > 0 {
			newSum := map[int64]int64{}
			for _, en := range post.entries {
				newSum[en.AccountID] += en.Amount
			}
			for a := range recon {
				if newSum[a] != oldSum[a] {
					return apperr.ConfirmKind(apperr.WarnReconciled, "This transaction has been reconciled in %s. Changing its amount or account will change the reconciled balance. Do you want to save it anyway?", e.acctFull(a))
				}
			}
		}
	}
	return nil
}

func (e *env) inactiveCheck(s *stxn, old *stxn) error {
	type refs struct{ accts, names, items map[int64]bool }
	collect := func(x *stxn) refs {
		r := refs{map[int64]bool{}, map[int64]bool{}, map[int64]bool{}}
		if x == nil {
			return r
		}
		for _, id := range []int64{x.AccountID, x.ArApID, x.ToAcctID, x.CashBackAcctID} {
			r.accts[id] = true
		}
		r.names[x.NameID] = true
		r.items[x.TaxItemID] = true
		for _, l := range x.Lines {
			r.accts[l.AccountID] = true
			r.names[l.NameID] = true
			r.items[l.ItemID] = true
		}
		return r
	}
	nw, od := collect(s), collect(old)
	for _, id := range keys(nw.accts) {
		if od.accts[id] {
			continue
		}
		a, err := e.acct(id)
		if err != nil {
			return err
		}
		if a != nil && !a.Active {
			return apperr.ConfirmKind(apperr.WarnInactive, "The account %s is inactive. Do you want to use it anyway?", e.acctFull(id))
		}
	}
	for _, id := range keys(nw.names) {
		if od.names[id] {
			continue
		}
		n, err := e.name(id)
		if err != nil {
			return err
		}
		if n != nil && !n.Active {
			return apperr.ConfirmKind(apperr.WarnInactive, "%s is inactive. Do you want to use it anyway?", e.nameFull(id))
		}
	}
	for _, id := range keys(nw.items) {
		if od.items[id] {
			continue
		}
		it, err := e.item(id)
		if err != nil {
			return err
		}
		if it != nil && !it.Active {
			return apperr.ConfirmKind(apperr.WarnInactive, "The item %s is inactive. Do you want to use it anyway?", e.itemFull(id))
		}
	}
	return nil
}

func (e *env) creditLimitCheck(s *stxn, old *stxn) error {
	increase := s.Amount
	if old != nil && !old.IsPending && !old.Voided && typeIn(old.Type, model.TxInvoice, model.TxStatementCharge) {
		increase -= old.Amount
	}
	if increase <= 0 {
		return nil
	}
	root, err := e.rootName(s.NameID)
	if err != nil {
		return err
	}
	cands := []int64{root}
	if s.NameID != root {
		cands = append(cands, s.NameID)
	}
	for _, c := range cands {
		n, err := e.name(c)
		if err != nil {
			return err
		}
		if n == nil || !n.CreditLimit.Valid || n.CreditLimit.Int64 <= 0 {
			continue
		}
		ids, err := store.Descendants(e.ctx, e.q, "names", c)
		if err != nil {
			return err
		}
		in, args := placeholders(ids)
		var bal int64
		err = e.q.QueryRowContext(e.ctx, `SELECT IFNULL(SUM(g.amount), 0) FROM gl_entries g JOIN accounts a ON a.id = g.account_id
			WHERE a.type = 'Accounts Receivable' AND g.name_id IN `+in+` AND g.txn_id <> ?`, append(args, s.ID)...).Scan(&bal)
		if err != nil {
			return err
		}
		if bal+s.Amount > n.CreditLimit.Int64 {
			return apperr.ConfirmKind(apperr.WarnCreditLimit, "This transaction will put %s over its credit limit of %s (new balance %s). Do you want to save it anyway?",
				e.nameFull(c), fmtMoney(n.CreditLimit.Int64), fmtMoney(bal+s.Amount))
		}
	}
	return nil
}

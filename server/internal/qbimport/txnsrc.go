package qbimport

import (
	"fmt"
	"sort"
	"strings"

	"seriex/internal/model"
	"seriex/internal/store"
)

// srcSplit is the TRNS row or one SPL row of a transaction block. Amount is
// in cents, positive = debit, negative = credit (as in IIF files).
type srcSplit struct {
	Line        int
	Accnt       string
	Name        string
	Class       string
	Amount      int64
	DocNum      string
	Memo        string
	Item        string
	Qty         *float64
	Price       *float64
	PayMeth     string
	Taxable     bool
	Clear       bool
	ServiceDate string
	Billable    bool
}

// srcTxn is one IIF transaction block.
type srcTxn struct {
	Seq      int    // order in the file
	Line     int    // line of the TRNS row
	RawType  string // TRNSTYPE as written
	Kind     string // SerieX type it maps to (model.Tx*), "" when not supported
	Date     string
	Head     srcSplit
	Splits   []srcSplit
	DueDate  string
	ShipDate string
	Terms    string
	ShipVia  string
	Rep      string
	FOB      string
	PONum    string
	CustMsg  string
	BillAddr string
	ShipAddr string
	ToPrint  bool
	Voided   bool
}

// trnsTypes maps TRNSTYPE values to SerieX transaction types. The sign of the
// TRNS amount decides between the charge and the credit of a pair (a BILL
// with a debit to Accounts Payable is a vendor credit).
var trnsTypes = map[string]string{
	"INVOICE": model.TxInvoice, "CREDITMEMO": model.TxCreditMemo, "CASHSALE": model.TxSalesReceipt,
	"SALESRECEIPT": model.TxSalesReceipt, "PAYMENT": model.TxPayment, "DEPOSIT": model.TxDeposit,
	"CHECK": model.TxCheck, "BILL": model.TxBill, "BILLREFUND": model.TxVendorCredit, "VENDORCREDIT": model.TxVendorCredit,
	"CREDIT": model.TxVendorCredit, "BILLPMT": model.TxBillPayment, "BILLPMTCHECK": model.TxBillPayment,
	"BILLPMTCCARD": model.TxBillPayment, "BILLPAYMENT": model.TxBillPayment, "CREDITCARD": model.TxCCCharge,
	"CCARD": model.TxCCCharge, "CREDITCARDCHARGE": model.TxCCCharge, "CCARDREFUND": model.TxCCCredit,
	"CREDITCARDREFUND": model.TxCCCredit, "CREDITCARDCREDIT": model.TxCCCredit, "GENERALJOURNAL": model.TxJournal,
	"GENJRNL": model.TxJournal, "JOURNAL": model.TxJournal, "TRANSFER": model.TxTransfer, "ITEMRECEIPT": model.TxItemReceipt,
	"STATEMENTCHARGE": model.TxStatementCharge, "STMTCHG": model.TxStatementCharge,
}

// nonPostingTypes are documents that never touch the books (skipped).
var nonPostingTypes = map[string]bool{"ESTIMATE": true, "PURCHORD": true, "PURCHASEORDER": true, "SALESORDER": true}

// typeKey turns "BILL PMT -CHECK" into "BILLPMTCHECK".
func typeKey(s string) string { return lettersOnly.ReplaceAllString(strings.ToUpper(s), "") }

func readSplit(r *record) (srcSplit, []string) {
	var errs []string
	sp := srcSplit{Line: r.Line, Accnt: strings.Join(splitFull(r.get("ACCNT")), ":"), Name: strings.Join(splitFull(r.get("NAME")), ":"),
		Class: strings.Join(splitFull(r.get("CLASS")), ":"), DocNum: r.get("DOCNUM"), Memo: r.get("MEMO"),
		Item: strings.Join(splitFull(r.get("INVITEM")), ":"), PayMeth: r.get("PAYMETH"), Taxable: yes(r.get("TAXABLE")),
		Clear: yes(r.get("CLEAR"))}
	amt, ok := parseMoney(r.get("AMOUNT"))
	if !ok {
		errs = append(errs, fmt.Sprintf("the amount %q is not a number", r.get("AMOUNT")))
	}
	sp.Amount = amt
	if v, _, ok := parseNumber(r.get("QNTY")); ok {
		sp.Qty = &v
	}
	if v, _, ok := parseNumber(r.get("PRICE")); ok {
		sp.Price = &v
	}
	if d, ok := parseDate(r.get("SERVICEDATE")); ok {
		sp.ServiceDate = d
	}
	switch strings.ToUpper(strings.TrimSpace(r.get("REIMBEXP"))) {
	case "BILLABLE", "Y", "YES":
		sp.Billable = true
	}
	return sp, errs
}

// readTxns turns the IIF transaction blocks into srcTxns, sorted the way they
// are entered: by date, purchases before sales before payments before
// deposits on the same day, then in file order.
func readTxns(f *iifFile) ([]*srcTxn, []Problem) {
	var out []*srcTxn
	var probs []Problem
	errAt := func(line int, format string, args ...any) {
		probs = append(probs, Problem{File: "iif", Line: line, Level: levelError, Message: fmt.Sprintf(format, args...)})
	}
	for i, b := range f.Blocks {
		r := b.Trns
		t := &srcTxn{Seq: i, Line: r.Line, RawType: strings.TrimSpace(r.get("TRNSTYPE"))}
		key := typeKey(t.RawType)
		if nonPostingTypes[key] {
			probs = append(probs, Problem{File: "iif", Line: r.Line, Level: levelNote,
				Message: fmt.Sprintf("%s transactions do not affect the books and were skipped.", t.RawType)})
			continue
		}
		t.Kind = trnsTypes[key]
		d, ok := parseDate(r.get("DATE"))
		if !ok {
			errAt(r.Line, "The transaction date %q could not be read.", r.get("DATE"))
			continue
		}
		t.Date = d
		head, errs := readSplit(r)
		t.Head = head
		bad := len(errs) > 0
		for _, e := range errs {
			errAt(r.Line, "In this %s, %s.", orStr(t.RawType, "transaction"), e)
		}
		sum := head.Amount
		for _, s := range b.Splits {
			sp, errs := readSplit(s)
			for _, e := range errs {
				errAt(s.Line, "In this split line, %s.", e)
				bad = true
			}
			sum += sp.Amount
			t.Splits = append(t.Splits, sp)
		}
		if bad {
			continue
		}
		if len(t.Splits) == 0 {
			errAt(r.Line, "This %s has no split lines (SPL rows); every transaction needs at least one.", orStr(t.RawType, "transaction"))
			continue
		}
		if sum != 0 {
			errAt(r.Line, "This %s does not balance: the TRNS amount and the SPL amounts add up to %s instead of zero.",
				orStr(t.RawType, "transaction"), fmtCents(sum))
			continue
		}
		t.DueDate, _ = parseDate(r.get("DUEDATE"))
		t.ShipDate, _ = parseDate(r.get("SHIPDATE"))
		t.Terms, t.ShipVia, t.Rep, t.FOB, t.PONum = r.get("TERMS"), r.get("SHIPVIA"), r.get("REP"), r.get("FOB"), r.get("PONUM")
		t.CustMsg = strings.TrimSpace(strings.ReplaceAll(r.get("INVMEMO"), ":", " -"))
		t.BillAddr = joinLines(r, "ADDR1", "ADDR2", "ADDR3", "ADDR4", "ADDR5")
		t.ShipAddr = joinLines(r, "SADDR1", "SADDR2", "SADDR3", "SADDR4", "SADDR5")
		t.ToPrint = yes(r.get("TOPRINT"))
		t.Voided = strings.HasPrefix(strings.ToUpper(strings.TrimSpace(head.Memo)), "VOID")
		if t.Kind == "" {
			t.Kind = model.TxJournal
			probs = append(probs, Problem{File: "iif", Line: r.Line, Level: levelNote,
				Message: fmt.Sprintf("SerieX Books has no %q form; this transaction is entered as a general journal entry with the same accounts and amounts.", t.RawType)})
		}
		out = append(out, t)
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.Date != b.Date {
			return a.Date < b.Date
		}
		if pa, pb := txnOrder(a.Kind), txnOrder(b.Kind); pa != pb {
			return pa < pb
		}
		return a.Seq < b.Seq
	})
	return out, probs
}

// txnOrder: documents first, then what pays or deposits them.
func txnOrder(kind string) int {
	switch kind {
	case model.TxBill, model.TxItemReceipt, model.TxCheck, model.TxCCCharge, model.TxCCCredit, model.TxVendorCredit, model.TxJournal, model.TxTransfer:
		return 0
	case model.TxInvoice, model.TxStatementCharge, model.TxCreditMemo, model.TxSalesReceipt:
		return 1
	case model.TxPayment, model.TxBillPayment:
		return 2
	case model.TxDeposit:
		return 3
	}
	return 4
}

func orStr(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// fmtCents formats cents as 1,234.56.
func fmtCents(c int64) string {
	neg := c < 0
	if neg {
		c = -c
	}
	whole := fmt.Sprint(c / 100)
	var b strings.Builder
	for i, r := range whole {
		if i > 0 && (len(whole)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(r)
	}
	s := fmt.Sprintf("%s.%02d", b.String(), c%100)
	if neg {
		return "-" + s
	}
	return s
}

// fmtDate shows a date as MM/DD/YYYY.
func fmtDate(d string) string { return store.FmtDate(d) }

package qbimport

import (
	"fmt"
	"math"
	"sort"
	"strings"

	"seriex/internal/model"
	"seriex/internal/store"
)

// OpeningSummary describes what the opening balance conversion entered.
type OpeningSummary struct {
	Date           string  `json:"date"`
	Invoices       int     `json:"invoices"`
	InvoicesTotal  float64 `json:"invoicesTotal"` // open invoices less customer credits
	Bills          int     `json:"bills"`
	BillsTotal     float64 `json:"billsTotal"` // unpaid bills less vendor credits
	InventoryItems int     `json:"inventoryItems"`
	InventoryValue float64 `json:"inventoryValue"`
	JournalLines   int     `json:"journalLines"`
	JournalEntered bool    `json:"journalEntered"`
}

// importOpening enters the conversion by opening balances as of the
// conversion date D, the way accountants convert books:
//   - open invoices and customer credits as invoices / credit memos, and
//     unpaid bills and vendor credits as bills / vendor credits, each with one
//     line to Opening Balance Equity, so the A/R and A/P aging is right;
//   - the quantity on hand of inventory items (when the item list has it) as
//     opening inventory valued at the trial balance's inventory amount;
//   - one journal entry dated D with every other trial balance amount, which
//     also brings Opening Balance Equity back to its trial balance amount.
func (im *importer) importOpening() error {
	d := im.in.Opt.ConversionDate
	op := &OpeningSummary{Date: d}
	im.rep.Opening = op
	obe, err := im.special(store.SpecialOpeningBalanceEquity)
	if err != nil {
		return err
	}
	tb := map[int64]int64{}
	for _, r := range im.ps.tb.Rows {
		id, why := im.accountID(r.Full)
		if id == 0 {
			im.problem("tb", r.Line, levelError, "The trial balance amount of %s was not entered: %s.", r.Label, why)
			continue
		}
		if a := im.acct(id); a != nil && a.typ == model.AcctNonPosting {
			continue
		}
		tb[id] += r.Amount
	}
	pre := map[int64]int64{} // amounts already entered by the documents below
	arapAcct := func(typ, special string) (int64, error) {
		var best, bestAmt int64
		for id, amt := range tb {
			if a := im.acct(id); a != nil && a.typ == typ && (best == 0 || absC(amt) > bestAmt || (absC(amt) == bestAmt && id < best)) {
				best, bestAmt = id, absC(amt)
			}
		}
		if best != 0 {
			return best, nil
		}
		return im.special(special)
	}
	ar, err := arapAcct(model.AcctAR, store.SpecialAR)
	if err != nil {
		return err
	}
	ap, err := arapAcct(model.AcctAP, store.SpecialAP)
	if err != nil {
		return err
	}
	if err := im.openingInventory(d, obe, tb, pre, op); err != nil {
		return err
	}

	// open invoices and unpaid bills
	for _, side := range []struct {
		docs     []openDoc
		file     string
		customer bool
		acct     int64
	}{{im.ps.invoices, "invoices", true, ar}, {im.ps.bills, "bills", false, ap}} {
		c := im.count(map[bool]string{true: "Open invoices and credits", false: "Unpaid bills and credits"}[side.customer])
		for _, doc := range side.docs {
			nameID, why := im.nameID(doc.Name)
			if nameID == 0 {
				im.problem(side.file, doc.Line, levelError, "%s %s of %s was not entered: %s.", doc.TypeText, doc.Num, doc.Name, why)
				c.Skipped++
				continue
			}
			want := model.NameCustomer
			if !side.customer {
				want = model.NameVendor
			}
			if k := im.kindOf(nameID); k != want {
				im.problem(side.file, doc.Line, levelError, "%s %s was not entered: %s is a %s, not a %s.", doc.TypeText, doc.Num, doc.Name, kindLabels[k], kindLabels[want])
				c.Skipped++
				continue
			}
			typ := model.TxInvoice
			lineKind := model.LineItem
			switch {
			case side.customer && doc.Open < 0:
				typ = model.TxCreditMemo
			case !side.customer && doc.Open > 0:
				typ, lineKind = model.TxBill, model.LineExpense
			case !side.customer:
				typ, lineKind = model.TxVendorCredit, model.LineExpense
			}
			ref := doc.Num
			if len([]rune(ref)) > 20 {
				ref = string([]rune(ref)[:20])
			}
			memo := "Opening balance from QuickBooks® Desktop file"
			tt := strings.ToLower(doc.TypeText)
			if tt != "invoice" && tt != "credit memo" && tt != "bill" && tt != "credit" {
				memo = fmt.Sprintf("Opening balance from QuickBooks® Desktop file (%s %s)", doc.TypeText, doc.Num)
			}
			if doc.Memo != "" {
				memo += ": " + doc.Memo
			}
			m := &model.Txn{Type: typ, Date: doc.Date, RefNumber: ref, NameID: ptr(nameID), AccountID: ptr(side.acct), Memo: memo,
				Extra: map[string]any{"openingBalance": true},
				Lines: []model.TxnLine{{Kind: lineKind, AccountID: ptr(obe), Amount: dollars(absC(doc.Open)), Description: "Opening balance"}}}
			if typ == model.TxInvoice || typ == model.TxBill {
				m.DueDate = doc.DueDate
				m.TermsID = im.listRef(model.ListTerms, doc.Terms, doc.Line)
			}
			if side.customer {
				m.PONumber = doc.PONum
			}
			_, uerr, ferr := im.save(&built{t: m, lines: []int{doc.Line}})
			if ferr != nil {
				return ferr
			}
			if uerr != nil {
				im.problem(side.file, doc.Line, levelError, "%s %s of %s was not entered: %s", doc.TypeText, doc.Num, doc.Name, errText(uerr))
				c.Skipped++
				continue
			}
			c.Created++
			if side.customer {
				pre[side.acct] += doc.Open
				pre[obe] -= doc.Open
				op.Invoices++
				op.InvoicesTotal += dollars(doc.Open)
			} else {
				pre[side.acct] -= doc.Open
				pre[obe] += doc.Open
				op.Bills++
				op.BillsTotal += dollars(doc.Open)
			}
		}
	}
	op.InvoicesTotal, op.BillsTotal = store.Round2(op.InvoicesTotal), store.Round2(op.BillsTotal)

	// the journal entry: trial balance less what the documents entered
	amounts := map[int64]int64{}
	for id, amt := range tb {
		amounts[id] += amt
	}
	for id, amt := range pre {
		amounts[id] -= amt
	}
	for id, amt := range amounts {
		a := im.acct(id)
		if a == nil || amt == 0 {
			continue
		}
		if a.typ == model.AcctAR || a.typ == model.AcctAP {
			what, file := "open invoices and credits", "invoices"
			if a.typ == model.AcctAP {
				what, file = "unpaid bills and credits", "bills"
			}
			natural := tb[id]
			docs := pre[id]
			if a.typ == model.AcctAP {
				natural, docs = -natural, -docs
			}
			im.problem(file, 0, levelError, "The trial balance shows %s at %s, but the %s add up to %s (difference %s). Use reports run on the same date, or add the missing documents.",
				a.name, fmtCents(natural), what, fmtCents(docs), fmtCents(natural-docs))
			amounts[obe] += amt
			delete(amounts, id)
		}
	}
	ids := make([]int64, 0, len(amounts))
	for id, amt := range amounts {
		if amt != 0 {
			ids = append(ids, id)
		}
	}
	sort.Slice(ids, func(i, j int) bool {
		a, b := im.acct(ids[i]), im.acct(ids[j])
		if ra, rb := model.AccountTypeRank(a.typ), model.AccountTypeRank(b.typ); ra != rb {
			return ra < rb
		}
		return a.name < b.name
	})
	je := &model.Txn{Type: model.TxJournal, Date: d, Extra: map[string]any{"openingBalance": true},
		Memo: "Opening balances from QuickBooks® Desktop files (trial balance as of " + fmtDate(d) + ")"}
	for _, id := range ids {
		je.Lines = append(je.Lines, model.TxnLine{Kind: model.LineJournal, AccountID: ptr(id), Amount: dollars(amounts[id]), Description: "Opening balance"})
		if a := im.acct(id); a != nil {
			switch {
			case a.special == store.SpecialUndepositedFunds:
				im.problem("tb", 0, levelNote, "Undeposited Funds has an opening balance of %s. It is one amount, not separate payments: when you deposit that money, add a deposit line from Undeposited Funds.", fmtCents(amounts[id]))
			case a.special == store.SpecialSalesTaxPayable:
				im.problem("tb", 0, levelNote, "Sales Tax Payable has an opening balance of %s. Pay Sales Tax does not show it by tax item; record its payment with a check or a sales tax payment with an account line.", fmtCents(-amounts[id]))
			case a.typ == model.AcctOCA && im.isInventoryAccount(id):
				im.problem("tb", 0, levelNote, "%s has an opening balance of %s but no item quantities were found in the item list, so the inventory items show no stock. Verify Data reports the difference until you enter the quantities on hand (Adjust Quantity/Value on Hand).", a.name, fmtCents(amounts[id]))
			}
		}
	}
	op.JournalLines = len(je.Lines)
	if len(je.Lines) >= 2 {
		_, uerr, ferr := im.save(&built{t: je})
		if ferr != nil {
			return ferr
		}
		if uerr != nil {
			im.problem("tb", 0, levelError, "The opening balance journal entry was not entered: %s", errText(uerr))
		} else {
			op.JournalEntered = true
			im.count("Opening balance journal entry").Created++
		}
	}
	return nil
}

// isInventoryAccount: the account is an inventory asset account (special or used by items).
func (im *importer) isInventoryAccount(id int64) bool {
	if a := im.acct(id); a != nil && a.special == store.SpecialInventoryAsset {
		return true
	}
	var n int
	im.tx.QueryRowContext(im.ctx, `SELECT COUNT(*) FROM items WHERE asset_account_id = ?`, id).Scan(&n)
	return n > 0
}

// openingInventory enters the quantity on hand of the inventory items listed
// with one (QNTY column), valued so that each inventory asset account gets its
// trial balance amount: the amount is shared by quantity x cost.
func (im *importer) openingInventory(d string, obe int64, tb, pre map[int64]int64, op *OpeningSummary) error {
	type entry struct {
		id     int64
		qty    float64
		weight float64
		line   int
	}
	byAsset := map[int64][]entry{}
	for _, it := range im.p.items {
		if it.src == nil || it.src.Qty == nil || *it.src.Qty <= 0 || it.id == 0 || it.row.Action != "create" {
			continue
		}
		data := im.item(it.id)
		if data == nil || data.typ != model.ItemInventoryPart {
			continue
		}
		asset := data.asset
		if asset == 0 {
			var err error
			if asset, err = im.special(store.SpecialInventoryAsset); err != nil {
				return err
			}
		}
		byAsset[asset] = append(byAsset[asset], entry{it.id, *it.src.Qty, *it.src.Qty * it.src.Cost, it.src.Line})
	}
	assets := make([]int64, 0, len(byAsset))
	for a := range byAsset {
		assets = append(assets, a)
	}
	sort.Slice(assets, func(i, j int) bool { return assets[i] < assets[j] })
	for _, asset := range assets {
		es := byAsset[asset]
		sort.Slice(es, func(i, j int) bool { return es[i].line < es[j].line })
		total := tb[asset]
		if total <= 0 {
			im.problem("tb", 0, levelNote, "The item list has quantities on hand, but the trial balance has no amount for %s; the quantities were not entered.", im.acct(asset).name)
			continue
		}
		var sumW float64
		for _, e := range es {
			sumW += e.weight
		}
		if sumW == 0 {
			for i := range es {
				es[i].weight = es[i].qty
				sumW += es[i].qty
			}
		}
		m := &model.Txn{Type: model.TxInventoryAdjust, Date: d, AccountID: ptr(obe), Memo: "Opening inventory from QuickBooks® Desktop files",
			Extra: map[string]any{"valueAdjustment": true, "openingBalance": true}}
		var done int64
		for i, e := range es {
			v := int64(math.Round(float64(total) * e.weight / sumW))
			if i == len(es)-1 {
				v = total - done
			}
			done += v
			q := e.qty
			m.Lines = append(m.Lines, model.TxnLine{Kind: model.LineItem, ItemID: ptr(e.id), Qty: &q, Amount: dollars(v), Description: "Opening balance"})
		}
		_, uerr, ferr := im.save(&built{t: m})
		if ferr != nil {
			return ferr
		}
		if uerr != nil {
			im.problem("tb", 0, levelError, "The opening inventory of %s was not entered: %s", im.acct(asset).name, errText(uerr))
			continue
		}
		pre[asset] += total
		pre[obe] -= total
		op.InventoryItems += len(es)
		op.InventoryValue = store.Round2(op.InventoryValue + dollars(total))
		im.count("Opening inventory").Created += len(es)
	}
	return nil
}

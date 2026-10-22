package ledger

import (
	"database/sql"
	"encoding/json"
	"fmt"

	"seriex/internal/apperr"
	"seriex/internal/model"
	"seriex/internal/store"
)

// glEntry is one ledger entry to write. lineIdx points into stxn.Lines (-1: header level).
type glEntry struct {
	lineIdx   int
	LineID    int64
	AccountID int64
	Amount    int64
	NameID    int64
	ClassID   int64
	ItemID    int64
	Memo      string
	Role      string
}

// invMove is one inventory movement (qty and value signed: + in, - out).
type invMove struct {
	lineIdx int
	LineID  int64
	ItemID  int64
	Qty     float64
	Value   int64
	Known   bool
}

type posting struct {
	entries  []glEntry
	moves    []invMove
	cogsInit map[int]int64 // line index -> txn_lines.cogs to write with the line
}

// bindLines copies the line ids (known after the lines are written) into entries and moves.
func (p *posting) bindLines(s *stxn) {
	for i := range p.entries {
		if k := p.entries[i].lineIdx; k >= 0 && k < len(s.Lines) {
			p.entries[i].LineID = s.Lines[k].ID
		}
	}
	for i := range p.moves {
		if k := p.moves[i].lineIdx; k >= 0 && k < len(s.Lines) {
			p.moves[i].LineID = s.Lines[k].ID
		}
	}
}

type poster struct {
	e       *env
	s       *stxn
	p       *posting
	oldVals map[int64]int64
	op      *oldPosting // the stored posting (accounts and tax splits of unchanged lines are kept)
}

// keptAcct returns the account an unchanged line of the stored version posted
// role to (0 when the line is new, its item changed or nothing was posted).
// Rebuild and re-posts therefore never move old amounts to an item's new
// account: recorded transactions keep the accounts they were posted to.
func (ps *poster) keptAcct(l *sline, role string) int64 {
	op := ps.op
	if op == nil || l.ID == 0 {
		return 0
	}
	if op.editLines != nil {
		if it, ok := op.editLines[l.ID]; !ok || it != l.ItemID {
			return 0
		}
	}
	for _, o := range op.entries {
		if o.line == l.ID && o.role == role && o.acct != 0 {
			return o.acct
		}
	}
	return 0
}

// keptTax returns the stored sales tax split of a line (lineID != 0) or of
// the header tax (lineID 0) when it still adds up to total, else nil.
func (ps *poster) keptTax(lineID, itemID, sign, total int64) []taxPart {
	op := ps.op
	if op == nil || total == 0 {
		return nil
	}
	if lineID == 0 && op.oldTaxItem != itemID {
		return nil
	}
	if lineID != 0 && op.editLines != nil {
		if it, ok := op.editLines[lineID]; !ok || it != itemID {
			return nil
		}
	}
	var parts []taxPart
	var sum int64
	for _, o := range op.entries {
		if o.line == lineID && o.role == "tax" && o.item != 0 {
			a := -sign * o.amount
			parts = append(parts, taxPart{itemID: o.item, agency: o.name, amount: a})
			sum += a
		}
	}
	if len(parts) == 0 || sum != total {
		return nil
	}
	return parts
}

func (ps *poster) add(idx int, acct, amount, name, class, item int64, memo, role string) {
	ps.p.entries = append(ps.p.entries, glEntry{lineIdx: idx, AccountID: acct, Amount: amount, NameID: name,
		ClassID: class, ItemID: item, Memo: memo, Role: role})
}

// lineDefaults: name, class and memo of a line's entries.
func (ps *poster) lineDefaults(l *sline) (int64, int64, string) {
	return or64(l.NameID, ps.s.NameID), or64(l.ClassID, ps.s.ClassID), orStr(l.Description, ps.s.Memo)
}

// lineQty: quantity moved by an inventory line (blank quantity with an amount counts as 1).
func lineQty(l *sline) float64 {
	if l.Qty != nil {
		return *l.Qty
	}
	if l.Amount != 0 {
		return 1
	}
	return 0
}

// buildPosting computes the ledger entries and inventory moves of a transaction
// from its (normalized) header, lines and links. Computed inventory values start
// at oldVals (the value of the same line's move before the edit) and are fixed
// by recost afterwards.
func (e *env) buildPosting(s *stxn, op *oldPosting) (*posting, error) {
	p := &posting{cogsInit: map[int]int64{}}
	if s.Voided || s.IsPending || model.IsNonPosting(s.Type) {
		return p, nil
	}
	var oldVals map[int64]int64
	if op != nil {
		oldVals = op.moveVals
	}
	if oldVals == nil {
		oldVals = map[int64]int64{}
	}
	ps := &poster{e: e, s: s, p: p, oldVals: oldVals, op: op}
	var err error
	switch s.Type {
	case model.TxInvoice, model.TxSalesReceipt, model.TxStatementCharge:
		err = ps.sales(1)
	case model.TxCreditMemo:
		if err = ps.sales(-1); err == nil {
			for _, l := range s.Links {
				if err = ps.creditReclassName(s.NameID, l.To, l.Amount, s.AccountID); err != nil {
					break
				}
			}
		}
	case model.TxPayment:
		err = ps.payment()
	case model.TxRefund:
		ps.add(-1, s.AccountID, -s.Amount, s.NameID, s.ClassID, 0, s.Memo, "header")
		err = ps.refundAR()
	case model.TxDeposit:
		err = ps.deposit()
	case model.TxCheck, model.TxBill, model.TxItemReceipt, model.TxCCCharge:
		err = ps.purchase(1)
	case model.TxVendorCredit, model.TxCCCredit:
		err = ps.purchase(-1)
	case model.TxBillPayment:
		ps.billPayment()
	case model.TxTransfer:
		ps.add(-1, s.AccountID, -s.Amount, 0, s.ClassID, 0, s.Memo, "header")
		ps.add(-1, s.ToAcctID, s.Amount, 0, s.ClassID, 0, s.Memo, "")
	case model.TxJournal:
		for i := range s.Lines {
			l := &s.Lines[i]
			if l.Amount != 0 {
				ps.add(i, l.AccountID, l.Amount, l.NameID, or64(l.ClassID, s.ClassID), 0, orStr(l.Description, s.Memo), "")
			}
		}
	case model.TxInventoryAdjust:
		err = ps.inventoryAdjust()
	case model.TxSalesTaxPayment:
		err = ps.taxPayment()
	}
	if err != nil {
		return nil, err
	}
	var sum int64
	for _, en := range p.entries {
		if en.AccountID == 0 {
			return nil, apperr.Validation("lines", "An account is missing for one of the lines of this transaction.")
		}
		sum += en.Amount
	}
	if sum != 0 {
		return nil, apperr.Validation("lines", "Transaction not in balance (difference %s).", fmtMoney(sum))
	}
	return p, nil
}

// itemSalesAccount: income account of an item on sales forms.
func (ps *poster) itemSalesAccount(it *itemInfo) (int64, error) {
	if a := or64(it.Income, it.Expense); a != 0 {
		return a, nil
	}
	return ps.e.specialAcct(store.SpecialUncategorizedIncome)
}

func (ps *poster) inventoryAccounts(it *itemInfo) (cogs, asset int64, err error) {
	if cogs = it.Expense; cogs == 0 {
		if cogs, err = ps.e.specialAcct(store.SpecialCOGS); err != nil {
			return
		}
	}
	if asset = it.Asset; asset == 0 {
		asset, err = ps.e.specialAcct(store.SpecialInventoryAsset)
	}
	return
}

// taxPart is the share of sales tax owed to one tax item / agency.
type taxPart struct {
	itemID, agency int64
	amount         int64
}

// taxMember is one entry of txns.tax_split: a tax item, its rate and agency
// when the transaction's tax was computed.
type taxMember struct {
	Item   int64   `json:"item"`
	Rate   float64 `json:"rate"`
	Agency int64   `json:"agency,omitempty"`
}

// currentTaxSplit returns the tax_split JSON for a tax item or group today.
func (e *env) currentTaxSplit(it *itemInfo) (string, error) {
	if it == nil {
		return "", nil
	}
	var ms []taxMember
	switch it.Type {
	case model.ItemSalesTax:
		ms = []taxMember{{Item: it.ID, Rate: it.TaxRate, Agency: it.Agency}}
	case model.ItemSalesTaxGroup:
		gm, err := e.members(it)
		if err != nil {
			return "", err
		}
		for _, m := range gm {
			mi, err := e.item(m.ItemID)
			if err != nil {
				return "", err
			}
			if mi != nil {
				ms = append(ms, taxMember{Item: mi.ID, Rate: mi.TaxRate, Agency: mi.Agency})
			}
		}
	default:
		return "", nil
	}
	b, _ := json.Marshal(ms)
	return string(b), nil
}

// storedTaxSplit splits the header tax with the member rates stored on the
// transaction: round(base x memberRate / 100), the last member takes the
// rounding difference. nil when no split is stored.
func storedTaxSplit(split string, base, tax int64) []taxPart {
	if split == "" {
		return nil
	}
	var ms []taxMember
	if json.Unmarshal([]byte(split), &ms) != nil || len(ms) == 0 {
		return nil
	}
	var parts []taxPart
	var done int64
	for i, m := range ms {
		var a int64
		if i == len(ms)-1 {
			a = tax - done
		} else {
			a = rnd(float64(base) * m.Rate / 100)
		}
		done += a
		parts = append(parts, taxPart{itemID: m.Item, agency: m.Agency, amount: a})
	}
	return parts
}

// taxSplit splits a tax amount over the members of a Sales Tax Group:
// round(base x memberRate / 100), the last member takes the rounding difference.
func (e *env) taxSplit(taxItemID, base, tax int64) ([]taxPart, error) {
	it, err := e.item(taxItemID)
	if err != nil {
		return nil, err
	}
	if it == nil {
		return []taxPart{{itemID: taxItemID, amount: tax}}, nil
	}
	if it.Type != model.ItemSalesTaxGroup {
		return []taxPart{{itemID: it.ID, agency: it.Agency, amount: tax}}, nil
	}
	ms, err := e.members(it)
	if err != nil {
		return nil, err
	}
	var mems []*itemInfo
	for _, m := range ms {
		mi, err := e.item(m.ItemID)
		if err != nil {
			return nil, err
		}
		if mi != nil {
			mems = append(mems, mi)
		}
	}
	if len(mems) == 0 {
		return []taxPart{{itemID: it.ID, amount: tax}}, nil
	}
	var parts []taxPart
	var done int64
	for i, mi := range mems {
		var a int64
		if i == len(mems)-1 {
			a = tax - done
		} else {
			a = rnd(float64(base) * mi.TaxRate / 100)
		}
		done += a
		parts = append(parts, taxPart{itemID: mi.ID, agency: mi.Agency, amount: a})
	}
	return parts, nil
}

// sales posts INV / SALESRCPT / STMTCHG (sign 1) and CREDMEM (sign -1).
func (ps *poster) sales(sign int64) error {
	s, e := ps.s, ps.e
	ps.add(-1, s.AccountID, sign*s.Amount, s.NameID, s.ClassID, 0, s.Memo, "header")
	var stp int64
	salesTax := func() (int64, error) {
		if stp != 0 {
			return stp, nil
		}
		var err error
		stp, err = e.specialAcct(store.SpecialSalesTaxPayable)
		return stp, err
	}
	for i := range s.Lines {
		l := &s.Lines[i]
		name, class, memo := ps.lineDefaults(l)
		it, err := e.item(l.ItemID)
		if err != nil {
			return err
		}
		if it == nil {
			if l.AccountID != 0 && l.Amount != 0 {
				ps.add(i, l.AccountID, -sign*l.Amount, name, class, 0, memo, "")
			}
			continue
		}
		switch it.Type {
		case model.ItemSubtotal:
			continue
		case model.ItemPayment:
			acct := it.Deposit
			if acct == 0 {
				if acct, err = e.specialAcct(store.SpecialUndepositedFunds); err != nil {
					return err
				}
			}
			if k := ps.keptAcct(l, ""); k != 0 {
				acct = k
			}
			if l.Amount != 0 {
				ps.add(i, acct, -sign*l.Amount, name, class, it.ID, memo, "")
			}
		case model.ItemSalesTax, model.ItemSalesTaxGroup:
			if l.Amount == 0 {
				continue
			}
			acct, err := salesTax()
			if err != nil {
				return err
			}
			parts := []taxPart{{itemID: it.ID, agency: it.Agency, amount: l.Amount}}
			if kept := ps.keptTax(l.ID, it.ID, sign, l.Amount); kept != nil {
				parts = kept
			} else if it.Type == model.ItemSalesTaxGroup {
				rate, err := e.taxRateOf(it)
				if err != nil {
					return err
				}
				base := l.Amount
				if rate != 0 {
					base = rnd(float64(l.Amount) * 100 / rate)
				}
				if parts, err = e.taxSplit(it.ID, base, l.Amount); err != nil {
					return err
				}
			}
			for _, pt := range parts {
				ps.add(i, acct, -sign*pt.amount, pt.agency, class, pt.itemID, memo, "tax")
			}
		default:
			acct, err := ps.itemSalesAccount(it)
			if err != nil {
				return err
			}
			if k := ps.keptAcct(l, ""); k != 0 {
				acct = k
			}
			if l.Amount != 0 {
				ps.add(i, acct, -sign*l.Amount, name, class, it.ID, memo, "")
			}
			if it.Type == model.ItemInventoryPart {
				q := -float64(sign) * lineQty(l)
				val := ps.oldVals[l.ID]
				cogsAcct, assetAcct, err := ps.inventoryAccounts(it)
				if err != nil {
					return err
				}
				if k := ps.keptAcct(l, "cogs"); k != 0 {
					cogsAcct = k
				}
				if k := ps.keptAcct(l, "inv"); k != 0 {
					assetAcct = k
				}
				ps.p.moves = append(ps.p.moves, invMove{lineIdx: i, ItemID: it.ID, Qty: q, Value: val})
				ps.add(i, cogsAcct, -val, name, class, it.ID, memo, "cogs")
				ps.add(i, assetAcct, val, name, class, it.ID, memo, "inv")
				ps.p.cogsInit[i] = cogsOf(s.Type, val)
			}
		}
	}
	if s.TaxAmount != 0 {
		acct, err := salesTax()
		if err != nil {
			return err
		}
		base, err := e.taxableBase(s)
		if err != nil {
			return err
		}
		parts := ps.keptTax(0, s.TaxItemID, sign, s.TaxAmount)
		if parts == nil {
			parts = storedTaxSplit(s.TaxSplit, base, s.TaxAmount)
		}
		if parts == nil {
			if parts, err = e.taxSplit(s.TaxItemID, base, s.TaxAmount); err != nil {
				return err
			}
		}
		for _, pt := range parts {
			if pt.amount != 0 {
				ps.add(-1, acct, -sign*pt.amount, pt.agency, s.ClassID, pt.itemID, s.Memo, "tax")
			}
		}
	}
	return nil
}

// cogsOf converts a computed move value into txn_lines.cogs: the cost of the
// goods sold for sales (positive), the cost returned for credit memos
// (positive), the value change for quantity adjustments.
func cogsOf(txnType string, value int64) int64 {
	switch txnType {
	case model.TxCreditMemo, model.TxInventoryAdjust:
		return value
	}
	return -value
}

func (ps *poster) payment() error {
	s := ps.s
	ps.add(-1, s.AccountID, s.Amount, s.NameID, s.ClassID, 0, s.Memo, "header")
	// A/R side split by the customer:job of each invoice paid, the rest to the payer
	ar := map[int64]int64{}
	var order []int64
	addAR := func(name, amt int64) {
		if _, ok := ar[name]; !ok {
			order = append(order, name)
		}
		ar[name] += amt
	}
	remaining := s.Amount
	for _, l := range s.Links {
		if l.From != 0 && l.From != s.ID {
			// credit applied: no ledger effect, except moving the A/R between
			// two jobs of the customer when the credit and the invoice differ
			if err := ps.creditReclass(l.From, l.To, l.Amount, s.ArApID); err != nil {
				return err
			}
			continue
		}
		b, err := ps.e.brief(l.To)
		if err != nil {
			return err
		}
		name := s.NameID
		if b != nil && b.NameID != 0 {
			name = b.NameID
		}
		addAR(name, l.Amount+l.Discount)
		remaining -= l.Amount
		if l.Discount != 0 {
			ps.add(-1, l.DiscAcctID, l.Discount, name, s.ClassID, 0, orStr(s.Memo, "Discount"), "discount")
		}
	}
	addAR(s.NameID, remaining)
	for _, name := range order {
		if ar[name] != 0 {
			ps.add(-1, s.ArApID, -ar[name], name, s.ClassID, 0, s.Memo, "")
		}
	}
	return nil
}

// creditReclass: a credit (credit memo, unused payment, journal entry) of one
// customer:job applied to an invoice of another job of the same customer
// moves that amount of A/R from the credit's name to the invoice's name, so
// both jobs show the balance of their open documents.
func (ps *poster) creditReclass(from, to, amount, arAcct int64) error {
	if amount == 0 {
		return nil
	}
	fb, err := ps.e.brief(from)
	if err != nil || fb == nil {
		return err
	}
	return ps.creditReclassName(fb.NameID, to, amount, arAcct)
}

func (ps *poster) creditReclassName(fromName, to, amount, arAcct int64) error {
	if amount == 0 {
		return nil
	}
	tb, err := ps.e.brief(to)
	if err != nil {
		return err
	}
	if tb == nil || fromName == 0 || tb.NameID == 0 || fromName == tb.NameID {
		return nil
	}
	s := ps.s
	ps.add(-1, arAcct, amount, fromName, s.ClassID, 0, s.Memo, "credit")
	ps.add(-1, arAcct, -amount, tb.NameID, s.ClassID, 0, s.Memo, "credit")
	return nil
}

// refundAR posts the A/R side of a refund under the name of each credit it
// refunds (a refund made out to the parent customer of a job's credit memo
// still clears that job's credit).
func (ps *poster) refundAR() error {
	s := ps.s
	ar := map[int64]int64{}
	var order []int64
	add := func(name, amt int64) {
		if _, ok := ar[name]; !ok {
			order = append(order, name)
		}
		ar[name] += amt
	}
	remaining := s.Amount
	for _, l := range s.Links {
		b, err := ps.e.brief(l.To)
		if err != nil {
			return err
		}
		name := s.NameID
		if b != nil && b.NameID != 0 {
			name = b.NameID
		}
		add(name, l.Amount)
		remaining -= l.Amount
	}
	add(s.NameID, remaining)
	for _, name := range order {
		if ar[name] != 0 {
			ps.add(-1, s.ArApID, ar[name], name, s.ClassID, 0, s.Memo, "")
		}
	}
	return nil
}

func (ps *poster) billPayment() {
	s := ps.s
	ps.add(-1, s.AccountID, -s.Amount, s.NameID, s.ClassID, 0, s.Memo, "header")
	var disc int64
	for _, l := range s.Links {
		if (l.From == 0 || l.From == s.ID) && l.Discount != 0 {
			disc += l.Discount
			ps.add(-1, l.DiscAcctID, -l.Discount, s.NameID, s.ClassID, 0, orStr(s.Memo, "Discount"), "discount")
		}
	}
	ps.add(-1, s.ArApID, s.Amount+disc, s.NameID, s.ClassID, 0, s.Memo, "")
}

func (ps *poster) deposit() error {
	s := ps.s
	ps.add(-1, s.AccountID, s.Amount, s.NameID, s.ClassID, 0, s.Memo, "header")
	for i := range s.Lines {
		l := &s.Lines[i]
		if l.Amount == 0 {
			continue
		}
		name, class, memo := ps.lineDefaults(l)
		ps.add(i, l.AccountID, -l.Amount, name, class, 0, memo, "")
	}
	if s.CashBackAmount != 0 {
		ps.add(-1, s.CashBackAcctID, s.CashBackAmount, s.NameID, s.ClassID, 0, orStr(s.CashBackMemo, s.Memo), "cashback")
	}
	return nil
}

// purchase posts CHK / BILL / ITEMRCPT / CCCHARGE (sign 1) and BILLCRED / CCCREDIT (sign -1).
func (ps *poster) purchase(sign int64) error {
	s, e := ps.s, ps.e
	ps.add(-1, s.AccountID, -sign*s.Amount, s.NameID, s.ClassID, 0, s.Memo, "header")
	for i := range s.Lines {
		l := &s.Lines[i]
		name, class, memo := ps.lineDefaults(l)
		it, err := e.item(l.ItemID)
		if err != nil {
			return err
		}
		if l.Kind == model.LineExpense || it == nil {
			if l.Amount != 0 {
				ps.add(i, l.AccountID, sign*l.Amount, name, class, 0, memo, "")
			}
			continue
		}
		switch it.Type {
		case model.ItemSubtotal:
			continue
		case model.ItemInventoryPart:
			_, asset, err := ps.inventoryAccounts(it)
			if err != nil {
				return err
			}
			if k := ps.keptAcct(l, ""); k != 0 {
				asset = k
			}
			if l.Amount != 0 {
				ps.add(i, asset, sign*l.Amount, name, class, it.ID, memo, "")
			}
			ps.p.moves = append(ps.p.moves, invMove{lineIdx: i, ItemID: it.ID, Qty: float64(sign) * lineQty(l), Value: sign * l.Amount, Known: true})
		default:
			acct := purchaseAccount(it)
			if acct == 0 {
				if acct, err = e.specialAcct(store.SpecialUncategorizedExpense); err != nil {
					return err
				}
			}
			if it.Type == model.ItemSalesTax {
				if acct, err = e.specialAcct(store.SpecialSalesTaxPayable); err != nil {
					return err
				}
			}
			if k := ps.keptAcct(l, ""); k != 0 {
				acct = k
			}
			if l.Amount != 0 {
				ps.add(i, acct, sign*l.Amount, name, class, it.ID, memo, "")
			}
		}
	}
	return nil
}

func (ps *poster) inventoryAdjust() error {
	s, e := ps.s, ps.e
	known := s.valueAdjust()
	var total int64
	for i := range s.Lines {
		l := &s.Lines[i]
		it, err := e.item(l.ItemID)
		if err != nil {
			return err
		}
		if it == nil {
			continue
		}
		_, asset, err := ps.inventoryAccounts(it)
		if err != nil {
			return err
		}
		if k := ps.keptAcct(l, "inv"); k != 0 {
			asset = k
		}
		q := 0.0
		if l.Qty != nil {
			q = *l.Qty
		}
		val := l.Amount
		if !known {
			val = ps.oldVals[l.ID]
			ps.p.cogsInit[i] = val
		}
		name, class, memo := ps.lineDefaults(l)
		ps.p.moves = append(ps.p.moves, invMove{lineIdx: i, ItemID: it.ID, Qty: q, Value: val, Known: known})
		ps.add(i, asset, val, name, class, it.ID, memo, "inv")
		total += val
	}
	// the header entry goes first so readers find it easily
	ps.p.entries = append([]glEntry{{lineIdx: -1, AccountID: s.AccountID, Amount: -total, NameID: s.NameID,
		ClassID: s.ClassID, Memo: s.Memo, Role: "header"}}, ps.p.entries...)
	return nil
}

func (ps *poster) taxPayment() error {
	s, e := ps.s, ps.e
	ps.add(-1, s.AccountID, -s.Amount, s.NameID, s.ClassID, 0, s.Memo, "header")
	stp, err := e.specialAcct(store.SpecialSalesTaxPayable)
	if err != nil {
		return err
	}
	if len(s.Lines) == 0 {
		ps.add(-1, stp, s.Amount, s.NameID, s.ClassID, 0, s.Memo, "")
		return nil
	}
	for i := range s.Lines {
		l := &s.Lines[i]
		if l.Amount == 0 {
			continue
		}
		acct := stp
		if l.ItemID == 0 {
			acct = l.AccountID
		}
		ps.add(i, acct, l.Amount, s.NameID, or64(l.ClassID, s.ClassID), l.ItemID, orStr(l.Description, s.Memo), "")
	}
	return nil
}

// ---------------------------------------------------------------------------
// Writing the posting

type oldEntry struct {
	id, acct, line    int64
	amount            int64
	role, cleared     string
	rec               sql.NullInt64
	name, class, item int64
	memo, date        string
}

type moveSig struct {
	line, item int64
	qty        float64
	value      int64
	known      bool
}

type oldPosting struct {
	// editLines (saving a changed version): stored line id -> item id; lines
	// whose item changed get the item's current accounts. nil = lines unchanged.
	editLines  map[int64]int64
	oldTaxItem int64 // tax item of the stored version
	date       string
	moves      []moveSig
	entries    []oldEntry
	moveVals   map[int64]int64   // line id -> value of its computed move
	moveItems  map[int64]bool    // items moved by the transaction
	moveQty    map[int64]float64 // item -> qty moved (signed)
}

func newOldPosting() *oldPosting {
	return &oldPosting{moveVals: map[int64]int64{}, moveItems: map[int64]bool{}, moveQty: map[int64]float64{}}
}

const oldEntryCols = `id, account_id, IFNULL(line_id, 0), amount, role, cleared, reconcile_id,
		IFNULL(name_id, 0), IFNULL(class_id, 0), IFNULL(item_id, 0), memo, date`

func scanOldEntry(r rowScanner, txnID *int64) (oldEntry, error) {
	var o oldEntry
	dest := []any{&o.id, &o.acct, &o.line, &o.amount, &o.role, &o.cleared, &o.rec, &o.name, &o.class, &o.item, &o.memo, &o.date}
	if txnID != nil {
		dest = append([]any{txnID}, dest...)
	}
	return o, r.Scan(dest...)
}

func (op *oldPosting) addMove(line, item int64, qty float64, value int64, known int, date string) {
	op.date = date
	op.moveItems[item] = true
	op.moveQty[item] += qty
	op.moves = append(op.moves, moveSig{line, item, qty, value, known == 1})
	if known == 0 && line != 0 {
		op.moveVals[line] = value
	}
}

func (e *env) loadOldPosting(txnID int64) (*oldPosting, error) {
	op := newOldPosting()
	e.q.QueryRowContext(e.ctx, `SELECT IFNULL(tax_item_id, 0) FROM txns WHERE id = ?`, txnID).Scan(&op.oldTaxItem)
	rows, err := e.q.QueryContext(e.ctx, `SELECT `+oldEntryCols+` FROM gl_entries WHERE txn_id = ? ORDER BY id`, txnID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		o, err := scanOldEntry(rows, nil)
		if err != nil {
			rows.Close()
			return nil, err
		}
		op.entries = append(op.entries, o)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	rows, err = e.q.QueryContext(e.ctx, `SELECT IFNULL(line_id, 0), item_id, qty, value, cost_known, date FROM inventory_moves WHERE txn_id = ? ORDER BY id`, txnID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var line, item, value int64
		var qty float64
		var known int
		var date string
		if err := rows.Scan(&line, &item, &qty, &value, &known, &date); err != nil {
			return nil, err
		}
		op.addMove(line, item, qty, value, known, date)
	}
	return op, rows.Err()
}

// loadAllOldPostings reads the stored ledger entries and inventory moves of
// every transaction in two queries (Rebuild).
func (e *env) loadAllOldPostings(all map[int64]*stxn) (map[int64]*oldPosting, error) {
	out := make(map[int64]*oldPosting, len(all))
	for id, s := range all {
		op := newOldPosting()
		op.oldTaxItem = s.TaxItemID
		out[id] = op
	}
	rows, err := e.q.QueryContext(e.ctx, `SELECT txn_id, `+oldEntryCols+` FROM gl_entries ORDER BY txn_id, id`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var txnID int64
		o, err := scanOldEntry(rows, &txnID)
		if err != nil {
			rows.Close()
			return nil, err
		}
		if op := out[txnID]; op != nil {
			op.entries = append(op.entries, o)
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	rows, err = e.q.QueryContext(e.ctx, `SELECT txn_id, IFNULL(line_id, 0), item_id, qty, value, cost_known, date FROM inventory_moves ORDER BY txn_id, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var txnID, line, item, value int64
		var qty float64
		var known int
		var date string
		if err := rows.Scan(&txnID, &line, &item, &qty, &value, &known, &date); err != nil {
			return nil, err
		}
		if op := out[txnID]; op != nil {
			op.addMove(line, item, qty, value, known, date)
		}
	}
	return out, rows.Err()
}

type entryKey struct {
	acct, line int64
	role       string
}

// writePosting replaces the ledger entries and inventory moves of s. Entries
// that match an old one (same account, line and role) keep its id and cleared
// state; others inherit the cleared state of an old entry of the same account.
// Returns the inventory items whose moves changed (old and new), so that only
// those are re-costed.
func (e *env) writePosting(s *stxn, p *posting, op *oldPosting) (map[int64]bool, error) {
	byKey := map[entryKey][]oldEntry{}
	byAcct := map[int64]oldEntry{}
	for _, o := range op.entries {
		k := entryKey{o.acct, o.line, o.role}
		byKey[k] = append(byKey[k], o)
		if _, ok := byAcct[o.acct]; !ok {
			byAcct[o.acct] = o
		}
	}
	if _, err := e.q.ExecContext(e.ctx, `DELETE FROM gl_entries WHERE txn_id = ?`, s.ID); err != nil {
		return nil, err
	}
	if _, err := e.q.ExecContext(e.ctx, `DELETE FROM inventory_moves WHERE txn_id = ?`, s.ID); err != nil {
		return nil, err
	}
	type row struct {
		id      any
		en      glEntry
		seq     int
		cleared string
		rec     any
	}
	var withID, without []row
	for i, en := range p.entries {
		r := row{en: en, seq: i}
		k := entryKey{en.AccountID, en.LineID, en.Role}
		if lst := byKey[k]; len(lst) > 0 {
			o := lst[0]
			byKey[k] = lst[1:]
			r.id, r.cleared = o.id, o.cleared
			if o.rec.Valid {
				r.rec = o.rec.Int64
			}
			withID = append(withID, r)
			continue
		}
		if o, ok := byAcct[en.AccountID]; ok {
			r.cleared = o.cleared
			if o.rec.Valid {
				r.rec = o.rec.Int64
			}
		}
		without = append(without, r)
	}
	// rows keeping an old id first, so new ids can never take one of them
	for _, r := range append(withID, without...) {
		en := r.en
		if _, err := e.q.ExecContext(e.ctx, `INSERT INTO gl_entries(id, txn_id, line_id, seq, date, account_id, amount, name_id,
			class_id, item_id, memo, role, cleared, reconcile_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			r.id, s.ID, nz(en.LineID), r.seq, s.Date, en.AccountID, en.Amount, nz(en.NameID), nz(en.ClassID), nz(en.ItemID),
			en.Memo, en.Role, r.cleared, r.rec); err != nil {
			return nil, fmt.Errorf("write ledger entry: %w", err)
		}
	}
	byItem := map[int64][]moveSig{}
	for _, m := range op.moves {
		byItem[m.item] = append(byItem[m.item], m)
	}
	items := map[int64]bool{}
	newByItem := map[int64][]moveSig{}
	for _, m := range p.moves {
		newByItem[m.ItemID] = append(newByItem[m.ItemID], moveSig{m.LineID, m.ItemID, m.Qty, m.Value, m.Known})
	}
	for _, set := range []map[int64][]moveSig{byItem, newByItem} {
		for item := range set {
			a, b := byItem[item], newByItem[item]
			same := len(a) == len(b) && (len(a) == 0 || op.date == s.Date)
			for i := 0; same && i < len(a); i++ {
				same = a[i] == b[i]
			}
			if !same {
				items[item] = true
			}
		}
	}
	for _, m := range p.moves {
		if _, err := e.q.ExecContext(e.ctx, `INSERT INTO inventory_moves(txn_id, line_id, item_id, date, qty, value, cost_known)
			VALUES(?,?,?,?,?,?,?)`, s.ID, nz(m.LineID), m.ItemID, s.Date, m.Qty, m.Value, store.B(m.Known)); err != nil {
			return nil, err
		}
	}
	return items, nil
}

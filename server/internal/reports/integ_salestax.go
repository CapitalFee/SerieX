package reports

// Sales tax on the cash basis (prefs.salesTaxBasis = "cash"): the tax of an
// invoice or credit memo becomes due in proportion to the payments and credits
// applied to it, the same rule the cash basis financial reports use.

import (
	"context"

	"seriex/internal/model"
	"seriex/internal/store"
)

// SalesTaxEntry is one amount posted (or, on the cash basis, recognized) on
// a Sales Tax Payable account. Amount is signed: debit +, credit -.
type SalesTaxEntry struct {
	TxnID   int64
	TxnType string
	Date    string
	ItemID  int64
	NameID  int64 // the agency (or the name on an adjustment)
	Amount  int64
	// SrcTxnID is, on the cash basis, the payment or credit that recognized
	// an invoice's tax (0 for entries posted as they are)
	SrcTxnID int64
}

// SalesTaxPayableEntries returns the Sales Tax Payable entries dated on or
// before `to`. With cash = true the entries of invoices, statement charges and
// credit memos are replaced by their share recognized by the payments and
// credits applied to them (dated at the paying transaction).
func SalesTaxPayableEntries(ctx context.Context, q store.Q, to string, cash bool) ([]SalesTaxEntry, error) {
	prefs, err := store.LoadPrefs(ctx, q)
	if err != nil {
		return nil, err
	}
	c, err := finNew(ctx, q, &Params{Prefs: prefs, To: to})
	if err != nil {
		return nil, err
	}
	es, err := c.entries("", to, cash)
	if err != nil {
		return nil, err
	}
	out := []SalesTaxEntry{}
	for _, e := range es {
		a := c.accts[e.AccountID]
		if a == nil || a.Special != store.SpecialSalesTaxPayable {
			continue
		}
		var typ string
		if t := c.txns[e.TxnID]; t != nil {
			typ = t.Type
		}
		out = append(out, SalesTaxEntry{TxnID: e.TxnID, TxnType: typ, Date: e.Date, ItemID: e.ItemID, NameID: e.NameID, Amount: e.Amount, SrcTxnID: e.Src})
	}
	return out, nil
}

// integTaxBasis is the basis of the sales tax reports: the report's basis
// parameter when given, else the sales tax preference.
func integTaxBasis(p *Params) string {
	switch b := p.Values.Get("basis"); b {
	case "cash", "accrual":
		return b
	}
	if p.Prefs.SalesTaxBasis == "cash" {
		return "cash"
	}
	return "accrual"
}

// integCashSalesFactors returns, for every invoice, statement charge and
// credit memo, the share of it recognized in [from, to] on the cash basis
// (payments and credits applied to it dated in the period / its amount).
func integCashSalesFactors(ctx context.Context, q store.Q, from, to string) (map[int64]float64, error) {
	amounts := map[int64]int64{}
	types := map[int64]string{}
	rows, err := q.QueryContext(ctx, `SELECT id, type, amount FROM txns WHERE type IN ('INV','STMTCHG','CREDMEM')
		AND voided = 0 AND is_pending = 0 AND amount <> 0`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id, amt int64
		var typ string
		if err := rows.Scan(&id, &typ, &amt); err != nil {
			rows.Close()
			return nil, err
		}
		amounts[id], types[id] = amt, typ
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	paid := map[int64]int64{}
	lrows, err := q.QueryContext(ctx, `SELECT from_txn_id, to_txn_id, amount, discount FROM txn_links WHERE date >= ? AND date <= ?`, from, to)
	if err != nil {
		return nil, err
	}
	defer lrows.Close()
	for lrows.Next() {
		var f, t, amt, disc int64
		if err := lrows.Scan(&f, &t, &amt, &disc); err != nil {
			return nil, err
		}
		if _, ok := amounts[t]; ok {
			paid[t] += amt + disc
		}
		if _, ok := amounts[f]; ok && types[f] == model.TxCreditMemo {
			paid[f] += amt
		}
	}
	if err := lrows.Err(); err != nil {
		return nil, err
	}
	out := map[int64]float64{}
	for id, amt := range amounts {
		if p := paid[id]; p != 0 {
			f := float64(p) / float64(amt)
			if f > 1 {
				f = 1
			}
			out[id] = f
		}
	}
	return out, nil
}

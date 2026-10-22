package ledger

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"sort"
	"strconv"
	"strings"

	"seriex/internal/apperr"
	"seriex/internal/model"
	"seriex/internal/store"
)

const txnCols = `id, type, ref_number, date, name_id, account_id, ar_ap_account_id, to_account_id, amount,
	open_balance, subtotal, due_date, ship_date, terms_id, class_id, rep_id, ship_via_id, customer_message_id,
	payment_method_id, fob, po_number, memo, bill_address, ship_address, tax_item_id, tax_rate, tax_amount,
	to_be_printed, to_be_emailed, is_pending, status, voided, cash_back_account_id, cash_back_amount,
	cash_back_memo, template, extra, created_by, created_at, updated_at, tax_split`

const lineCols = `id, seq, kind, item_id, account_id, description, qty, rate, rate_is_percent, amount, class_id,
	name_id, billable, billed_txn_id, taxable, service_date, payment_method_id, ref_number, linked_txn_id,
	linked_line_id, received_qty, closed, cogs`

// rowScanner is *sql.Row or *sql.Rows.
type rowScanner interface{ Scan(dest ...any) error }

// scanTxn reads one txns row selected with txnCols.
func scanTxn(r rowScanner) (*stxn, error) {
	var s stxn
	var name, acct, arap, toAcct, terms, class, rep, shipVia, msg, pm, taxItem, cbAcct sql.NullInt64
	var printed, emailed, pending, voided int
	var extra string
	err := r.Scan(
		&s.ID, &s.Type, &s.Ref, &s.Date, &name, &acct, &arap, &toAcct, &s.Amount,
		&s.OpenBalance, &s.Subtotal, &s.DueDate, &s.ShipDate, &terms, &class, &rep, &shipVia, &msg,
		&pm, &s.FOB, &s.PONumber, &s.Memo, &s.BillAddress, &s.ShipAddress, &taxItem, &s.TaxRate, &s.TaxAmount,
		&printed, &emailed, &pending, &s.Status, &voided, &cbAcct, &s.CashBackAmount,
		&s.CashBackMemo, &s.Template, &extra, &s.CreatedBy, &s.CreatedAt, &s.UpdatedAt, &s.TaxSplit)
	if err != nil {
		return nil, err
	}
	s.NameID, s.AccountID, s.ArApID, s.ToAcctID = ni(name), ni(acct), ni(arap), ni(toAcct)
	s.TermsID, s.ClassID, s.RepID, s.ShipViaID, s.CustMsgID, s.PayMethodID = ni(terms), ni(class), ni(rep), ni(shipVia), ni(msg), ni(pm)
	s.TaxItemID, s.CashBackAcctID = ni(taxItem), ni(cbAcct)
	s.ToBePrinted, s.ToBeEmailed, s.IsPending, s.Voided = printed == 1, emailed == 1, pending == 1, voided == 1
	s.Extra = map[string]any{}
	if extra != "" {
		// numbers stay json.Number so extra comes back exactly as it was sent
		dec := json.NewDecoder(strings.NewReader(extra))
		dec.UseNumber()
		_ = dec.Decode(&s.Extra)
	}
	return &s, nil
}

// loadStored reads a transaction with its lines and owned links.
// Missing ids return apperr.NotFound.
func loadStored(ctx context.Context, q store.Q, id int64) (*stxn, error) {
	s, err := scanTxn(q.QueryRowContext(ctx, `SELECT `+txnCols+` FROM txns WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, apperr.NotFound("Transaction %d was not found. It may have been deleted.", id)
	}
	if err != nil {
		return nil, err
	}
	if s.Lines, err = loadLines(ctx, q, id); err != nil {
		return nil, err
	}
	if s.Links, err = loadOwnedLinks(ctx, q, id); err != nil {
		return nil, err
	}
	return s, nil
}

// loadAllStored reads every transaction with its lines and owned links in a
// few queries (Rebuild); ids are in (date, id) order.
func loadAllStored(ctx context.Context, q store.Q) (map[int64]*stxn, []int64, error) {
	all := map[int64]*stxn{}
	var ids []int64
	rows, err := q.QueryContext(ctx, `SELECT `+txnCols+` FROM txns ORDER BY date, id`)
	if err != nil {
		return nil, nil, err
	}
	for rows.Next() {
		s, err := scanTxn(rows)
		if err != nil {
			rows.Close()
			return nil, nil, err
		}
		all[s.ID] = s
		ids = append(ids, s.ID)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, nil, err
	}
	rows.Close()
	rows, err = q.QueryContext(ctx, `SELECT txn_id, `+lineCols+` FROM txn_lines ORDER BY txn_id, seq, id`)
	if err != nil {
		return nil, nil, err
	}
	for rows.Next() {
		var txnID int64
		l, err := scanLine(rows, &txnID)
		if err != nil {
			rows.Close()
			return nil, nil, err
		}
		if s := all[txnID]; s != nil {
			s.Lines = append(s.Lines, l)
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, nil, err
	}
	rows.Close()
	rows, err = q.QueryContext(ctx, `SELECT id, from_txn_id, to_txn_id, owner_txn_id, amount, discount, discount_account_id, date
		FROM txn_links ORDER BY owner_txn_id, id`)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	for rows.Next() {
		l, err := scanLink(rows)
		if err != nil {
			return nil, nil, err
		}
		if s := all[l.Owner]; s != nil {
			s.Links = append(s.Links, l)
		}
	}
	return all, ids, rows.Err()
}

func scanLine(r rowScanner, txnID *int64) (sline, error) {
	var l sline
	var item, acct, class, name, billed, pm, ltxn, lline sql.NullInt64
	var qty, rate sql.NullFloat64
	var pct, billable, taxable, closed int
	dest := []any{&l.ID, &l.Seq, &l.Kind, &item, &acct, &l.Description, &qty, &rate, &pct, &l.Amount, &class,
		&name, &billable, &billed, &taxable, &l.ServiceDate, &pm, &l.RefNumber, &ltxn,
		&lline, &l.ReceivedQty, &closed, &l.Cogs}
	if txnID != nil {
		dest = append([]any{txnID}, dest...)
	}
	if err := r.Scan(dest...); err != nil {
		return l, err
	}
	l.ItemID, l.AccountID, l.ClassID, l.NameID = ni(item), ni(acct), ni(class), ni(name)
	l.BilledTxnID, l.PayMethodID, l.LinkedTxnID, l.LinkedLineID = ni(billed), ni(pm), ni(ltxn), ni(lline)
	l.Qty, l.Rate = nfp(qty), nfp(rate)
	l.RateIsPercent, l.Billable, l.Taxable, l.Closed = pct == 1, billable == 1, taxable == 1, closed == 1
	return l, nil
}

func scanLink(r rowScanner) (slink, error) {
	var l slink
	var da sql.NullInt64
	if err := r.Scan(&l.ID, &l.From, &l.To, &l.Owner, &l.Amount, &l.Discount, &da, &l.Date); err != nil {
		return l, err
	}
	l.DiscAcctID = ni(da)
	return l, nil
}

func loadLines(ctx context.Context, q store.Q, txnID int64) ([]sline, error) {
	rows, err := q.QueryContext(ctx, `SELECT `+lineCols+` FROM txn_lines WHERE txn_id = ? ORDER BY seq, id`, txnID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []sline
	for rows.Next() {
		l, err := scanLine(rows, nil)
		if err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

func loadOwnedLinks(ctx context.Context, q store.Q, txnID int64) ([]slink, error) {
	rows, err := q.QueryContext(ctx, `SELECT id, from_txn_id, to_txn_id, owner_txn_id, amount, discount, discount_account_id, date
		FROM txn_links WHERE owner_txn_id = ? ORDER BY id`, txnID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []slink
	for rows.Next() {
		l, err := scanLink(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// fromModel converts the JSON form of a transaction to storage form.
func fromModel(t *model.Txn) *stxn {
	s := &stxn{
		ID: t.ID, Type: strings.TrimSpace(t.Type), Ref: strings.TrimSpace(t.RefNumber), Date: strings.TrimSpace(t.Date),
		NameID: idOf(t.NameID), AccountID: idOf(t.AccountID), ArApID: idOf(t.ArApAccountID), ToAcctID: idOf(t.ToAccountID),
		Amount: store.Cents(t.Amount), DueDate: strings.TrimSpace(t.DueDate), ShipDate: strings.TrimSpace(t.ShipDate),
		TermsID: idOf(t.TermsID), ClassID: idOf(t.ClassID), RepID: idOf(t.RepID), ShipViaID: idOf(t.ShipViaID),
		CustMsgID: idOf(t.CustomerMessageID), PayMethodID: idOf(t.PaymentMethodID),
		FOB: t.FOB, PONumber: t.PONumber, Memo: t.Memo, BillAddress: t.BillAddress, ShipAddress: t.ShipAddress,
		TaxItemID: idOf(t.TaxItemID), ToBePrinted: t.ToBePrinted, ToBeEmailed: t.ToBeEmailed, IsPending: t.IsPending,
		Status: t.Status, CashBackAcctID: idOf(t.CashBackAccountID), CashBackAmount: store.Cents(t.CashBackAmount),
		CashBackMemo: t.CashBackMemo, Template: t.Template, Extra: t.Extra,
	}
	if s.Extra == nil {
		s.Extra = map[string]any{}
	}
	for _, l := range t.Lines {
		s.Lines = append(s.Lines, sline{
			ID: l.ID, Kind: l.Kind, ItemID: idOf(l.ItemID), AccountID: idOf(l.AccountID), Description: l.Description,
			Qty: l.Qty, Rate: l.Rate, RateIsPercent: l.RateIsPercent, Amount: store.Cents(l.Amount),
			ClassID: idOf(l.ClassID), NameID: idOf(l.NameID), Billable: l.Billable, Taxable: l.Taxable,
			ServiceDate: strings.TrimSpace(l.ServiceDate), PayMethodID: idOf(l.PaymentMethodID), RefNumber: l.RefNumber,
			LinkedTxnID: idOf(l.LinkedTxnID), LinkedLineID: idOf(l.LinkedLineID), Closed: l.Closed,
		})
	}
	for _, l := range t.Links {
		s.Links = append(s.Links, slink{From: idOf(l.FromTxnID), To: l.ToTxnID, Amount: store.Cents(l.Amount),
			Discount: store.Cents(l.Discount), DiscAcctID: idOf(l.DiscountAccountID)})
	}
	return s
}

// toModel converts storage form to JSON form (without links / linked / names).
func (s *stxn) toModel() *model.Txn {
	t := &model.Txn{
		ID: s.ID, Type: s.Type, RefNumber: s.Ref, Date: s.Date, NameID: ptrOf(s.NameID), AccountID: ptrOf(s.AccountID),
		ArApAccountID: ptrOf(s.ArApID), ToAccountID: ptrOf(s.ToAcctID), Amount: store.Dollars(s.Amount),
		OpenBalance: store.Dollars(s.OpenBalance), Subtotal: store.Dollars(s.Subtotal), DueDate: s.DueDate,
		ShipDate: s.ShipDate, TermsID: ptrOf(s.TermsID), ClassID: ptrOf(s.ClassID), RepID: ptrOf(s.RepID),
		ShipViaID: ptrOf(s.ShipViaID), CustomerMessageID: ptrOf(s.CustMsgID), PaymentMethodID: ptrOf(s.PayMethodID),
		FOB: s.FOB, PONumber: s.PONumber, Memo: s.Memo, BillAddress: s.BillAddress, ShipAddress: s.ShipAddress,
		TaxItemID: ptrOf(s.TaxItemID), TaxRate: s.TaxRate, TaxAmount: store.Dollars(s.TaxAmount),
		ToBePrinted: s.ToBePrinted, ToBeEmailed: s.ToBeEmailed, IsPending: s.IsPending, Status: s.Status,
		Voided: s.Voided, CashBackAccountID: ptrOf(s.CashBackAcctID), CashBackAmount: store.Dollars(s.CashBackAmount),
		CashBackMemo: s.CashBackMemo, Template: s.Template, Extra: s.Extra,
		CreatedBy: s.CreatedBy, CreatedAt: s.CreatedAt, UpdatedAt: s.UpdatedAt,
		Lines: []model.TxnLine{}, Links: []model.TxnLink{}, Linked: []model.LinkedTxn{},
	}
	if t.Extra == nil {
		t.Extra = map[string]any{}
	}
	for _, l := range s.Lines {
		t.Lines = append(t.Lines, model.TxnLine{
			ID: l.ID, Seq: l.Seq, Kind: l.Kind, ItemID: ptrOf(l.ItemID), AccountID: ptrOf(l.AccountID),
			Description: l.Description, Qty: l.Qty, Rate: l.Rate, RateIsPercent: l.RateIsPercent,
			Amount: store.Dollars(l.Amount), ClassID: ptrOf(l.ClassID), NameID: ptrOf(l.NameID), Billable: l.Billable,
			BilledTxnID: ptrOf(l.BilledTxnID), Taxable: l.Taxable, ServiceDate: l.ServiceDate,
			PaymentMethodID: ptrOf(l.PayMethodID), RefNumber: l.RefNumber, LinkedTxnID: ptrOf(l.LinkedTxnID),
			LinkedLineID: ptrOf(l.LinkedLineID), ReceivedQty: l.ReceivedQty, Closed: l.Closed, Cogs: store.Dollars(l.Cogs),
		})
	}
	return t
}

// statusOf returns the displayed status: pending INV/SALESRCPT "Pending",
// INV/BILL "Paid"/"Open", others the stored one.
func statusOf(typ string, amount, open int64, stored string, pending bool) string {
	if pending && (typ == model.TxInvoice || typ == model.TxSalesReceipt) {
		return "Pending"
	}
	if typ == model.TxInvoice || typ == model.TxBill {
		if open == 0 && amount > 0 {
			return "Paid"
		}
		return "Open"
	}
	return stored
}

// getTxn loads the full transaction for the API.
func getTxn(ctx context.Context, q store.Q, id int64) (*model.Txn, error) {
	s, err := loadStored(ctx, q, id)
	if err != nil {
		return nil, err
	}
	t := s.toModel()
	t.Status = statusOf(s.Type, s.Amount, s.OpenBalance, s.Status, s.IsPending)
	if s.NameID != 0 {
		t.NameFull = store.FullName(ctx, q, "names", s.NameID)
	}
	var cleared sql.NullString
	err = q.QueryRowContext(ctx, `SELECT cleared FROM gl_entries WHERE txn_id = ? AND role = 'header' ORDER BY id LIMIT 1`, id).Scan(&cleared)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	t.Cleared = cleared.String

	// owned links with descriptions of both sides
	rows, err := q.QueryContext(ctx, `SELECT l.id, l.from_txn_id, l.to_txn_id, l.amount, l.discount, l.discount_account_id,
		f.type, f.ref_number, f.date, o.type, o.ref_number, o.date, o.amount
		FROM txn_links l JOIN txns f ON f.id = l.from_txn_id JOIN txns o ON o.id = l.to_txn_id
		WHERE l.owner_txn_id = ? ORDER BY l.id`, id)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var lk model.TxnLink
		var from, amount, discount, toAmount int64
		var da sql.NullInt64
		if err := rows.Scan(&lk.ID, &from, &lk.ToTxnID, &amount, &discount, &da, &lk.FromType, &lk.FromRefNumber,
			&lk.FromDate, &lk.ToType, &lk.ToRefNumber, &lk.ToDate, &toAmount); err != nil {
			rows.Close()
			return nil, err
		}
		lk.FromTxnID = ptrOf(from)
		lk.Amount, lk.Discount, lk.ToAmount = store.Dollars(amount), store.Dollars(discount), store.Dollars(toAmount)
		lk.DiscountAccountID = store.PtrID(da)
		t.Links = append(t.Links, lk)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	if t.Linked, err = loadLinked(ctx, q, s); err != nil {
		return nil, err
	}
	return t, nil
}

func relationOf(typ string) string {
	switch typ {
	case model.TxPayment, model.TxBillPayment:
		return "payment"
	case model.TxCreditMemo, model.TxVendorCredit:
		return "credit"
	case model.TxRefund:
		return "refund"
	case model.TxInvoice, model.TxStatementCharge:
		return "invoice"
	case model.TxBill:
		return "bill"
	case model.TxItemReceipt:
		return "item receipt"
	case model.TxPurchaseOrder:
		return "purchase order"
	case model.TxEstimate:
		return "estimate"
	case model.TxDeposit:
		return "deposit"
	case model.TxSalesReceipt:
		return "sales receipt"
	}
	return strings.ToLower(TypeLabel(typ, ""))
}

// loadLinked builds the Transaction History list of a transaction.
func loadLinked(ctx context.Context, q store.Q, s *stxn) ([]model.LinkedTxn, error) {
	type acc struct {
		id     int64
		rel    string
		amount int64
		useTxn bool
	}
	byKey := map[string]*acc{}
	var order []*acc
	add := func(id int64, rel string, amount int64, useTxn bool) {
		if id == 0 || id == s.ID {
			return
		}
		k := rel + ":" + strconv.FormatInt(id, 10)
		if a, ok := byKey[k]; ok {
			a.amount += amount
			return
		}
		a := &acc{id: id, rel: rel, amount: amount, useTxn: useTxn}
		byKey[k] = a
		order = append(order, a)
	}
	type rowFn func(id int64, typ string, amount int64)
	scan := func(query string, fn rowFn, args ...any) error {
		rows, err := q.QueryContext(ctx, query, args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var id, amount int64
			var typ string
			if err := rows.Scan(&id, &typ, &amount); err != nil {
				return err
			}
			fn(id, typ, amount)
		}
		return rows.Err()
	}
	// payments / credits / refunds applied to it
	if err := scan(`SELECT l.from_txn_id, f.type, l.amount + l.discount FROM txn_links l JOIN txns f ON f.id = l.from_txn_id
		WHERE l.to_txn_id = ? ORDER BY l.id`, func(id int64, typ string, amount int64) {
		add(id, relationOf(typ), amount, false)
	}, s.ID); err != nil {
		return nil, err
	}
	// what it paid / was applied to / refunded
	if err := scan(`SELECT l.to_txn_id, o.type, l.amount + l.discount FROM txn_links l JOIN txns o ON o.id = l.to_txn_id
		WHERE l.from_txn_id = ? ORDER BY l.id`, func(id int64, typ string, amount int64) {
		add(id, relationOf(typ), amount, false)
	}, s.ID); err != nil {
		return nil, err
	}
	// credits it applied on behalf of others (payment applying a credit memo)
	if err := scan(`SELECT l.from_txn_id, f.type, l.amount FROM txn_links l JOIN txns f ON f.id = l.from_txn_id
		WHERE l.owner_txn_id = ? AND l.from_txn_id <> ? ORDER BY l.id`, func(id int64, typ string, amount int64) {
		add(id, relationOf(typ), amount, false)
	}, s.ID, s.ID); err != nil {
		return nil, err
	}
	// deposits containing it
	if err := scan(`SELECT d.id, d.type, l.amount FROM txn_lines l JOIN txns d ON d.id = l.txn_id
		WHERE l.linked_txn_id = ? AND d.type = 'DEP' ORDER BY d.id`, func(id int64, typ string, amount int64) {
		add(id, "deposit", amount, false)
	}, s.ID); err != nil {
		return nil, err
	}
	if s.Type == model.TxDeposit {
		// payments it deposited
		for _, l := range s.Lines {
			if l.LinkedTxnID != 0 {
				var typ string
				if err := q.QueryRowContext(ctx, `SELECT type FROM txns WHERE id = ?`, l.LinkedTxnID).Scan(&typ); err == nil {
					add(l.LinkedTxnID, relationOf(typ), l.Amount, false)
				}
			}
		}
	} else {
		// purchase orders / estimates / billable cost sources its lines come from
		if err := scan(`SELECT t.id, t.type, t.amount FROM txns t WHERE t.id IN (
				SELECT linked_txn_id FROM txn_lines WHERE txn_id = ? AND linked_txn_id IS NOT NULL
				UNION SELECT l2.txn_id FROM txn_lines l1 JOIN txn_lines l2 ON l2.id = l1.linked_line_id WHERE l1.txn_id = ?)
			ORDER BY t.date, t.id`, func(id int64, typ string, amount int64) {
			add(id, relationOf(typ), amount, true)
		}, s.ID, s.ID); err != nil {
			return nil, err
		}
		// transactions whose lines come from it (bills of a PO, invoices of an estimate or of its billable costs)
		if err := scan(`SELECT DISTINCT t.id, t.type, t.amount FROM txn_lines l JOIN txns t ON t.id = l.txn_id
			WHERE (l.linked_txn_id = ? OR l.linked_line_id IN (SELECT id FROM txn_lines WHERE txn_id = ?))
			  AND t.id <> ? AND t.type <> 'DEP' ORDER BY t.date, t.id`, func(id int64, typ string, amount int64) {
			add(id, relationOf(typ), amount, true)
		}, s.ID, s.ID, s.ID); err != nil {
			return nil, err
		}
	}
	out := []model.LinkedTxn{}
	for _, a := range order {
		var lt model.LinkedTxn
		var amount int64
		var acctType string
		err := q.QueryRowContext(ctx, `SELECT t.type, t.date, t.ref_number, t.amount, IFNULL(a.type, '')
			FROM txns t LEFT JOIN accounts a ON a.id = t.account_id WHERE t.id = ?`, a.id).
			Scan(&lt.Type, &lt.Date, &lt.RefNumber, &amount, &acctType)
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return nil, err
		}
		lt.TxnID = a.id
		lt.TypeLabel = TypeLabel(lt.Type, acctType)
		lt.Relation = a.rel
		if a.useTxn {
			lt.Amount = store.Dollars(amount)
		} else {
			lt.Amount = store.Dollars(a.amount)
		}
		out = append(out, lt)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Date != out[j].Date {
			return out[i].Date < out[j].Date
		}
		return out[i].TxnID < out[j].TxnID
	})
	return out, nil
}

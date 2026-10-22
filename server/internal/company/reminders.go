package company

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	"seriex/internal/httpx"
	"seriex/internal/ledger"
	"seriex/internal/model"
	"seriex/internal/store"
)

func txnLabel(typ, ref, name string) string {
	label := model.TxnTypeLabels[typ]
	if label == "" {
		label = typ
	}
	if typ == model.TxBillPayment {
		label = "Bill Payment"
	}
	if ref != "" {
		label += " #" + ref
	}
	if name != "" {
		label += " - " + name
	}
	return label
}

func fmtQty(f float64) string {
	s := fmt.Sprintf("%.4f", f)
	s = strings.TrimRight(strings.TrimRight(s, "0"), ".")
	if s == "-0" {
		s = "0"
	}
	return s
}

// reminderTxns runs a txns query returning (id, type, ref, date, name_id, amount)
// and turns each row into a reminder item.
func reminderTxns(ctx context.Context, q store.Q, names map[int64]string, query string, args ...any) ([]model.ReminderItem, error) {
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.ReminderItem{}
	for rows.Next() {
		var id, amount int64
		var typ, ref, date string
		var nameID sql.NullInt64
		if err := rows.Scan(&id, &typ, &ref, &date, &nameID, &amount); err != nil {
			return nil, err
		}
		txnID := id
		out = append(out, model.ReminderItem{
			Label:  txnLabel(typ, ref, names[nameID.Int64]),
			Date:   date,
			Amount: store.Dollars(amount),
			TxnID:  &txnID,
		})
	}
	return out, rows.Err()
}

// GET /reminders -> every reminder group (empty groups included) in a fixed order.
func getReminders(c *httpx.Ctx) error {
	ctx := c.Context()
	q := c.DB
	today := store.Today()
	names, err := store.FullNames(ctx, q, "names")
	if err != nil {
		return err
	}
	var groups []model.ReminderGroup
	add := func(key, label string, items []model.ReminderItem) {
		if items == nil {
			items = []model.ReminderItem{}
		}
		var total int64
		for _, it := range items {
			total += store.Cents(it.Amount)
		}
		groups = append(groups, model.ReminderGroup{Key: key, Label: label, Total: store.Dollars(total), Items: items})
	}
	dueExpr := `(CASE WHEN due_date <> '' THEN due_date ELSE date END)`

	// Overdue invoices / statement charges.
	items, err := reminderTxns(ctx, q, names, `SELECT id, type, ref_number, `+dueExpr+`, name_id, open_balance FROM txns
		WHERE type IN ('INV', 'STMTCHG') AND voided = 0 AND is_pending = 0 AND open_balance > 0 AND `+dueExpr+` < ?
		ORDER BY 4, id`, today)
	if err != nil {
		return err
	}
	add("overdue_invoices", "Overdue Invoices", items)

	// Bills due within 7 days or overdue.
	items, err = reminderTxns(ctx, q, names, `SELECT id, type, ref_number, `+dueExpr+`, name_id, open_balance FROM txns
		WHERE type = 'BILL' AND voided = 0 AND open_balance > 0 AND `+dueExpr+` <= ?
		ORDER BY 4, id`, store.AddDays(today, 7))
	if err != nil {
		return err
	}
	add("bills_to_pay", "Bills to Pay", items)

	// Checks to print (checks, bill payments, sales tax payments and refunds drawn on a bank account).
	items, err = reminderTxns(ctx, q, names, `SELECT t.id, t.type, t.ref_number, t.date, t.name_id, t.amount FROM txns t
		JOIN accounts a ON a.id = t.account_id
		WHERE t.to_be_printed = 1 AND t.voided = 0 AND t.type IN ('CHK', 'BILLPMT', 'TAXPMT', 'REFUND') AND a.type = 'Bank'
		ORDER BY t.date, t.id`)
	if err != nil {
		return err
	}
	add("checks_to_print", "Checks to Print", items)

	// Invoices to print.
	items, err = reminderTxns(ctx, q, names, `SELECT id, type, ref_number, date, name_id, amount FROM txns
		WHERE type = 'INV' AND to_be_printed = 1 AND voided = 0 ORDER BY date, id`)
	if err != nil {
		return err
	}
	add("invoices_to_print", "Invoices to Print", items)

	// Money to deposit: payments / sales receipts sitting in Undeposited Funds.
	items = nil
	var ufID int64
	err = q.QueryRowContext(ctx, `SELECT id FROM accounts WHERE special = ? ORDER BY id LIMIT 1`, store.SpecialUndepositedFunds).Scan(&ufID)
	if err != nil && err != sql.ErrNoRows {
		return err
	}
	if ufID != 0 {
		items, err = reminderTxns(ctx, q, names, `SELECT t.id, t.type, t.ref_number, t.date, t.name_id,
				(SELECT SUM(g.amount) FROM gl_entries g WHERE g.txn_id = t.id AND g.account_id = ?) FROM txns t
			WHERE t.type IN ('PMT', 'SALESRCPT') AND t.voided = 0
			  AND EXISTS (SELECT 1 FROM gl_entries g WHERE g.txn_id = t.id AND g.account_id = ? AND g.amount > 0)
			  AND NOT EXISTS (SELECT 1 FROM txn_lines l JOIN txns d ON d.id = l.txn_id WHERE l.linked_txn_id = t.id AND d.type = 'DEP')
			ORDER BY t.date, t.id`, ufID, ufID)
		if err != nil {
			return err
		}
	}
	add("money_to_deposit", "Money to Deposit", items)

	// Inventory to reorder.
	items = []model.ReminderItem{}
	itemNames, err := store.FullNames(ctx, q, "items")
	if err != nil {
		return err
	}
	rows, err := q.QueryContext(ctx, `SELECT id, qty_on_hand, reorder_point FROM items
		WHERE type = ? AND active = 1 AND reorder_point IS NOT NULL AND qty_on_hand <= reorder_point ORDER BY name`, model.ItemInventoryPart)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id int64
		var qty, rp float64
		if err := rows.Scan(&id, &qty, &rp); err != nil {
			rows.Close()
			return err
		}
		itemID := id
		items = append(items, model.ReminderItem{
			Label:  fmt.Sprintf("%s (on hand %s, reorder point %s)", itemNames[id], fmtQty(qty), fmtQty(rp)),
			Date:   today,
			ItemID: &itemID,
		})
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	add("inventory_to_reorder", "Inventory to Reorder", items)

	// Memorized transactions with a "remind me" schedule that are due.
	items = []model.ReminderItem{}
	ms, err := loadMemorizedList(ctx, q, `WHERE schedule = 'remind' AND next_date <> '' AND (remaining IS NULL OR remaining > 0)`)
	if err != nil {
		return err
	}
	for _, m := range ms {
		if m.NextDate > store.AddDays(today, m.DaysInAdvance) {
			continue
		}
		mid := m.ID
		items = append(items, model.ReminderItem{Label: m.Name, Date: m.NextDate, Amount: m.Amount, MemorizedID: &mid})
	}
	// Automatic ones still due: entering them failed (for example a missing
	// account or the closing date) or was skipped.
	autos, err := loadMemorizedList(ctx, q, `WHERE schedule = 'auto' AND next_date <> '' AND next_date <= ? AND (remaining IS NULL OR remaining > 0)`, today)
	if err != nil {
		return err
	}
	for _, m := range autos {
		mid := m.ID
		items = append(items, model.ReminderItem{Label: m.Name, Date: m.NextDate, Amount: m.Amount, MemorizedID: &mid,
			Note: "Could not be entered automatically. Open it to enter it yourself."})
	}
	add("memorized_due", "Memorized Transactions Due", items)

	// Open purchase orders.
	items, err = reminderTxns(ctx, q, names, `SELECT id, type, ref_number, date, name_id, amount FROM txns
		WHERE type = 'PURCHORD' AND voided = 0 AND status <> 'Closed' ORDER BY date, id`)
	if err != nil {
		return err
	}
	add("purchase_orders", "Open Purchase Orders", items)

	// To Do notes due today or earlier.
	items = []model.ReminderItem{}
	todos, err := loadTodos(ctx, q, `WHERE done = 0 AND due_date <> '' AND due_date <= ?`, today)
	if err != nil {
		return err
	}
	for _, t := range todos {
		label := t.Title
		if t.NameID != nil && names[*t.NameID] != "" {
			label += " - " + names[*t.NameID]
		}
		items = append(items, model.ReminderItem{Label: label, Date: t.DueDate})
	}
	add("todos", "To Do Notes", items)

	// Sales tax due: Sales Tax Payable balance by tax item (cash or accrual, per prefs).
	items = []model.ReminderItem{}
	dues, err := ledger.SalesTaxDue(ctx, q, today)
	if err != nil {
		return err
	}
	for _, d := range dues {
		label := d.TaxItemName
		if label == "" {
			label = "Sales Tax Payable"
		}
		if d.AgencyName != "" {
			label += " - " + d.AgencyName
		}
		id := d.TaxItemID
		items = append(items, model.ReminderItem{Label: label, Date: today, Amount: d.AmountDue, ItemID: &id})
	}
	add("sales_tax_due", "Sales Tax Due", items)

	return c.JSON(groups)
}

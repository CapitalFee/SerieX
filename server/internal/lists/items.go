package lists

import (
	"context"
	"database/sql"
	"errors"
	"strings"

	"seriex/internal/apperr"
	"seriex/internal/httpx"
	"seriex/internal/ledger"
	"seriex/internal/model"
	"seriex/internal/store"
)

func registerItemRoutes(rt *httpx.Router) {
	rt.C("GET", "/items", func(c *httpx.Ctx) error {
		mode, err := activeMode(c.Q("active"))
		if err != nil {
			return err
		}
		all, err := Items(c.Context(), c.DB)
		if err != nil {
			return err
		}
		types := splitList(c.Q("types"))
		out := []model.Item{}
		for _, it := range all {
			if !keepActive(mode, it.Active) {
				continue
			}
			if len(types) > 0 && !contains(types, it.Type) {
				continue
			}
			out = append(out, it)
		}
		return c.JSON(out)
	})
	rt.C("GET", "/items/{id}", func(c *httpx.Ctx) error {
		id, err := c.ID("id")
		if err != nil {
			return err
		}
		it, err := GetItem(c.Context(), c.DB, id)
		if err != nil {
			return err
		}
		return c.JSON(it)
	})
	save := func(c *httpx.Ctx, id int64) error {
		var it model.Item
		act, err := decodeRecord(c, &it)
		if err != nil {
			return err
		}
		it.ID = id
		if id != 0 {
			it.OpeningQty, it.OpeningValue = nil, nil
		}
		var saved int64
		err = c.Write(func(tx *sql.Tx) error {
			var err error
			if it.Active, err = resolveActive(c.Context(), tx, "items", id, act); err != nil {
				return err
			}
			saved, err = SaveItem(c.Context(), tx, &it, saveOpts(c))
			return err
		})
		if err != nil {
			return err
		}
		out, err := GetItem(c.Context(), c.DB, saved)
		if err != nil {
			return err
		}
		return c.JSON(out)
	}
	rt.C("POST", "/items", func(c *httpx.Ctx) error { return save(c, 0) })
	rt.C("PUT", "/items/{id}", func(c *httpx.Ctx) error {
		id, err := c.ID("id")
		if err != nil {
			return err
		}
		return save(c, id)
	})
	rt.C("PUT", "/items/{id}/active", func(c *httpx.Ctx) error {
		id, err := c.ID("id")
		if err != nil {
			return err
		}
		var body struct {
			Active bool `json:"active"`
		}
		if err := c.Decode(&body); err != nil {
			return err
		}
		err = c.Write(func(tx *sql.Tx) error {
			if ok, err := exists(c.Context(), tx, `SELECT 1 FROM items WHERE id = ?`, id); err != nil || !ok {
				if err == nil {
					err = apperr.NotFound("Item not found.")
				}
				return err
			}
			if err := setActive(c.Context(), tx, "items", id, body.Active); err != nil {
				return err
			}
			return touch(c.Context(), tx, "items", id)
		})
		if err != nil {
			return err
		}
		out, err := GetItem(c.Context(), c.DB, id)
		if err != nil {
			return err
		}
		return c.JSON(out)
	})
	rt.C("DELETE", "/items/{id}", func(c *httpx.Ctx) error {
		id, err := c.ID("id")
		if err != nil {
			return err
		}
		if err := c.Write(func(tx *sql.Tx) error { return DeleteItem(c.Context(), tx, id) }); err != nil {
			return err
		}
		return c.NoContent()
	})
}

func itemTypeRank(t string) int {
	for i, x := range model.ItemTypeOrder {
		if x == t {
			return i
		}
	}
	return 99
}

// ---------------------------------------------------------------------------
// Reading

const itemCols = `id, type, name, parent_id, mpn, description, purchase_description, is_purchased, sales_price, rate_is_percent, cost,
	income_account_id, expense_account_id, asset_account_id, preferred_vendor_id, taxable, reorder_point, max_qty,
	qty_on_hand, avg_cost, asset_value, tax_rate, tax_agency_id, payment_method_id, deposit_account_id, active, updated_at`

func scanItem(rows *sql.Rows) (model.Item, error) {
	var it model.Item
	var parent, inc, exp, asset, vendor, agency, pm, dep sql.NullInt64
	var reorder, maxQty sql.NullFloat64
	var isPurchased, ratePct, taxable, active int
	var assetValue int64
	err := rows.Scan(&it.ID, &it.Type, &it.Name, &parent, &it.MPN, &it.Description, &it.PurchaseDescription, &isPurchased,
		&it.SalesPrice, &ratePct, &it.Cost, &inc, &exp, &asset, &vendor, &taxable, &reorder, &maxQty,
		&it.QtyOnHand, &it.AvgCost, &assetValue, &it.TaxRate, &agency, &pm, &dep, &active, &it.UpdatedAt)
	if err != nil {
		return it, err
	}
	it.ParentID = store.PtrID(parent)
	it.IsPurchased = isPurchased == 1
	it.RateIsPercent = ratePct == 1
	it.IncomeAccountID = store.PtrID(inc)
	it.ExpenseAccountID = store.PtrID(exp)
	it.AssetAccountID = store.PtrID(asset)
	it.PreferredVendorID = store.PtrID(vendor)
	it.Taxable = taxable == 1
	it.ReorderPoint = ptrF(reorder)
	it.MaxQty = ptrF(maxQty)
	it.AssetValue = store.Dollars(assetValue)
	it.TaxAgencyID = store.PtrID(agency)
	it.PaymentMethodID = store.PtrID(pm)
	it.DepositAccountID = store.PtrID(dep)
	it.Active = active == 1
	it.GroupLines = []model.ItemGroupLine{}
	return it, nil
}

// Items returns every item (active and inactive) in Item List order (by type,
// then name, subitems under their parent) with fullName, level, qtyOnPo,
// group lines (with itemName), the Sales Tax Group rate and hasTxns filled in.
func Items(ctx context.Context, q store.Q) ([]model.Item, error) {
	return loadItems(ctx, q, 0)
}

// GetItem returns one item with its computed fields.
func GetItem(ctx context.Context, q store.Q, id int64) (*model.Item, error) {
	list, err := loadItems(ctx, q, id)
	if err != nil {
		return nil, err
	}
	if len(list) == 0 {
		return nil, apperr.NotFound("Item not found.")
	}
	return &list[0], nil
}

func loadItems(ctx context.Context, q store.Q, only int64) ([]model.Item, error) {
	rows, err := q.QueryContext(ctx, `SELECT `+itemCols+` FROM items`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var list []model.Item
	for rows.Next() {
		it, err := scanItem(rows)
		if err != nil {
			return nil, err
		}
		list = append(list, it)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()

	names := map[int64]string{}
	parents := map[int64]int64{}
	rates := map[int64]float64{}
	for _, it := range list {
		names[it.ID] = it.Name
		if it.ParentID != nil {
			parents[it.ID] = *it.ParentID
		}
		rates[it.ID] = it.TaxRate
	}
	full := fullNames(names, parents)

	// group members
	groups := map[int64][]model.ItemGroupLine{}
	grows, err := q.QueryContext(ctx, `SELECT group_id, item_id, qty FROM item_group_lines ORDER BY group_id, seq, id`)
	if err != nil {
		return nil, err
	}
	defer grows.Close()
	for grows.Next() {
		var g model.ItemGroupLine
		var gid int64
		if err := grows.Scan(&gid, &g.ItemID, &g.Qty); err != nil {
			return nil, err
		}
		g.ItemName = full[g.ItemID]
		groups[gid] = append(groups[gid], g)
	}
	if err := grows.Err(); err != nil {
		return nil, err
	}
	grows.Close()

	used, err := idSet(ctx, q, `SELECT item_id FROM txn_lines WHERE item_id IS NOT NULL
		UNION SELECT DISTINCT item_id FROM gl_entries WHERE item_id IS NOT NULL
		UNION SELECT item_id FROM inventory_moves
		UNION SELECT tax_item_id FROM txns WHERE tax_item_id IS NOT NULL`)
	if err != nil {
		return nil, err
	}
	onPO, err := qtyOnPO(ctx, q)
	if err != nil {
		return nil, err
	}

	for i := range list {
		it := &list[i]
		it.FullName = full[it.ID]
		it.HasTxns = used[it.ID]
		it.QtyOnPO = onPO[it.ID]
		if g, ok := groups[it.ID]; ok {
			it.GroupLines = g
		}
		if it.Type == model.ItemSalesTaxGroup {
			var sum float64
			for _, g := range it.GroupLines {
				sum += rates[g.ItemID]
			}
			it.TaxRate = roundRate(sum)
		}
	}

	order, level := treeSort(len(list),
		func(i int) int64 { return list[i].ID },
		func(i int) int64 {
			if list[i].ParentID == nil {
				return 0
			}
			return *list[i].ParentID
		},
		func(x, y int) bool {
			a, b := list[x], list[y]
			if ra, rb := itemTypeRank(a.Type), itemTypeRank(b.Type); ra != rb {
				return ra < rb
			}
			return lessFold(a.Name, b.Name)
		})
	out := make([]model.Item, 0, len(list))
	for _, i := range order {
		it := list[i]
		it.Level = level[i]
		if only != 0 && it.ID != only {
			continue
		}
		out = append(out, it)
	}
	return out, nil
}

// roundRate keeps percentages to 4 decimals (avoids 7.249999999).
func roundRate(f float64) float64 {
	return float64(int64(f*10000+sign(f)*0.5)) / 10000
}

func sign(f float64) float64 {
	if f < 0 {
		return -1
	}
	return 1
}

// qtyOnPO sums the quantity still to receive on open purchase orders.
func qtyOnPO(ctx context.Context, q store.Q) (map[int64]float64, error) {
	rows, err := q.QueryContext(ctx, `SELECT l.item_id, SUM(MAX(IFNULL(l.qty, 0) - l.received_qty, 0))
		FROM txn_lines l JOIN txns t ON t.id = l.txn_id
		WHERE t.type = ? AND t.status <> 'Closed' AND t.voided = 0 AND l.closed = 0 AND l.item_id IS NOT NULL
		GROUP BY l.item_id`, model.TxPurchaseOrder)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64]float64{}
	for rows.Next() {
		var id int64
		var qty sql.NullFloat64
		if err := rows.Scan(&id, &qty); err != nil {
			return nil, err
		}
		out[id] = qty.Float64
	}
	return out, rows.Err()
}

// ---------------------------------------------------------------------------
// Writing

func validItemType(t string) bool { return itemTypeRank(t) < 99 }

// itemUsed reports whether an item appears on any transaction.
func itemUsed(ctx context.Context, q store.Q, id int64) (bool, error) {
	return exists(ctx, q, `SELECT 1 FROM txn_lines WHERE item_id = ?1
		UNION SELECT 1 FROM gl_entries WHERE item_id = ?1
		UNION SELECT 1 FROM inventory_moves WHERE item_id = ?1
		UNION SELECT 1 FROM txns WHERE tax_item_id = ?1 LIMIT 1`, id)
}

// SaveItem validates and stores an item (it.ID == 0 creates it). On create,
// an inventory part with a non-zero OpeningQty gets an inventory adjustment
// (value adjustment against Opening Balance Equity) via ledger.Save.
// Returns the item id.
func SaveItem(ctx context.Context, tx *sql.Tx, it *model.Item, opt ledger.SaveOptions) (int64, error) {
	name, err := cleanName(it.Name, "item")
	if err != nil {
		return 0, err
	}
	it.Name = name
	it.Type = strings.TrimSpace(it.Type)
	it.ParentID = normID(it.ParentID)
	for _, p := range []**int64{&it.IncomeAccountID, &it.ExpenseAccountID, &it.AssetAccountID, &it.PreferredVendorID,
		&it.TaxAgencyID, &it.PaymentMethodID, &it.DepositAccountID} {
		*p = normID(*p)
	}

	var oldType string
	var oldActive bool
	if it.ID != 0 {
		if err := store.CheckStale(ctx, tx, "items", it.ID, it.UpdatedAt, "item"); err != nil {
			return 0, err
		}
		var act int
		err := tx.QueryRowContext(ctx, `SELECT type, active FROM items WHERE id = ?`, it.ID).Scan(&oldType, &act)
		if errors.Is(err, sql.ErrNoRows) {
			return 0, apperr.NotFound("Item not found.")
		}
		if err != nil {
			return 0, err
		}
		oldActive = act == 1
		if it.Type == "" {
			it.Type = oldType
		}
	}
	if !validItemType(it.Type) {
		return 0, apperr.Validation("type", "Choose a valid item type.")
	}
	if it.ParentID != nil {
		pt, err := checkParent(ctx, tx, "items", it.ID, *it.ParentID, "type")
		if err != nil {
			return 0, err
		}
		if pt != it.Type {
			return 0, apperr.Validation("parentId", "A subitem must be the same type as its parent item (%s).", pt)
		}
	}
	if oldType != "" && oldType != it.Type {
		used, err := itemUsed(ctx, tx, it.ID)
		if err != nil {
			return 0, err
		}
		if used {
			return 0, apperr.Conflict("You cannot change the type of an item that has been used in transactions.")
		}
		if kids, err := exists(ctx, tx, `SELECT 1 FROM items WHERE parent_id = ? LIMIT 1`, it.ID); err != nil {
			return 0, err
		} else if kids {
			return 0, apperr.Conflict("You cannot change the type of an item that has subitems.")
		}
		if inGroup, err := exists(ctx, tx, `SELECT 1 FROM item_group_lines WHERE item_id = ? LIMIT 1`, it.ID); err != nil {
			return 0, err
		} else if inGroup && (it.Type == model.ItemGroup || it.Type == model.ItemSalesTaxGroup || oldType == model.ItemSalesTax) {
			return 0, apperr.Conflict("This item is a member of a group, so its type cannot be changed this way.")
		}
	}
	if dup, err := siblingExists(ctx, tx, "items", it.ParentID, it.Name, it.ID, ""); err != nil {
		return 0, err
	} else if dup {
		return 0, nameInUse(it.Name)
	}
	if err := normalizeItem(ctx, tx, it); err != nil {
		return 0, err
	}

	now := store.Now()
	var cv cols
	for _, kv := range []struct {
		col string
		v   any
	}{
		{"type", it.Type}, {"name", it.Name}, {"parent_id", store.NullID(it.ParentID)}, {"mpn", strings.TrimSpace(it.MPN)},
		{"description", it.Description}, {"purchase_description", it.PurchaseDescription}, {"is_purchased", store.B(it.IsPurchased)},
		{"sales_price", it.SalesPrice}, {"rate_is_percent", store.B(it.RateIsPercent)}, {"cost", it.Cost},
		{"income_account_id", store.NullID(it.IncomeAccountID)}, {"expense_account_id", store.NullID(it.ExpenseAccountID)},
		{"asset_account_id", store.NullID(it.AssetAccountID)}, {"preferred_vendor_id", store.NullID(it.PreferredVendorID)},
		{"taxable", store.B(it.Taxable)}, {"reorder_point", nullF(it.ReorderPoint)}, {"max_qty", nullF(it.MaxQty)},
		{"tax_rate", it.TaxRate}, {"tax_agency_id", store.NullID(it.TaxAgencyID)},
		{"payment_method_id", store.NullID(it.PaymentMethodID)}, {"deposit_account_id", store.NullID(it.DepositAccountID)},
		{"updated_at", store.Stamp()},
	} {
		cv.add(kv.col, kv.v)
	}
	id := it.ID
	if id == 0 {
		cv.add("active", store.B(it.Active))
		cv.add("created_at", now)
		if id, err = cv.insert(ctx, tx, "items"); err != nil {
			return 0, mapDBError(err, it.Name)
		}
	} else if err := cv.update(ctx, tx, "items", id); err != nil {
		return 0, mapDBError(err, it.Name)
	}

	// group members
	if _, err := tx.ExecContext(ctx, `DELETE FROM item_group_lines WHERE group_id = ?`, id); err != nil {
		return 0, err
	}
	for i, g := range it.GroupLines {
		if g.ItemID == id {
			return 0, apperr.Validation("groupLines", "A group cannot contain itself.")
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO item_group_lines(group_id, item_id, qty, seq) VALUES(?,?,?,?)`, id, g.ItemID, g.Qty, i); err != nil {
			return 0, err
		}
	}

	if it.ID == 0 || oldActive != it.Active {
		if err := setActive(ctx, tx, "items", id, it.Active); err != nil {
			return 0, err
		}
	}
	// same rule as the ledger's re-costing: without stock the average cost is the item cost
	if _, err := tx.ExecContext(ctx, `UPDATE items SET avg_cost = cost WHERE id = ? AND type = ? AND qty_on_hand <= 0`,
		id, model.ItemInventoryPart); err != nil {
		return 0, err
	}

	if it.ID == 0 && it.Type == model.ItemInventoryPart && it.OpeningQty != nil && *it.OpeningQty != 0 {
		if err := itemOpeningBalance(ctx, tx, id, it, opt); err != nil {
			return 0, err
		}
	}
	return id, nil
}

// normalizeItem applies the per-type rules: required accounts (with special
// account defaults), group members, sales tax data; fields that do not apply
// to the type are cleared.
func normalizeItem(ctx context.Context, tx *sql.Tx, it *model.Item) error {
	accountType := func(id *int64, field string) (string, error) { return checkAccountRef(ctx, tx, id, field) }
	requireIncome := func(msg string) error {
		if it.IncomeAccountID == nil {
			return apperr.Validation("incomeAccountId", "%s", msg)
		}
		_, err := accountType(it.IncomeAccountID, "incomeAccountId")
		return err
	}
	if it.PreferredVendorID != nil {
		var k string
		if err := tx.QueryRowContext(ctx, `SELECT kind FROM names WHERE id = ?`, *it.PreferredVendorID).Scan(&k); err != nil || k != model.NameVendor {
			return apperr.Validation("preferredVendorId", "The preferred vendor must be a vendor.")
		}
	}
	if err := store.MoneyErr("salesPrice", "The price", it.SalesPrice); err != nil {
		return err
	}
	if err := store.MoneyErr("cost", "The cost", it.Cost); err != nil {
		return err
	}
	if it.OpeningQty != nil {
		if err := store.QtyErr("openingQty", "The quantity on hand", *it.OpeningQty); err != nil {
			return err
		}
		if err := store.MoneyErr("openingQty", "The value of the quantity on hand", *it.OpeningQty*it.Cost); err != nil {
			return err
		}
	}
	if it.OpeningValue != nil {
		if err := store.MoneyErr("openingValue", "The total value", *it.OpeningValue); err != nil {
			return err
		}
	}
	for _, f := range []struct {
		v     *float64
		field string
	}{{it.ReorderPoint, "reorderPoint"}, {it.MaxQty, "maxQty"}} {
		if f.v != nil {
			if err := store.QtyErr(f.field, "The quantity", *f.v); err != nil {
				return err
			}
		}
	}
	if it.Cost < 0 {
		return apperr.Validation("cost", "The cost cannot be negative.")
	}
	clearInventory := func() {
		it.AssetAccountID = nil
		it.ReorderPoint = nil
		it.MaxQty = nil
	}
	clearTax := func() { it.TaxRate = 0; it.TaxAgencyID = nil }
	clearPayment := func() { it.PaymentMethodID = nil; it.DepositAccountID = nil }
	keepGroup := false

	switch it.Type {
	case model.ItemService, model.ItemNonInventory, model.ItemOtherCharge:
		if err := requireIncome("You must choose an income account for this item."); err != nil {
			return err
		}
		if it.IsPurchased {
			if it.ExpenseAccountID == nil {
				return apperr.Validation("expenseAccountId", "You must choose an expense account for the purchase information of this item.")
			}
			if _, err := accountType(it.ExpenseAccountID, "expenseAccountId"); err != nil {
				return err
			}
		} else {
			// one account is used for both sales and purchases
			it.ExpenseAccountID = it.IncomeAccountID
			it.Cost = 0
			it.PurchaseDescription = ""
			it.PreferredVendorID = nil
		}
		if it.Type != model.ItemOtherCharge {
			it.RateIsPercent = false
		}
		clearInventory()
		clearTax()
		clearPayment()
	case model.ItemInventoryPart:
		if err := requireIncome("You must choose an income account for this inventory part."); err != nil {
			return err
		}
		var err error
		if it.ExpenseAccountID == nil {
			v, err := store.SpecialAccount(ctx, tx, store.SpecialCOGS)
			if err != nil {
				return err
			}
			it.ExpenseAccountID = &v
		} else if _, err = accountType(it.ExpenseAccountID, "expenseAccountId"); err != nil {
			return err
		}
		if it.AssetAccountID == nil {
			v, err := store.SpecialAccount(ctx, tx, store.SpecialInventoryAsset)
			if err != nil {
				return err
			}
			it.AssetAccountID = &v
		} else {
			t, err := accountType(it.AssetAccountID, "assetAccountId")
			if err != nil {
				return err
			}
			if t != model.AcctOCA {
				return apperr.Validation("assetAccountId", "The inventory asset account must be an Other Current Asset account.")
			}
		}
		if it.ReorderPoint != nil && *it.ReorderPoint < 0 {
			return apperr.Validation("reorderPoint", "The reorder point cannot be negative.")
		}
		it.IsPurchased = true
		it.RateIsPercent = false
		clearTax()
		clearPayment()
	case model.ItemDiscount:
		if err := requireIncome("You must choose the account used to track this discount."); err != nil {
			return err
		}
		it.ExpenseAccountID, it.PreferredVendorID, it.IsPurchased, it.Cost, it.PurchaseDescription = nil, nil, false, 0, ""
		clearInventory()
		clearTax()
		clearPayment()
	case model.ItemPayment:
		if it.DepositAccountID != nil {
			if _, err := accountType(it.DepositAccountID, "depositAccountId"); err != nil {
				return err
			}
		}
		if err := checkListRef(ctx, tx, normID(it.PaymentMethodID), "paymentMethodId", model.ListPaymentMethod); err != nil {
			return err
		}
		it.IncomeAccountID, it.ExpenseAccountID, it.PreferredVendorID = nil, nil, nil
		it.IsPurchased, it.Cost, it.SalesPrice, it.RateIsPercent, it.Taxable, it.PurchaseDescription = false, 0, 0, false, false, ""
		clearInventory()
		clearTax()
	case model.ItemSubtotal:
		it.IncomeAccountID, it.ExpenseAccountID, it.PreferredVendorID = nil, nil, nil
		it.IsPurchased, it.Cost, it.SalesPrice, it.RateIsPercent, it.Taxable, it.PurchaseDescription = false, 0, 0, false, false, ""
		clearInventory()
		clearTax()
		clearPayment()
	case model.ItemSalesTax:
		if it.TaxAgencyID == nil {
			return apperr.Validation("taxAgencyId", "You must choose the tax agency (a vendor) this sales tax is paid to.")
		}
		var k string
		if err := tx.QueryRowContext(ctx, `SELECT kind FROM names WHERE id = ?`, *it.TaxAgencyID).Scan(&k); err != nil || k != model.NameVendor {
			return apperr.Validation("taxAgencyId", "The tax agency must be a vendor.")
		}
		if it.TaxRate < 0 || it.TaxRate > 100 {
			return apperr.Validation("taxRate", "The tax rate must be between 0 and 100 percent.")
		}
		it.TaxRate = roundRate(it.TaxRate)
		it.IncomeAccountID, it.ExpenseAccountID, it.PreferredVendorID = nil, nil, nil
		it.IsPurchased, it.Cost, it.SalesPrice, it.RateIsPercent, it.Taxable, it.PurchaseDescription = false, 0, 0, false, false, ""
		clearInventory()
		clearPayment()
	case model.ItemSalesTaxGroup, model.ItemGroup:
		keepGroup = true
		if len(it.GroupLines) == 0 {
			return apperr.Validation("groupLines", "A group must contain at least one item.")
		}
		seen := map[int64]bool{}
		for i := range it.GroupLines {
			g := &it.GroupLines[i]
			var mt string
			err := tx.QueryRowContext(ctx, `SELECT type FROM items WHERE id = ?`, g.ItemID).Scan(&mt)
			if errors.Is(err, sql.ErrNoRows) {
				return apperr.Validation("groupLines", "A group member does not exist.")
			}
			if err != nil {
				return err
			}
			if it.Type == model.ItemSalesTaxGroup {
				if mt != model.ItemSalesTax {
					return apperr.Validation("groupLines", "A sales tax group can only contain sales tax items.")
				}
				if seen[g.ItemID] {
					return apperr.Validation("groupLines", "A sales tax item can be in a sales tax group only once.")
				}
				g.Qty = 1
			} else {
				if mt == model.ItemGroup || mt == model.ItemSalesTaxGroup {
					return apperr.Validation("groupLines", "A group cannot contain another group.")
				}
				if g.Qty < 0 {
					return apperr.Validation("groupLines", "Group quantities cannot be negative.")
				}
			}
			seen[g.ItemID] = true
		}
		it.IncomeAccountID, it.ExpenseAccountID, it.PreferredVendorID = nil, nil, nil
		it.IsPurchased, it.Cost, it.SalesPrice, it.RateIsPercent, it.PurchaseDescription = false, 0, 0, false, ""
		if it.Type == model.ItemSalesTaxGroup {
			it.Taxable = false
		}
		it.TaxRate = 0 // a group's rate is computed from its members
		it.TaxAgencyID = nil
		clearInventory()
		clearPayment()
	}
	if !keepGroup {
		it.GroupLines = nil
	}
	if it.RateIsPercent && (it.SalesPrice < -100 || it.SalesPrice > 100) {
		return apperr.Validation("salesPrice", "A percentage rate must be between -100 and 100.")
	}
	return nil
}

// itemOpeningBalance records the opening quantity and value of a new
// inventory part as an inventory value adjustment against Opening Balance Equity.
func itemOpeningBalance(ctx context.Context, tx *sql.Tx, id int64, it *model.Item, opt ledger.SaveOptions) error {
	date := strings.TrimSpace(it.OpeningDate)
	if date == "" {
		date = store.Today()
	}
	if !store.ValidDate(date) {
		return apperr.Validation("openingDate", "Enter a valid \"as of\" date for the quantity on hand.")
	}
	qty := *it.OpeningQty
	if qty < 0 {
		return apperr.Validation("openingQty", "The opening quantity on hand cannot be negative.")
	}
	value := store.Round2(qty * it.Cost)
	if it.OpeningValue != nil {
		value = store.Round2(*it.OpeningValue)
	}
	if value < 0 {
		return apperr.Validation("openingValue", "The opening value cannot be negative.")
	}
	obe, err := store.SpecialAccount(ctx, tx, store.SpecialOpeningBalanceEquity)
	if err != nil {
		return err
	}
	itemID := id
	t := model.Txn{
		Type:      model.TxInventoryAdjust,
		Date:      date,
		AccountID: &obe,
		Memo:      "Opening balance",
		Extra:     map[string]any{"valueAdjustment": true, "openingBalance": true},
		Lines:     []model.TxnLine{{Kind: model.LineItem, ItemID: &itemID, Qty: &qty, Amount: value, Description: "Opening balance"}},
	}
	_, err = ledger.Save(ctx, tx, &t, opt)
	return err
}

// DeleteItem removes an item that has no transactions, no subitems and is not
// used by groups, customers or preferences.
func DeleteItem(ctx context.Context, tx *sql.Tx, id int64) error {
	var name string
	err := tx.QueryRowContext(ctx, `SELECT name FROM items WHERE id = ?`, id).Scan(&name)
	if errors.Is(err, sql.ErrNoRows) {
		return apperr.NotFound("Item not found.")
	}
	if err != nil {
		return err
	}
	if kids, err := exists(ctx, tx, `SELECT 1 FROM items WHERE parent_id = ? LIMIT 1`, id); err != nil {
		return err
	} else if kids {
		return apperr.Conflict("This item has transactions or subitems and cannot be deleted. Make it inactive instead.")
	}
	if used, err := itemUsed(ctx, tx, id); err != nil {
		return err
	} else if used {
		return apperr.Conflict("This item has transactions or subitems and cannot be deleted. Make it inactive instead.")
	}
	if inGroup, err := exists(ctx, tx, `SELECT 1 FROM item_group_lines WHERE item_id = ? LIMIT 1`, id); err != nil {
		return err
	} else if inGroup {
		return apperr.Conflict("This item is used in a group. Remove it from the group or make it inactive instead.")
	}
	if inNames, err := exists(ctx, tx, `SELECT 1 FROM names WHERE tax_item_id = ? LIMIT 1`, id); err != nil {
		return err
	} else if inNames {
		return apperr.Conflict("This sales tax item is assigned to one or more customers. Make it inactive instead.")
	}
	p, err := store.LoadPrefs(ctx, tx)
	if err != nil {
		return err
	}
	if p.DefaultSalesTaxItemID != nil && *p.DefaultSalesTaxItemID == id {
		return apperr.Conflict("This is the most common sales tax item in Preferences. Choose another one there first, or make this item inactive.")
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM items WHERE id = ?`, id); err != nil {
		return mapDBError(err, name)
	}
	return nil
}

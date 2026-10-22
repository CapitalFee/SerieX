package ledger

import (
	"context"
	"database/sql"
	"errors"
	"strconv"
	"strings"

	"seriex/internal/apperr"
	"seriex/internal/model"
	"seriex/internal/store"
)

// qrySummaryFrom is the FROM part shared by every TxnSummary query: the
// recursive CTEs give full names of names and accounts.
const qrySummaryFrom = `WITH RECURSIVE
  qnf(id, full) AS (
    SELECT id, name FROM names WHERE parent_id IS NULL
    UNION ALL
    SELECT c.id, qnf.full || ':' || c.name FROM names c JOIN qnf ON c.parent_id = qnf.id),
  qaf(id, full) AS (
    SELECT id, name FROM accounts WHERE parent_id IS NULL
    UNION ALL
    SELECT c.id, qaf.full || ':' || c.name FROM accounts c JOIN qaf ON c.parent_id = qaf.id)
SELECT %s
FROM txns t
LEFT JOIN qnf ON qnf.id = t.name_id
LEFT JOIN qaf ON qaf.id = t.account_id
LEFT JOIN accounts a ON a.id = t.account_id
`

const qrySummaryCols = `t.id, t.type, t.ref_number, t.date, t.due_date, t.name_id, IFNULL(qnf.full, ''),
  t.account_id, IFNULL(qaf.full, ''), IFNULL(a.number, ''), IFNULL(a.type, ''),
  t.amount, t.open_balance, t.memo, t.status, t.voided, t.is_pending, t.to_be_printed`

// qryStatusExpr is the displayed status: pending INV/SALESRCPT "Pending",
// INV/BILL "Paid"/"Open", others the stored status.
const qryStatusExpr = `(CASE WHEN t.type IN ('INV','SALESRCPT') AND t.is_pending = 1 THEN 'Pending'
  WHEN t.type IN ('INV','BILL') THEN
  (CASE WHEN t.open_balance = 0 AND t.amount > 0 THEN 'Paid' ELSE 'Open' END) ELSE t.status END)`

// qryOpenExpr: transactions that are still open (unpaid charges, unused
// credits, open estimates and purchase orders).
const qryOpenExpr = `(t.voided = 0 AND (
  (t.type IN ('INV','STMTCHG','BILL','ITEMRCPT','CREDMEM','BILLCRED','PMT','BILLPMT','GENJRNL') AND t.open_balance <> 0)
  OR (t.type = 'EST' AND t.status IN ('', 'Pending', 'Accepted'))
  OR (t.type = 'PURCHORD' AND t.status IN ('', 'Open'))))`

// qrySummaryQuery runs a TxnSummary query with the given WHERE/ORDER/LIMIT tail.
func qrySummaryQuery(ctx context.Context, q store.Q, tail string, args ...any) ([]model.TxnSummary, error) {
	useNumbers := false
	if p, err := store.LoadPrefs(ctx, q); err == nil {
		useNumbers = p.UseAccountNumbers
	}
	rows, err := q.QueryContext(ctx, strings.Replace(qrySummaryFrom, "%s", qrySummaryCols, 1)+tail, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.TxnSummary{}
	for rows.Next() {
		var s model.TxnSummary
		var nameID, acctID sql.NullInt64
		var acctNumber, acctType string
		var amount, open int64
		var voided, pending, toPrint int
		if err := rows.Scan(&s.ID, &s.Type, &s.RefNumber, &s.Date, &s.DueDate, &nameID, &s.NameFull,
			&acctID, &s.AccountName, &acctNumber, &acctType, &amount, &open, &s.Memo, &s.Status,
			&voided, &pending, &toPrint); err != nil {
			return nil, err
		}
		s.NameID = store.PtrID(nameID)
		s.AccountID = store.PtrID(acctID)
		s.AccountName = qryAcctLabel(useNumbers, acctNumber, s.AccountName)
		s.TypeLabel = qryTypeLabel(s.Type, acctType)
		s.Amount = store.Dollars(amount)
		s.OpenBalance = store.Dollars(open)
		s.Voided = voided != 0
		s.IsPending = pending != 0
		s.ToBePrinted = toPrint != 0
		if s.IsPending && (s.Type == model.TxInvoice || s.Type == model.TxSalesReceipt) {
			s.Status = "Pending"
		} else if s.Type == model.TxInvoice || s.Type == model.TxBill {
			if open == 0 && amount > 0 {
				s.Status = "Paid"
			} else {
				s.Status = "Open"
			}
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// qrySummariesByID returns the summaries of the given transactions in the given order.
func qrySummariesByID(ctx context.Context, q store.Q, ids []int64) ([]model.TxnSummary, error) {
	out := []model.TxnSummary{}
	for start := 0; start < len(ids); start += 500 {
		end := min(start+500, len(ids))
		in, args := qryIn(ids[start:end])
		part, err := qrySummaryQuery(ctx, q, "WHERE t.id IN "+in, args...)
		if err != nil {
			return nil, err
		}
		out = append(out, part...)
	}
	pos := map[int64]int{}
	for i, id := range ids {
		if _, ok := pos[id]; !ok {
			pos[id] = i
		}
	}
	sorted := make([]model.TxnSummary, 0, len(out))
	byID := map[int64]model.TxnSummary{}
	for _, s := range out {
		byID[s.ID] = s
	}
	seen := map[int64]bool{}
	for _, id := range ids {
		if s, ok := byID[id]; ok && !seen[id] {
			sorted = append(sorted, s)
			seen[id] = true
		}
	}
	return sorted, nil
}

// qryTxnFilter holds the parameters of GET /txns.
type qryTxnFilter struct {
	Types      []string
	NameIDs    []int64 // nil = any name
	AccountIDs []int64 // nil = any account
	ItemID     int64
	From, To   string
	Text       string // q: ref, memo, name, line descriptions (and the amount when numeric)
	Ref        string
	Memo       string
	AmountMin  *int64
	AmountMax  *int64
	OpenOnly   bool
	Status     string
	Sort       string
	Limit      int
	Offset     int
}

// qryTxnWhere builds the WHERE clause of a /txns query.
func qryTxnWhere(f qryTxnFilter) (string, []any) {
	var conds []string
	var args []any
	add := func(c string, a ...any) {
		conds = append(conds, c)
		args = append(args, a...)
	}
	if len(f.Types) > 0 {
		in, a := qryInStr(f.Types)
		add("t.type IN "+in, a...)
	}
	if f.NameIDs != nil {
		in, a := qryIn(f.NameIDs)
		add(`(t.name_id IN `+in+` OR (t.type = 'GENJRNL' AND EXISTS (SELECT 1 FROM txn_lines l WHERE l.txn_id = t.id AND l.name_id IN `+in+`)))`,
			append(append([]any{}, a...), a...)...)
	}
	if f.AccountIDs != nil {
		in, a := qryIn(f.AccountIDs)
		var all []any
		for i := 0; i < 5; i++ {
			all = append(all, a...)
		}
		add(`(t.account_id IN `+in+` OR t.ar_ap_account_id IN `+in+` OR t.to_account_id IN `+in+`
			OR EXISTS (SELECT 1 FROM gl_entries g WHERE g.txn_id = t.id AND g.account_id IN `+in+`)
			OR EXISTS (SELECT 1 FROM txn_lines l WHERE l.txn_id = t.id AND l.account_id IN `+in+`))`, all...)
	}
	if f.ItemID > 0 {
		add(`(t.tax_item_id = ? OR EXISTS (SELECT 1 FROM txn_lines l WHERE l.txn_id = t.id AND l.item_id = ?))`, f.ItemID, f.ItemID)
	}
	if f.From != "" {
		add("t.date >= ?", f.From)
	}
	if f.To != "" {
		add("t.date <= ?", f.To)
	}
	if f.Text != "" {
		p := qryLike(f.Text)
		c := `(t.ref_number LIKE ? ESCAPE '\' OR t.memo LIKE ? ESCAPE '\' OR IFNULL(qnf.full, '') LIKE ? ESCAPE '\'
			OR t.po_number LIKE ? ESCAPE '\'
			OR EXISTS (SELECT 1 FROM txn_lines l WHERE l.txn_id = t.id AND l.description LIKE ? ESCAPE '\')`
		a := []any{p, p, p, p, p}
		if cents, ok := qryParseMoney(f.Text); ok && cents != 0 {
			c += ` OR ABS(t.amount) = ?`
			a = append(a, cents)
		}
		add(c+")", a...)
	}
	if f.Ref != "" {
		add("t.ref_number = ? COLLATE NOCASE", f.Ref)
	}
	if f.Memo != "" {
		add(`t.memo LIKE ? ESCAPE '\'`, qryLike(f.Memo))
	}
	if f.AmountMin != nil {
		add("ABS(t.amount) >= ?", *f.AmountMin)
	}
	if f.AmountMax != nil {
		add("ABS(t.amount) <= ?", *f.AmountMax)
	}
	if f.OpenOnly {
		add(qryOpenExpr)
	}
	switch strings.ToLower(f.Status) {
	case "":
	case "voided", "void":
		add("t.voided = 1")
	case "pending":
		add("(t.is_pending = 1 OR (t.type = 'EST' AND t.status = 'Pending'))")
	default:
		add("t.voided = 0 AND "+qryStatusExpr+" = ? COLLATE NOCASE", f.Status)
	}
	if len(conds) == 0 {
		return "", nil
	}
	return "WHERE " + strings.Join(conds, " AND ") + "\n", args
}

// qryTxnOrder maps the sort parameter to an ORDER BY clause.
func qryTxnOrder(sort string) string {
	desc := strings.HasPrefix(sort, "-")
	key := strings.TrimPrefix(sort, "-")
	dir := ""
	if desc {
		dir = " DESC"
	}
	switch key {
	case "ref", "num", "number":
		return "ORDER BY (t.ref_number <> '')" + dir + ", (t.ref_number GLOB '*[^0-9]*')" + dir +
			", CAST(t.ref_number AS INTEGER)" + dir + ", t.ref_number COLLATE NOCASE" + dir + ", t.date" + dir + ", t.id" + dir
	case "name":
		return "ORDER BY IFNULL(qnf.full, '') COLLATE NOCASE" + dir + ", t.date" + dir + ", t.id" + dir
	case "amount":
		return "ORDER BY t.amount" + dir + ", t.date" + dir + ", t.id" + dir
	case "type":
		return "ORDER BY t.type" + dir + ", t.date" + dir + ", t.id" + dir
	case "due", "dueDate":
		return "ORDER BY (CASE WHEN t.due_date = '' THEN t.date ELSE t.due_date END)" + dir + ", t.date" + dir + ", t.id" + dir
	case "open", "openBalance":
		return "ORDER BY t.open_balance" + dir + ", t.date" + dir + ", t.id" + dir
	}
	return "ORDER BY t.date" + dir + ", t.id" + dir
}

// qryListTxns runs GET /txns.
func qryListTxns(ctx context.Context, q store.Q, f qryTxnFilter) (*model.TxnListResult, error) {
	where, args := qryTxnWhere(f)
	var total int
	countSQL := strings.Replace(qrySummaryFrom, "%s", "COUNT(*)", 1) + where
	if err := q.QueryRowContext(ctx, countSQL, args...).Scan(&total); err != nil {
		return nil, err
	}
	limit := f.Limit
	if limit <= 0 {
		limit = 200
	}
	if limit > 10000 {
		limit = 10000
	}
	offset := max(f.Offset, 0)
	tail := where + qryTxnOrder(f.Sort) + " LIMIT ? OFFSET ?"
	rows, err := qrySummaryQuery(ctx, q, tail, append(args, limit, offset)...)
	if err != nil {
		return nil, err
	}
	return &model.TxnListResult{Rows: rows, Total: total}, nil
}

// qryParseMoney parses "1,234.56" / "$12" into cents.
func qryParseMoney(s string) (int64, bool) {
	s = strings.TrimSpace(strings.NewReplacer(",", "", "$", "").Replace(s))
	if s == "" {
		return 0, false
	}
	dot := false
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == '.' && !dot {
			dot = true
			continue
		}
		if c == '-' && i == 0 {
			continue
		}
		if c < '0' || c > '9' {
			return 0, false
		}
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0, false
	}
	c := store.Cents(f)
	if c < 0 {
		c = -c
	}
	return c, true
}

// qryAdjacent returns the previous/next transaction of the same type ordered by (date, id).
func qryAdjacent(ctx context.Context, q store.Q, id int64, dir string) (*int64, error) {
	var typ, date string
	if err := q.QueryRowContext(ctx, `SELECT type, date FROM txns WHERE id = ?`, id).Scan(&typ, &date); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, apperr.NotFound("Transaction not found.")
		}
		return nil, err
	}
	var sqlText string
	switch dir {
	case "prev", "previous", "":
		sqlText = `SELECT id FROM txns WHERE type = ? AND (date < ? OR (date = ? AND id < ?)) ORDER BY date DESC, id DESC LIMIT 1`
	case "next":
		sqlText = `SELECT id FROM txns WHERE type = ? AND (date > ? OR (date = ? AND id > ?)) ORDER BY date, id LIMIT 1`
	default:
		return nil, apperr.BadRequest("dir must be prev or next")
	}
	var other int64
	err := q.QueryRowContext(ctx, sqlText, typ, date, date, id).Scan(&other)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &other, nil
}

// qryLast returns the most recent transaction of a type (largest date, then id).
func qryLast(ctx context.Context, q store.Q, typ string) (*int64, error) {
	var id int64
	err := q.QueryRowContext(ctx, `SELECT id FROM txns WHERE type = ? ORDER BY date DESC, id DESC LIMIT 1`, typ).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &id, nil
}

// qryCheckTypes are the transactions that use check numbers of a bank account.
var qryCheckTypes = []string{model.TxCheck, model.TxBillPayment, model.TxRefund, model.TxSalesTaxPayment}

// qryNextRef returns the reference number the server assigns to a new
// transaction of the type ("" when the type is never numbered automatically).
// For checks (CHK/BILLPMT/REFUND/TAXPMT) it is the next check number of the
// bank account: largest numeric number used in that account + 1.
func qryNextRef(ctx context.Context, q store.Q, typ string, accountID int64) (string, error) {
	switch typ {
	case model.TxInvoice, model.TxSalesReceipt, model.TxCreditMemo, model.TxEstimate, model.TxPurchaseOrder, model.TxJournal:
		// same sequence the ledger uses when saving with a blank number
		return AutoRefNumber(ctx, q, typ)
	case model.TxCheck, model.TxBillPayment, model.TxRefund, model.TxSalesTaxPayment:
		if accountID <= 0 {
			return "", nil
		}
		var acctType string
		if err := q.QueryRowContext(ctx, `SELECT type FROM accounts WHERE id = ?`, accountID).Scan(&acctType); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return "", apperr.NotFound("Account not found.")
			}
			return "", err
		}
		if acctType != model.AcctBank {
			return "", nil
		}
		in, args := qryInStr(qryCheckTypes)
		return qryMaxNumericRef(ctx, q, `account_id = ? AND type IN `+in, append([]any{accountID}, args...)...)
	}
	return "", nil
}

// qryMaxNumericRef returns (largest all-digit ref_number matching cond) + 1, or "1".
// Used for check numbers of a bank account.
func qryMaxNumericRef(ctx context.Context, q store.Q, cond string, args ...any) (string, error) {
	rows, err := q.QueryContext(ctx, `SELECT ref_number FROM txns WHERE `+cond+`
		AND ref_number <> '' AND ref_number NOT GLOB '*[^0-9]*'`, args...)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	best := ""
	for rows.Next() {
		var r string
		if err := rows.Scan(&r); err != nil {
			return "", err
		}
		if qryRefCompare(r, best) > 0 {
			best = r
		}
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	if best == "" {
		return "1", nil
	}
	return qryIncRef(strings.TrimLeft(best, "0")), nil
}

package store

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"

	"seriex/internal/apperr"
)

// Prefs are the company preferences (Edit > Preferences), stored as JSON in company.prefs.
type Prefs struct {
	// Accounting
	UseAccountNumbers        bool `json:"useAccountNumbers"`
	ShowLowestSubaccountOnly bool `json:"showLowestSubaccountOnly"`
	RequireAccounts          bool `json:"requireAccounts"`
	UseClassTracking         bool `json:"useClassTracking"`
	PromptForClass           bool `json:"promptForClass"`
	AutoAssignJournalNumbers bool `json:"autoAssignJournalNumbers"`
	DatePastWarnDays         int  `json:"datePastWarnDays"`
	DateFutureWarnDays       int  `json:"dateFutureWarnDays"`

	// Bills
	BillsDueDays             int    `json:"billsDueDays"`
	WarnDuplicateBillNumbers bool   `json:"warnDuplicateBillNumbers"`
	AutoUseVendorDiscounts   bool   `json:"autoUseVendorDiscounts"`
	VendorDiscountAccountID  *int64 `json:"vendorDiscountAccountId"`

	// Checking
	PrintAccountNamesOnVoucher bool   `json:"printAccountNamesOnVoucher"`
	WarnDuplicateCheckNumbers  bool   `json:"warnDuplicateCheckNumbers"`
	AutoFillPayee              bool   `json:"autoFillPayee"`
	DefaultCheckAccountID      *int64 `json:"defaultCheckAccountId"`
	DefaultBillPayAccountID    *int64 `json:"defaultBillPayAccountId"`
	DefaultDepositAccountID    *int64 `json:"defaultDepositAccountId"`

	// General
	AutoRecall bool   `json:"autoRecall"`
	WindowMode string `json:"windowMode"` // "multiple" | "one"
	IconBar    string `json:"iconBar"`    // "left" | "top" | "hidden"

	// Items & Inventory
	InventoryEnabled       bool `json:"inventoryEnabled"`
	PurchaseOrdersEnabled  bool `json:"purchaseOrdersEnabled"`
	WarnDuplicatePONumbers bool `json:"warnDuplicatePONumbers"`
	WarnNotEnoughInventory bool `json:"warnNotEnoughInventory"`

	// Reports & Graphs
	ReportBasis          string `json:"reportBasis"`          // "accrual" | "cash"
	AgingFrom            string `json:"agingFrom"`            // "due" | "transaction"
	ReportAccountDisplay string `json:"reportAccountDisplay"` // "name" | "description" | "both"

	// Sales & Customers
	EstimatesEnabled            bool    `json:"estimatesEnabled"`
	WarnDuplicateInvoiceNumbers bool    `json:"warnDuplicateInvoiceNumbers"`
	UseUndepositedFunds         bool    `json:"useUndepositedFunds"`
	AutoApplyPayments           bool    `json:"autoApplyPayments"`
	AutoCalcPayments            bool    `json:"autoCalcPayments"`
	UseCustomerDiscounts        bool    `json:"useCustomerDiscounts"`
	CustomerDiscountAccountID   *int64  `json:"customerDiscountAccountId"`
	DefaultShipViaID            *int64  `json:"defaultShipViaId"`
	DefaultFOB                  string  `json:"defaultFob"`
	DefaultMarkupPercent        float64 `json:"defaultMarkupPercent"`
	DefaultInvoiceTemplate      string  `json:"defaultInvoiceTemplate"` // "Product Invoice" | "Service Invoice" | "Professional Invoice"

	// Sales Tax
	SalesTaxEnabled       bool   `json:"salesTaxEnabled"`
	DefaultSalesTaxItemID *int64 `json:"defaultSalesTaxItemId"`
	SalesTaxBasis         string `json:"salesTaxBasis"`     // "accrual" | "cash"
	SalesTaxFrequency     string `json:"salesTaxFrequency"` // "monthly" | "quarterly" | "annually"
	MarkTaxableAmountsT   bool   `json:"markTaxableAmountsT"`

	// Desktop / Reminders
	ShowHomePageOnOpen  bool `json:"showHomePageOnOpen"`
	ShowRemindersOnOpen bool `json:"showRemindersOnOpen"`
}

// DefaultPrefs are used for new companies and fill missing fields of old ones.
func DefaultPrefs() Prefs {
	return Prefs{
		RequireAccounts:             true,
		DatePastWarnDays:            90,
		DateFutureWarnDays:          30,
		BillsDueDays:                10,
		WarnDuplicateBillNumbers:    true,
		WarnDuplicateCheckNumbers:   true,
		AutoFillPayee:               true,
		AutoRecall:                  true,
		WindowMode:                  "multiple",
		IconBar:                     "left",
		InventoryEnabled:            true,
		PurchaseOrdersEnabled:       true,
		WarnDuplicatePONumbers:      true,
		WarnNotEnoughInventory:      true,
		ReportBasis:                 "accrual",
		AgingFrom:                   "due",
		ReportAccountDisplay:        "name",
		EstimatesEnabled:            true,
		WarnDuplicateInvoiceNumbers: true,
		UseUndepositedFunds:         true,
		AutoApplyPayments:           true,
		AutoCalcPayments:            true,
		DefaultInvoiceTemplate:      "Product Invoice",
		SalesTaxBasis:               "accrual",
		SalesTaxFrequency:           "monthly",
		MarkTaxableAmountsT:         true,
		ShowHomePageOnOpen:          true,
	}
}

// LoadPrefs reads company preferences, filling defaults for missing fields.
func LoadPrefs(ctx context.Context, q Q) (Prefs, error) {
	p := DefaultPrefs()
	var raw string
	if err := q.QueryRowContext(ctx, `SELECT prefs FROM company WHERE id = 1`).Scan(&raw); err != nil {
		return p, err
	}
	if raw != "" {
		if err := json.Unmarshal([]byte(raw), &p); err != nil {
			return DefaultPrefs(), nil
		}
	}
	return p, nil
}

// SavePrefs writes company preferences.
func SavePrefs(ctx context.Context, q Q, p Prefs) error {
	b, _ := json.Marshal(p)
	_, err := q.ExecContext(ctx, `UPDATE company SET prefs = ?, updated_at = ? WHERE id = 1`, string(b), Now())
	return err
}

// CompanyName returns the company name ("" on error).
func CompanyName(ctx context.Context, q Q) string {
	var n string
	q.QueryRowContext(ctx, `SELECT name FROM company WHERE id = 1`).Scan(&n)
	return n
}

// FiscalYearStartMonth returns 1..12.
func FiscalYearStartMonth(ctx context.Context, q Q) int {
	m := 1
	q.QueryRowContext(ctx, `SELECT fiscal_year_start_month FROM company WHERE id = 1`).Scan(&m)
	if m < 1 || m > 12 {
		m = 1
	}
	return m
}

// ---------------------------------------------------------------------------
// Special accounts

const (
	SpecialAR                   = "AccountsReceivable"
	SpecialAP                   = "AccountsPayable"
	SpecialUndepositedFunds     = "UndepositedFunds"
	SpecialOpeningBalanceEquity = "OpeningBalanceEquity"
	SpecialRetainedEarnings     = "RetainedEarnings"
	SpecialSalesTaxPayable      = "SalesTaxPayable"
	SpecialInventoryAsset       = "InventoryAsset"
	SpecialCOGS                 = "CostOfGoodsSold"
	SpecialUncategorizedIncome  = "UncategorizedIncome"
	SpecialUncategorizedExpense = "UncategorizedExpenses"
	SpecialAskMyAccountant      = "AskMyAccountant"
)

// SpecialAccountDefaults gives the name and type used when a special account must be created.
var SpecialAccountDefaults = map[string][2]string{
	SpecialAR:                   {"Accounts Receivable", "Accounts Receivable"},
	SpecialAP:                   {"Accounts Payable", "Accounts Payable"},
	SpecialUndepositedFunds:     {"Undeposited Funds", "Other Current Asset"},
	SpecialOpeningBalanceEquity: {"Opening Balance Equity", "Equity"},
	SpecialRetainedEarnings:     {"Retained Earnings", "Equity"},
	SpecialSalesTaxPayable:      {"Sales Tax Payable", "Other Current Liability"},
	SpecialInventoryAsset:       {"Inventory Asset", "Other Current Asset"},
	SpecialCOGS:                 {"Cost of Goods Sold", "Cost of Goods Sold"},
	SpecialUncategorizedIncome:  {"Uncategorized Income", "Income"},
	SpecialUncategorizedExpense: {"Uncategorized Expenses", "Expense"},
	SpecialAskMyAccountant:      {"To Review with Accountant", "Expense"},
}

// SpecialAccount returns the id of the account flagged with special, creating
// it (or flagging a same-named top-level account of the right type) when missing.
// For AR/AP it returns the first such account.
func SpecialAccount(ctx context.Context, q Q, special string) (int64, error) {
	var id int64
	err := q.QueryRowContext(ctx, `SELECT id FROM accounts WHERE special = ? ORDER BY id LIMIT 1`, special).Scan(&id)
	if err == nil {
		return id, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return 0, err
	}
	def, ok := SpecialAccountDefaults[special]
	if !ok {
		return 0, fmt.Errorf("unknown special account %q", special)
	}
	err = q.QueryRowContext(ctx, `SELECT id FROM accounts WHERE parent_id IS NULL AND name = ? AND type = ?`, def[0], def[1]).Scan(&id)
	if err == nil {
		_, err = q.ExecContext(ctx, `UPDATE accounts SET special = ? WHERE id = ?`, special, id)
		return id, err
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return 0, err
	}
	name := def[0]
	for i := 2; ; i++ {
		var n int
		q.QueryRowContext(ctx, `SELECT COUNT(*) FROM accounts WHERE parent_id IS NULL AND name = ?`, name).Scan(&n)
		if n == 0 {
			break
		}
		name = fmt.Sprintf("%s %d", def[0], i)
	}
	now := Now()
	res, err := q.ExecContext(ctx, `INSERT INTO accounts(name, type, special, created_at, updated_at) VALUES(?,?,?,?,?)`, name, def[1], special, now, now)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// ---------------------------------------------------------------------------
// Passwords and closing date

// HashPassword returns a bcrypt hash of pw. An empty password hashes to "".
func HashPassword(pw string) string {
	if pw == "" {
		return ""
	}
	h, err := bcrypt.GenerateFromPassword([]byte(pw), bcrypt.DefaultCost)
	if err != nil {
		// longer than bcrypt accepts (72 bytes): hash a digest of it instead
		sum := sha256.Sum256([]byte(pw))
		h, _ = bcrypt.GenerateFromPassword([]byte(hex.EncodeToString(sum[:])), bcrypt.DefaultCost)
		return "$sha$" + string(h)
	}
	return string(h)
}

// CheckPassword compares pw with a hash from HashPassword (or an older
// "salt$sha256hex" hash). An empty hash accepts only "".
func CheckPassword(hash, pw string) bool {
	if hash == "" {
		return pw == ""
	}
	if strings.HasPrefix(hash, "$sha$") {
		sum := sha256.Sum256([]byte(pw))
		return bcrypt.CompareHashAndPassword([]byte(hash[5:]), []byte(hex.EncodeToString(sum[:]))) == nil
	}
	if strings.HasPrefix(hash, "$2") {
		return bcrypt.CompareHashAndPassword([]byte(hash), []byte(pw)) == nil
	}
	parts := strings.SplitN(hash, "$", 2)
	if len(parts) != 2 {
		return false
	}
	sum := sha256.Sum256([]byte(parts[0] + pw))
	return subtle.ConstantTimeCompare([]byte(hex.EncodeToString(sum[:])), []byte(parts[1])) == 1
}

// PasswordNeedsUpgrade reports whether a stored hash uses the old one-round
// SHA-256 scheme (re-hash it after the next successful check).
func PasswordNeedsUpgrade(hash string) bool {
	return hash != "" && !strings.HasPrefix(hash, "$2") && !strings.HasPrefix(hash, "$sha$")
}

// MinPasswordLength is the shortest password a user can be given.
const MinPasswordLength = 8

// CheckNewPassword refuses a new password that is too short ("" means no
// password and is accepted; callers decide whether that is allowed).
func CheckNewPassword(field, pw string) error {
	if pw != "" && len([]rune(pw)) < MinPasswordLength {
		return apperr.Validation(field, "Use a password of at least %d characters.", MinPasswordLength)
	}
	return nil
}

// ---------------------------------------------------------------------------
// Repeated wrong passwords: after a few failures for the same key, further
// attempts are refused for a while (30 seconds, doubling up to 15 minutes).
// Each attempt is counted before the (slow) password check, so guesses sent
// at the same time cannot get past the limit; a correct password clears the
// count.

type pwFail struct {
	n     int
	until time.Time
	last  time.Time
}

var (
	pwMu    sync.Mutex
	pwFails = map[string]*pwFail{}
)

// pwFailDelay slows down every wrong password a little.
const pwFailDelay = 250 * time.Millisecond

// PasswordTry counts a password attempt for key. It returns an error, and
// counts nothing, while key is locked out after limit wrong passwords in a row.
// Call PasswordOK after a correct password and PasswordWrong after a wrong one.
func PasswordTry(key string, limit int) error {
	pwMu.Lock()
	defer pwMu.Unlock()
	now := time.Now()
	f := pwFails[key]
	if f != nil && now.Before(f.until) {
		secs := int(f.until.Sub(now).Seconds()) + 1
		return apperr.New(http.StatusTooManyRequests, apperr.CodeValidation,
			"Too many incorrect passwords. Wait %d seconds and try again.", secs)
	}
	if f == nil {
		if len(pwFails) > 10000 {
			prunePasswordFails(now)
		}
		f = &pwFail{}
		pwFails[key] = f
	}
	f.n++
	f.last = now
	if f.n >= limit {
		d := 30 * time.Second << uint(min(f.n-limit, 5))
		if d > 15*time.Minute {
			d = 15 * time.Minute
		}
		f.until = now.Add(d)
	}
	return nil
}

// prunePasswordFails forgets keys that are not locked and had no attempt for
// an hour (the caller holds pwMu).
func prunePasswordFails(now time.Time) {
	for k, f := range pwFails {
		if !now.Before(f.until) && now.Sub(f.last) > time.Hour {
			delete(pwFails, k)
		}
	}
}

// PasswordWrong is called after a wrong password counted by PasswordTry: it
// only slows the answer down a little.
func PasswordWrong() { time.Sleep(pwFailDelay) }

// PasswordOK forgets the failures of key.
func PasswordOK(key string) {
	pwMu.Lock()
	defer pwMu.Unlock()
	delete(pwFails, key)
}

// IsAdmin reports whether user may do administrator tasks. Without
// passwords everybody works as the administrator.
func IsAdmin(ctx context.Context, q Q, user string) (bool, error) {
	var n int
	if err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM users WHERE active = 1 AND password_hash <> ''`).Scan(&n); err != nil {
		return false, err
	}
	if n == 0 {
		return true, nil
	}
	err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM users WHERE name = ? AND is_admin = 1 AND active = 1`, user).Scan(&n)
	return n > 0, err
}

// RequireAdmin returns a 403 error with msg unless user is an administrator.
func RequireAdmin(ctx context.Context, q Q, user, msg string) error {
	ok, err := IsAdmin(ctx, q, user)
	if err != nil {
		return err
	}
	if !ok {
		return apperr.Forbidden("%s", msg)
	}
	return nil
}

// FmtDate formats a YYYY-MM-DD date as MM/DD/YYYY for messages ("" stays "").
func FmtDate(d string) string {
	if t, err := ParseDate(d); err == nil {
		return t.Format("01/02/2006")
	}
	return d
}

// ClosingDate returns the company closing date ("" when none).
func ClosingDate(ctx context.Context, q Q) string {
	var d string
	q.QueryRowContext(ctx, `SELECT closing_date FROM company WHERE id = 1`).Scan(&d)
	return d
}

// CheckClosingDate must be called before adding, changing, voiding or deleting
// a transaction dated `date` (call it for both the old and the new date when editing).
//   - no closing date, or date after it: nil
//   - a closing date password is set: the password must match, else apperr.ClosingDate
//   - no password set: apperr.Confirm unless force is true
func CheckClosingDate(ctx context.Context, q Q, date, password string, force bool) error {
	var cd, hash string
	if err := q.QueryRowContext(ctx, `SELECT closing_date, closing_password_hash FROM company WHERE id = 1`).Scan(&cd, &hash); err != nil {
		return err
	}
	if cd == "" || date == "" || date > cd {
		return nil
	}
	if hash != "" {
		key := "closing:" + hash
		if password != "" {
			if err := PasswordTry(key, 5); err != nil {
				return err
			}
			if CheckPassword(hash, password) {
				PasswordOK(key)
				return nil
			}
			PasswordWrong()
			return apperr.ClosingDate("The closing date password is incorrect.")
		}
		return apperr.ClosingDate("This transaction is dated on or before the closing date of %s. Enter the closing date password to continue.", FmtDate(cd))
	}
	if force {
		return nil
	}
	return apperr.ConfirmKind(apperr.WarnClosing, "This transaction is dated on or before the closing date of %s. Saving or changing it will change account balances for a closed period. Do you want to continue?", FmtDate(cd))
}

// ---------------------------------------------------------------------------
// Audit trail

type AuditEntry struct {
	User      string
	Action    string // "add" | "modify" | "delete" | "void" | "closing_date" | "login" | ...
	TxnID     int64
	TxnType   string
	RefNumber string
	TxnDate   string
	Name      string
	Amount    int64 // cents
	Details   any   // marshalled to JSON (e.g. {"before": ..., "after": ...})
}

type assistantKey struct{}

// WithAssistant marks the context of a request an AI assistant made (through
// the SerieX tools for AI assistants): the audit trail and the transactions
// it saves then name the user as "<user> (AI assistant)".
func WithAssistant(ctx context.Context) context.Context {
	return context.WithValue(ctx, assistantKey{}, true)
}

// ByAssistant reports whether ctx is the context of a request an AI assistant made.
func ByAssistant(ctx context.Context) bool {
	v, _ := ctx.Value(assistantKey{}).(bool)
	return v
}

// ActingUser is the name the audit trail and new transactions record for
// user: "<user> (AI assistant)" when an AI assistant made the request.
func ActingUser(ctx context.Context, user string) string {
	if ByAssistant(ctx) && user != "" {
		return user + " (AI assistant)"
	}
	return user
}

// Audit appends a row to the audit trail. Rows of requests made by AI
// assistants name the user "<user> (AI assistant)" and have "aiAssistant":
// true in their details.
func Audit(ctx context.Context, q Q, e AuditEntry) error {
	if ByAssistant(ctx) {
		e.User = ActingUser(ctx, e.User)
		switch d := e.Details.(type) {
		case nil:
			e.Details = map[string]any{"aiAssistant": true}
		case map[string]any:
			m := make(map[string]any, len(d)+1)
			for k, v := range d {
				m[k] = v
			}
			m["aiAssistant"] = true
			e.Details = m
		}
	}
	details := "{}"
	if e.Details != nil {
		if b, err := json.Marshal(e.Details); err == nil {
			details = string(b)
		}
	}
	var txnID any
	if e.TxnID != 0 {
		txnID = e.TxnID
	}
	_, err := q.ExecContext(ctx, `INSERT INTO audit_log(ts, user, action, txn_id, txn_type, ref_number, txn_date, name, amount, details)
		VALUES(?,?,?,?,?,?,?,?,?,?)`, Now(), e.User, e.Action, txnID, e.TxnType, e.RefNumber, e.TxnDate, e.Name, e.Amount, details)
	return err
}

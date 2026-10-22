package ledger

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"seriex/internal/apperr"
	"seriex/internal/model"
	"seriex/internal/store"
)

// dependents are links owned by other transactions that touch s (payments or
// credits applied to it, credits it gave to later payments, refunds of it).
func (e *env) dependents(id int64) ([]slink, error) {
	rows, err := e.q.QueryContext(e.ctx, `SELECT id, from_txn_id, to_txn_id, owner_txn_id, amount, discount FROM txn_links
		WHERE (to_txn_id = ? OR from_txn_id = ?) AND owner_txn_id <> ? ORDER BY id`, id, id, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []slink
	for rows.Next() {
		var l slink
		if err := rows.Scan(&l.ID, &l.From, &l.To, &l.Owner, &l.Amount, &l.Discount); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// prepareRemoval runs the checks shared by Delete and Void and, when allowed,
// detaches the transaction from others: links owned by other transactions are
// removed (their owners are re-posted and keep the amount as unapplied credit)
// and deposits that contain it lose (delete) or zero (void) that line.
func (e *env) prepareRemoval(s *stxn, verb string, d *derived) error {
	opt := e.opt
	if !e.dryRun {
		if err := store.CheckClosingDate(e.ctx, e.q, s.Date, opt.ClosingPassword, opt.Accepts(apperr.WarnClosing)); err != nil {
			return err
		}
	}
	var reconciled int
	if err := e.q.QueryRowContext(e.ctx, `SELECT COUNT(*) FROM gl_entries WHERE txn_id = ? AND cleared = 'R'`, s.ID).Scan(&reconciled); err != nil {
		return err
	}
	deps, err := e.dependents(s.ID)
	if err != nil {
		return err
	}
	// a refund is made of the credits it refunds: it cannot lose them (its
	// check would stay recorded with nothing behind it). A bill payment that
	// loses its bill keeps its amount as an unapplied credit for the vendor,
	// like a customer payment that loses its invoice (asked below).
	for _, l := range deps {
		if l.Owner == s.ID || l.From != l.Owner {
			continue
		}
		ob, err := e.brief(l.Owner)
		if err != nil {
			return err
		}
		if ob == nil || ob.Voided || ob.Type != model.TxRefund {
			continue
		}
		return apperr.Validation("", "This %s was refunded by %s ($%s). Delete or void the %s first.",
			typeWord(s.Type), docLabel(ob), fmtMoney(abs64(ob.Amount)), typeWord(ob.Type))
	}
	var depLines []depLine
	if typeIn(s.Type, model.TxPayment, model.TxSalesReceipt, model.TxInvoice) {
		if depLines, err = e.depositLinesOf(s.ID); err != nil {
			return err
		}
	}
	// deposits and payments re-posted by this removal follow the same closing
	// date rule as the transaction itself; deposits change their bank amount
	affected := map[int64]bool{}
	for _, l := range deps {
		if l.Owner != s.ID {
			affected[l.Owner] = true
		}
	}
	for _, dl := range depLines {
		affected[dl.depID] = true
	}
	if err := e.checkAffected(affected); err != nil {
		return err
	}
	depRec, err := e.reconciledDeposits(depLines)
	if err != nil {
		return err
	}

	ing := map[string]string{"delete": "Deleting", "void": "Voiding"}[verb]
	if reconciled > 0 && !opt.Accepts(apperr.WarnReconciled) {
		return apperr.ConfirmKind(apperr.WarnReconciled, "This transaction has been reconciled. %s it will change the reconciled balance of the account. Are you sure you want to %s it?",
			ing, verb)
	}
	if depRec != nil && !opt.Accepts(apperr.WarnReconciled) {
		return apperr.ConfirmKind(apperr.WarnReconciled, "This payment is on %s, which has been reconciled. %s the payment will change that deposit and the reconciled balance of the account. Do you want to continue?",
			docLabel(depRec), ing)
	}
	if len(depLines) > 0 && !opt.Accepts(apperr.WarnDeposited) {
		db, _ := e.brief(depLines[0].depID)
		where := "a deposit"
		if db != nil {
			where = docLabel(db)
		}
		return apperr.ConfirmKind(apperr.WarnDeposited, "This payment has been deposited (%s). %s it will also take it out of that deposit, which changes the deposit total. Do you want to continue?", where, ing)
	}
	if len(deps) > 0 && !opt.Accepts(apperr.WarnApplied) {
		msg, err := e.appliedMessage(s, deps, verb)
		if err != nil {
			return err
		}
		return apperr.ConfirmKind(apperr.WarnApplied, "%s", msg)
	}
	owners := map[int64]bool{}
	for _, l := range deps {
		if _, err := e.q.ExecContext(e.ctx, `DELETE FROM txn_links WHERE id = ?`, l.ID); err != nil {
			return err
		}
		owners[l.Owner] = true
		d.txns[l.From], d.txns[l.To], d.txns[l.Owner] = true, true, true
	}
	for id := range owners {
		if err := e.repost(id); err != nil {
			return err
		}
	}
	for _, dl := range depLines {
		if verb == "void" {
			_, err = e.q.ExecContext(e.ctx, `UPDATE txn_lines SET amount = 0 WHERE id = ?`, dl.lineID)
		} else {
			_, err = e.q.ExecContext(e.ctx, `DELETE FROM txn_lines WHERE id = ?`, dl.lineID)
		}
		if err != nil {
			return err
		}
		if err := e.repost(dl.depID); err != nil {
			return err
		}
	}
	return nil
}

// checkAffected runs the closing date check for other transactions a change
// re-posts (deposits containing a payment, payments losing an application).
func (e *env) checkAffected(ids map[int64]bool) error {
	if e.dryRun {
		return nil
	}
	for id := range ids {
		b, err := e.brief(id)
		if err != nil {
			return err
		}
		if b == nil {
			continue
		}
		if err := store.CheckClosingDate(e.ctx, e.q, b.Date, e.opt.ClosingPassword, e.opt.Accepts(apperr.WarnClosing)); err != nil {
			if ae := apperr.As(err); ae != nil && ae.Code == apperr.CodeClosingDate && e.opt.ClosingPassword == "" {
				ae.Message = fmt.Sprintf("This change also changes %s, which is dated on or before the closing date of %s. Enter the closing date password to continue.",
					docLabel(b), store.FmtDate(store.ClosingDate(e.ctx, e.q)))
			}
			return err
		}
	}
	return nil
}

// reconciledDeposits returns the first deposit among depLines that has
// reconciled entries (nil when none).
func (e *env) reconciledDeposits(depLines []depLine) (*brief, error) {
	for _, dl := range depLines {
		var n int
		if err := e.q.QueryRowContext(e.ctx, `SELECT COUNT(*) FROM gl_entries WHERE txn_id = ? AND cleared = 'R'`, dl.depID).Scan(&n); err != nil {
			return nil, err
		}
		if n > 0 {
			return e.brief(dl.depID)
		}
	}
	return nil, nil
}

// appliedMessage builds the question asked before removing a transaction that
// has payments or credits applied to it (or that is applied to others): it
// names them and says what becomes of them.
func (e *env) appliedMessage(s *stxn, deps []slink, verb string) (string, error) {
	ing := map[string]string{"delete": "Deleting", "void": "Voiding"}[verb]
	word := typeWord(s.Type)
	type use struct {
		b      *brief
		amount int64 // applied, discount included
		credit int64 // what stays as a credit when the charge goes (the discount does not)
	}
	var uses []use
	idx := map[int64]int{}
	var discount int64
	for _, l := range deps {
		other := l.From
		if other == s.ID {
			other = l.To
		}
		b, err := e.brief(other)
		if err != nil {
			return "", err
		}
		if b == nil {
			continue
		}
		discount += l.Discount
		if i, ok := idx[b.ID]; ok {
			uses[i].amount += l.Amount + l.Discount
			uses[i].credit += l.Amount
			continue
		}
		idx[b.ID] = len(uses)
		uses = append(uses, use{b, l.Amount + l.Discount, l.Amount})
	}
	var parts []string
	var total, credit int64
	billPaid := false
	for _, u := range uses {
		parts = append(parts, fmt.Sprintf("%s ($%s)", docLabel(u.b), fmtMoney(u.amount)))
		total += u.amount
		credit += u.credit
		if u.b.Type == model.TxBillPayment {
			billPaid = true
		}
	}
	list := joinAnd(parts)
	if len(list) > 0 {
		list = strings.ToUpper(list[:1]) + list[1:]
	}
	verbAre := "is"
	if len(uses) > 1 {
		verbAre = "are"
	}
	charge := typeIn(s.Type, model.TxInvoice, model.TxStatementCharge, model.TxBill, model.TxItemReceipt) ||
		(s.Type == model.TxJournal && func() bool { b, _ := e.brief(s.ID); return b.jeCharge() }())
	if charge {
		who := e.nameFull(s.NameID)
		if len(uses) == 1 {
			if b := uses[0].b; b.NameID != 0 {
				who = e.nameFull(b.NameID)
			}
		}
		extra := ""
		if discount != 0 {
			extra = fmt.Sprintf(" The $%s discount taken on it is removed.", fmtMoney(discount))
		}
		if billPaid {
			// the bill payment stays (its check is unchanged) and its amount
			// becomes a credit to apply to another bill
			extra += " The bill payment stays recorded as it is; you can apply the credit to another bill of this vendor in Pay Bills."
		}
		if len(uses) == 1 {
			return fmt.Sprintf("%s %s applied to this %s. %s the %s turns that amount into a $%s credit for %s.%s %s anyway?",
				list, verbAre, word, ing, word, fmtMoney(credit), who, extra, capFirst(verb)), nil
		}
		return fmt.Sprintf("%s %s applied to this %s. %s the %s turns those amounts into credits totaling $%s for %s.%s %s anyway?",
			list, verbAre, word, ing, word, fmtMoney(credit), who, extra, capFirst(verb)), nil
	}
	// a credit, payment or vendor credit used by others: those documents reopen
	return fmt.Sprintf("This %s is applied to %s. %s it makes %s open again for $%s. %s anyway?",
		word, joinAnd(parts), ing, map[bool]string{true: "them", false: "it"}[len(uses) > 1], fmtMoney(total), capFirst(verb)), nil
}

func joinAnd(p []string) string {
	switch len(p) {
	case 0:
		return ""
	case 1:
		return p[0]
	}
	return strings.Join(p[:len(p)-1], ", ") + " and " + p[len(p)-1]
}

func deleteTxn(ctx context.Context, tx *sql.Tx, id int64, opt SaveOptions) error {
	e, err := newEnv(ctx, tx, opt)
	if err != nil {
		return err
	}
	s, err := loadStored(ctx, tx, id)
	if err != nil {
		return err
	}
	before, err := getTxn(ctx, tx, id)
	if err != nil {
		return err
	}
	d := newDerived()
	if err := e.collectDerived(d, s); err != nil {
		return err
	}
	if err := e.prepareRemoval(s, "delete", d); err != nil {
		return err
	}
	op, err := e.loadOldPosting(id)
	if err != nil {
		return err
	}
	// purchase lines of this transaction stop being billable sources once it is gone
	for _, l := range s.Lines {
		delete(d.billLines, l.ID)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM txns WHERE id = ?`, id); err != nil {
		return err
	}
	if err := e.recost(op.moveItems, s.Date); err != nil {
		return err
	}
	delete(d.txns, id)
	delete(d.pos, id)
	delete(d.ests, id)
	if err := e.refreshDerived(d); err != nil {
		return err
	}
	return audit(ctx, tx, opt.User, "delete", before, before, nil)
}

func voidTxn(ctx context.Context, tx *sql.Tx, id int64, opt SaveOptions) error {
	e, err := newEnv(ctx, tx, opt)
	if err != nil {
		return err
	}
	s, err := loadStored(ctx, tx, id)
	if err != nil {
		return err
	}
	if s.Voided {
		return nil
	}
	before, err := getTxn(ctx, tx, id)
	if err != nil {
		return err
	}
	d := newDerived()
	if err := e.collectDerived(d, s); err != nil {
		return err
	}
	if err := e.prepareRemoval(s, "void", d); err != nil {
		return err
	}
	op, err := e.loadOldPosting(id)
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM txn_links WHERE owner_txn_id = ?`, id); err != nil {
		return err
	}
	memo := s.Memo
	if !strings.HasPrefix(memo, "VOID:") {
		memo = strings.TrimSpace("VOID: " + memo)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE txns SET amount = 0, open_balance = 0, subtotal = 0, tax_amount = 0,
		cash_back_amount = 0, voided = 1, memo = ?, updated_at = ? WHERE id = ?`, memo, store.Stamp(), id); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE txn_lines SET amount = 0, cogs = 0 WHERE txn_id = ?`, id); err != nil {
		return err
	}
	if _, err := e.writePosting(&stxn{ID: id, Date: s.Date}, &posting{}, op); err != nil {
		return err
	}
	if err := e.recost(op.moveItems, s.Date); err != nil {
		return err
	}
	if err := e.refreshDerived(d); err != nil {
		return err
	}
	after, err := getTxn(ctx, tx, id)
	if err != nil {
		return err
	}
	return audit(ctx, tx, opt.User, "void", after, before, after)
}

// errDryRun rolls back a remove-check.
var errDryRun = errors.New("dry run")

// removeCheck runs the questions Delete or Void would ask (closing date
// excluded) and rolls everything back. It returns the first question, or nil.
func removeCheck(ctx context.Context, tx *sql.Tx, id int64, verb string, opt SaveOptions) (*apperr.Error, error) {
	e, err := newEnv(ctx, tx, opt)
	if err != nil {
		return nil, err
	}
	e.dryRun = true
	s, err := loadStored(ctx, tx, id)
	if err != nil {
		return nil, err
	}
	if verb == "void" && s.Voided {
		return nil, nil
	}
	if err := e.prepareRemoval(s, verb, newDerived()); err != nil {
		if ae := apperr.As(err); ae != nil && ae.Code == apperr.CodeConfirm {
			return ae, nil
		}
		return nil, err
	}
	return nil, nil
}

package ledger

import "seriex/internal/model"

// TypeLabel returns the display name of a transaction type ("Invoice",
// "Bill Pmt -Check"...). accountType is the type of the transaction's header
// account (txns.account_id); it only matters for bill payments, which show as
// "Bill Pmt -CCard" when paid from a credit card account. Pass "" when unknown.
func TypeLabel(txnType, accountType string) string {
	if txnType == model.TxBillPayment && accountType == model.AcctCreditCard {
		return "Bill Pmt -CCard"
	}
	if l, ok := model.TxnTypeLabels[txnType]; ok {
		return l
	}
	return txnType
}

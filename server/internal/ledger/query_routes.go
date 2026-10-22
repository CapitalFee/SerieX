package ledger

import (
	"database/sql"
	"strings"

	"seriex/internal/apperr"
	"seriex/internal/httpx"
	"seriex/internal/model"
	"seriex/internal/store"
)

// registerQueryRoutes adds the transaction query routes (lists, registers,
// open documents, undeposited funds, pay bills...). Implementations live in
// the q_*.go files.
func registerQueryRoutes(rt *httpx.Router) {
	rt.C("GET", "/txns", qryHandleList)
	rt.C("GET", "/txns/{id}/adjacent", qryHandleAdjacent)
	rt.C("GET", "/txns-last", qryHandleLast)
	rt.C("GET", "/next-ref", qryHandleNextRef)
	rt.C("GET", "/registers/{accountId}", qryHandleRegister)
	rt.C("GET", "/open-docs", qryHandleOpenDocs)
	rt.C("GET", "/undeposited", qryHandleUndeposited)
	rt.C("GET", "/billables", qryHandleBillables)
	rt.C("GET", "/open-pos", qryHandleOpenPOs)
	rt.C("GET", "/open-estimates", qryHandleOpenEstimates)
	rt.C("GET", "/item-receipts", qryHandleItemReceipts)
	rt.C("POST", "/pay-bills", qryHandlePayBills)
	rt.C("GET", "/sales-tax/due", qryHandleSalesTaxDue)
	rt.C("GET", "/to-print", qryHandleToPrint)
	rt.C("POST", "/mark-printed", qryHandleMarkPrinted)
	rt.C("GET", "/names/{id}/summary", qryHandleNameSummary)
}

// qryDateParam returns a date query parameter, validated ("" when absent).
func qryDateParam(c *httpx.Ctx, name string) (string, error) {
	v := strings.TrimSpace(c.Q(name))
	if v != "" && !store.ValidDate(v) {
		return "", apperr.Validation(name, "Invalid date %q (use YYYY-MM-DD).", v)
	}
	return v, nil
}

func qryHandleList(c *httpx.Ctx) error {
	ctx := c.Context()
	f := qryTxnFilter{
		ItemID:   c.QInt("itemId"),
		Text:     strings.TrimSpace(c.Q("q")),
		Ref:      strings.TrimSpace(c.Q("ref")),
		Memo:     strings.TrimSpace(c.Q("memo")),
		Status:   strings.TrimSpace(c.Q("status")),
		Sort:     c.Q("sort"),
		Limit:    int(c.QInt("limit")),
		Offset:   int(c.QInt("offset")),
		OpenOnly: c.QBool("openOnly"),
	}
	for _, t := range strings.Split(c.Q("types"), ",") {
		t = strings.ToUpper(strings.TrimSpace(t))
		if t == "" {
			continue
		}
		if _, ok := model.TxnTypeLabels[t]; !ok {
			return apperr.Validation("types", "Unknown transaction type %q.", t)
		}
		f.Types = append(f.Types, t)
	}
	var err error
	if f.From, err = qryDateParam(c, "from"); err != nil {
		return err
	}
	if f.To, err = qryDateParam(c, "to"); err != nil {
		return err
	}
	if id := c.QInt("nameId"); id > 0 {
		if f.NameIDs, err = qryNameSet(ctx, c.DB, id, c.QBool("includeJobs")); err != nil {
			return err
		}
	}
	if id := c.QInt("accountId"); id > 0 {
		if f.AccountIDs, err = store.Descendants(ctx, c.DB, "accounts", id); err != nil {
			return err
		}
	}
	if v, ok := c.QFloat("amountMin"); ok {
		cents := store.Cents(v)
		f.AmountMin = &cents
	}
	if v, ok := c.QFloat("amountMax"); ok {
		cents := store.Cents(v)
		f.AmountMax = &cents
	}
	res, err := qryListTxns(ctx, c.DB, f)
	if err != nil {
		return err
	}
	return c.JSON(res)
}

func qryHandleAdjacent(c *httpx.Ctx) error {
	id, err := c.ID("id")
	if err != nil {
		return err
	}
	other, err := qryAdjacent(c.Context(), c.DB, id, c.Q("dir"))
	if err != nil {
		return err
	}
	return c.JSON(map[string]any{"id": other})
}

func qryHandleLast(c *httpx.Ctx) error {
	typ := strings.ToUpper(strings.TrimSpace(c.Q("type")))
	if _, ok := model.TxnTypeLabels[typ]; !ok {
		return apperr.Validation("type", "Unknown transaction type %q.", typ)
	}
	id, err := qryLast(c.Context(), c.DB, typ)
	if err != nil {
		return err
	}
	return c.JSON(map[string]any{"id": id})
}

func qryHandleNextRef(c *httpx.Ctx) error {
	typ := strings.ToUpper(strings.TrimSpace(c.Q("type")))
	if _, ok := model.TxnTypeLabels[typ]; !ok {
		return apperr.Validation("type", "Unknown transaction type %q.", typ)
	}
	ref, err := qryNextRef(c.Context(), c.DB, typ, c.QInt("accountId"))
	if err != nil {
		return err
	}
	return c.JSON(map[string]string{"refNumber": ref})
}

func qryHandleRegister(c *httpx.Ctx) error {
	id, err := c.ID("accountId")
	if err != nil {
		return err
	}
	from, err := qryDateParam(c, "from")
	if err != nil {
		return err
	}
	to, err := qryDateParam(c, "to")
	if err != nil {
		return err
	}
	var nameIDs []int64
	if n := c.QInt("nameId"); n > 0 {
		if nameIDs, err = qryNameSet(c.Context(), c.DB, n, c.QBool("includeJobs")); err != nil {
			return err
		}
	}
	res, err := qryRegister(c.Context(), c.DB, id, from, to, nameIDs)
	if err != nil {
		return err
	}
	return c.JSON(res)
}

func qryHandleOpenDocs(c *httpx.Ctx) error {
	date, err := qryDateParam(c, "date")
	if err != nil {
		return err
	}
	kind := c.Q("kind")
	if kind == "" {
		kind = "receivable"
	}
	res, err := qryOpenDocs(c.Context(), c.DB, qryOpenDocsParams{
		NameID:       c.QInt("nameId"),
		IncludeJobs:  c.QBool("includeJobs"),
		Kind:         kind,
		Date:         date,
		ExcludeTxnID: c.QInt("excludeTxnId"),
	})
	if err != nil {
		return err
	}
	return c.JSON(res)
}

func qryHandleUndeposited(c *httpx.Ctx) error {
	res, err := qryUndeposited(c.Context(), c.DB, c.QInt("excludeDepositId"))
	if err != nil {
		return err
	}
	return c.JSON(res)
}

func qryHandleBillables(c *httpx.Ctx) error {
	res, err := qryBillables(c.Context(), c.DB, c.QInt("customerId"))
	if err != nil {
		return err
	}
	return c.JSON(res)
}

func qryHandleOpenPOs(c *httpx.Ctx) error {
	res, err := qryOpenPOs(c.Context(), c.DB, c.QInt("vendorId"))
	if err != nil {
		return err
	}
	return c.JSON(res)
}

func qryHandleOpenEstimates(c *httpx.Ctx) error {
	res, err := qryOpenEstimates(c.Context(), c.DB, c.QInt("customerId"), c.QBool("includeJobs"))
	if err != nil {
		return err
	}
	return c.JSON(res)
}

func qryHandleItemReceipts(c *httpx.Ctx) error {
	res, err := qryItemReceipts(c.Context(), c.DB, c.QInt("vendorId"))
	if err != nil {
		return err
	}
	return c.JSON(res)
}

func qryHandlePayBills(c *httpx.Ctx) error {
	var req model.PayBillsRequest
	if err := c.Decode(&req); err != nil {
		return err
	}
	var res *model.PayBillsResult
	opt := Options(c)
	err := c.Write(func(tx *sql.Tx) error {
		var err error
		res, err = qryPayBills(c.Context(), tx, req, opt)
		return err
	})
	if err != nil {
		return err
	}
	return c.JSON(res)
}

func qryHandleSalesTaxDue(c *httpx.Ctx) error {
	asOf, err := qryDateParam(c, "asOf")
	if err != nil {
		return err
	}
	paid, err := qryDateParam(c, "paidThrough")
	if err != nil {
		return err
	}
	res, err := qrySalesTaxDue(c.Context(), c.DB, asOf, paid)
	if err != nil {
		return err
	}
	return c.JSON(res)
}

func qryHandleToPrint(c *httpx.Ctx) error {
	res, err := qryToPrint(c.Context(), c.DB, c.Q("kind"), c.QInt("accountId"))
	if err != nil {
		return err
	}
	return c.JSON(res)
}

func qryHandleMarkPrinted(c *httpx.Ctx) error {
	var req qryMarkPrintedRequest
	if err := c.Decode(&req); err != nil {
		return err
	}
	var res []model.TxnSummary
	err := c.Write(func(tx *sql.Tx) error {
		var err error
		res, err = qryMarkPrinted(c.Context(), tx, req, c.User, c.Accepts(apperr.WarnDuplicateNumber))
		return err
	})
	if err != nil {
		return err
	}
	return c.JSON(map[string]any{"ok": true, "updated": len(res), "rows": res})
}

func qryHandleNameSummary(c *httpx.Ctx) error {
	id, err := c.ID("id")
	if err != nil {
		return err
	}
	res, err := qrySummaryOfName(c.Context(), c.DB, id)
	if err != nil {
		return err
	}
	return c.JSON(res)
}

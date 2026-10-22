package ledger

import (
	"database/sql"
	"encoding/json"

	"seriex/internal/apperr"
	"seriex/internal/httpx"
	"seriex/internal/model"
)

// decodeTxn reads a transaction body. Numbers inside extra are kept as
// json.Number so they are stored and returned exactly as sent.
func decodeTxn(c *httpx.Ctx, t *model.Txn) error {
	if c.R.Body == nil {
		return apperr.BadRequest("missing request body")
	}
	dec := json.NewDecoder(c.R.Body)
	dec.UseNumber()
	if err := dec.Decode(t); err != nil {
		return httpx.BodyError(err)
	}
	return nil
}

// ifMatch is the updatedAt of the client's copy for DELETE / void (header
// If-Match or ?updatedAt=); "" when not sent.
func ifMatch(c *httpx.Ctx) string {
	if v := c.R.Header.Get("If-Match"); v != "" {
		return v
	}
	return c.Q("updatedAt")
}

func saveOptions(c *httpx.Ctx) SaveOptions {
	return Options(c)
}

// registerTxnRoutes adds /txns CRUD routes.
func registerTxnRoutes(rt *httpx.Router) {
	rt.C("POST", "/txns", func(c *httpx.Ctx) error {
		var t model.Txn
		if err := decodeTxn(c, &t); err != nil {
			return err
		}
		t.ID = 0
		return writeAndGet(c, func(tx *sql.Tx) (int64, error) {
			return Save(c.Context(), tx, &t, saveOptions(c))
		})
	})

	rt.C("GET", "/txns/{id}", func(c *httpx.Ctx) error {
		id, err := c.ID("id")
		if err != nil {
			return err
		}
		t, err := Get(c.Context(), c.DB, id)
		if err != nil {
			return err
		}
		return c.JSON(t)
	})

	rt.C("PUT", "/txns/{id}", func(c *httpx.Ctx) error {
		id, err := c.ID("id")
		if err != nil {
			return err
		}
		var t model.Txn
		if err := decodeTxn(c, &t); err != nil {
			return err
		}
		t.ID = id
		return writeAndGet(c, func(tx *sql.Tx) (int64, error) {
			return Save(c.Context(), tx, &t, saveOptions(c))
		})
	})

	rt.C("DELETE", "/txns/{id}", func(c *httpx.Ctx) error {
		id, err := c.ID("id")
		if err != nil {
			return err
		}
		if err := c.Write(func(tx *sql.Tx) error {
			if err := CheckTxnStale(c.Context(), tx, id, ifMatch(c)); err != nil {
				return err
			}
			return Delete(c.Context(), tx, id, saveOptions(c))
		}); err != nil {
			return err
		}
		return c.NoContent()
	})

	// GET /txns/{id}/remove-check?verb=void|delete -> {} or {question, warning}:
	// the first Yes/No question Void or Delete would ask (nothing is changed).
	rt.C("GET", "/txns/{id}/remove-check", func(c *httpx.Ctx) error {
		id, err := c.ID("id")
		if err != nil {
			return err
		}
		verb := c.Q("verb")
		if verb != "void" && verb != "delete" {
			return apperr.Validation("verb", "verb must be void or delete.")
		}
		var q *apperr.Error
		err = c.Write(func(tx *sql.Tx) error {
			var err error
			if q, err = removeCheck(c.Context(), tx, id, verb, Options(c)); err != nil {
				return err
			}
			return errDryRun
		})
		if err != nil && err != errDryRun {
			return err
		}
		if q == nil {
			return c.JSON(map[string]any{})
		}
		return c.JSON(map[string]any{"question": q.Message, "warning": q.Warning})
	})

	rt.C("POST", "/txns/{id}/void", func(c *httpx.Ctx) error {
		id, err := c.ID("id")
		if err != nil {
			return err
		}
		return writeAndGet(c, func(tx *sql.Tx) (int64, error) {
			if err := CheckTxnStale(c.Context(), tx, id, ifMatch(c)); err != nil {
				return 0, err
			}
			return id, Void(c.Context(), tx, id, saveOptions(c))
		})
	})

	// Receive items, then bill for them: the item receipt becomes a bill.
	rt.C("POST", "/txns/{id}/convert-to-bill", func(c *httpx.Ctx) error {
		id, err := c.ID("id")
		if err != nil {
			return err
		}
		var body struct {
			Date      string  `json:"date"`
			DueDate   string  `json:"dueDate"`
			RefNumber *string `json:"refNumber"`
			TermsID   *int64  `json:"termsId"`
			Memo      *string `json:"memo"`
		}
		if c.R.ContentLength != 0 {
			if err := c.Decode(&body); err != nil {
				return err
			}
		}
		return writeAndGet(c, func(tx *sql.Tx) (int64, error) {
			t, err := Get(c.Context(), tx, id)
			if err != nil {
				return 0, err
			}
			if t.Type != model.TxItemReceipt {
				return 0, apperr.Validation("type", "Only item receipts can be converted to a bill.")
			}
			t.Type = model.TxBill
			if body.Date != "" {
				t.Date = body.Date
			}
			t.DueDate = body.DueDate
			if body.RefNumber != nil {
				t.RefNumber = *body.RefNumber
			}
			if body.TermsID != nil {
				t.TermsID = body.TermsID
				if *body.TermsID == 0 {
					t.TermsID = nil
				}
			}
			if body.Memo != nil {
				t.Memo = *body.Memo
			}
			return Save(c.Context(), tx, t, saveOptions(c))
		})
	})
}

// writeAndGet runs fn in a write transaction and returns the saved transaction.
func writeAndGet(c *httpx.Ctx, fn func(tx *sql.Tx) (int64, error)) error {
	var out *model.Txn
	err := c.Write(func(tx *sql.Tx) error {
		id, err := fn(tx)
		if err != nil {
			return err
		}
		out, err = Get(c.Context(), tx, id)
		return err
	})
	if err != nil {
		return err
	}
	return c.JSON(out)
}

package liabilities

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"seriexpayroll/internal/apperr"
	"seriexpayroll/internal/httpx"
	"seriexpayroll/internal/model"
	"seriexpayroll/internal/posting"
	"seriexpayroll/internal/store"
)

// paymentSchedules lists one row per payment group used by an active
// liability item, with the stored frequency/method or the defaults.
func paymentSchedules(ctx context.Context, q store.Q, n *namer) ([]model.PaymentSchedule, error) {
	its, err := liabilityItems(ctx, q)
	if err != nil {
		return nil, err
	}
	sc, err := loadSchedules(ctx, q)
	if err != nil {
		return nil, err
	}
	groups := map[string][]*model.PayrollItem{}
	for _, it := range its {
		if it.Active {
			groups[it.EffectiveGroup] = append(groups[it.EffectiveGroup], it)
		}
	}
	keys := make([]string, 0, len(groups))
	for g := range groups {
		keys = append(keys, g)
	}
	sort.Slice(keys, func(i, j int) bool {
		if ri, rj := groupRank(keys[i]), groupRank(keys[j]); ri != rj {
			return ri < rj
		}
		return keys[i] < keys[j]
	})
	out := make([]model.PaymentSchedule, 0, len(keys))
	for _, g := range keys {
		list := groups[g]
		sort.Slice(list, func(i, j int) bool { return lessItem(list[i], list[j]) })
		s := sc.get(g, list)
		vname := n.vendor(s.Vendor)
		ps := model.PaymentSchedule{PaymentGroup: g, Label: groupLabel(g, list, vname), AgencyVendorID: s.Vendor,
			AgencyName: vname, Frequency: s.Freq, Method: s.Method, ItemNames: []string{}}
		for _, it := range list {
			ps.ItemNames = append(ps.ItemNames, it.Name)
		}
		out = append(out, ps)
	}
	return out, nil
}

// GET /payment-schedules
func getSchedulesRoute(c *httpx.Ctx) error {
	list, err := paymentSchedules(c.Context(), c.DB, newNamer(c))
	if err != nil {
		return err
	}
	return c.JSON(list)
}

// PUT /payment-schedules body: PaymentSchedule[] (or {"schedules": [...]});
// only the groups sent change. Returns the full list.
func putSchedulesRoute(c *httpx.Ctx) error {
	body, err := httpx.ReadJSONBody(c.R, 1<<20)
	if err != nil {
		return err
	}
	var in []model.PaymentSchedule
	if t := bytes.TrimSpace(body); len(t) > 0 && t[0] == '{' {
		var wrap struct {
			Schedules []model.PaymentSchedule `json:"schedules"`
		}
		if err := json.Unmarshal(t, &wrap); err != nil {
			return httpx.BodyError(err)
		}
		in = wrap.Schedules
	} else if err := json.Unmarshal(t, &in); err != nil {
		return httpx.BodyError(err)
	}
	lk := booksLookup(c, func(lk *posting.Lookups) bool {
		for _, s := range in {
			if s.AgencyVendorID != nil && *s.AgencyVendorID > 0 && !hasVendors(lk, s.AgencyVendorID) {
				return false
			}
		}
		return true
	})
	seen := map[string]bool{}
	for i := range in {
		s := &in[i]
		field := fmt.Sprintf("[%d]", i)
		s.PaymentGroup = strings.TrimSpace(s.PaymentGroup)
		if !validGroup(s.PaymentGroup) {
			return apperr.Validation(field+".paymentGroup", "Unknown payment group %q.", s.PaymentGroup)
		}
		if seen[s.PaymentGroup] {
			return apperr.Validation(field+".paymentGroup", "The payment group %s is listed twice.", s.PaymentGroup)
		}
		seen[s.PaymentGroup] = true
		s.Frequency = strings.TrimSpace(s.Frequency)
		if !validFrequency(s.Frequency) {
			return apperr.Validation(field+".frequency", "Choose how often %s is paid (semiweekly, monthly, quarterly, annually or after each payroll).", s.PaymentGroup)
		}
		s.Method = strings.TrimSpace(s.Method)
		if s.Method == "" {
			s.Method = "check"
		}
		if s.Method != "check" && s.Method != "e-pay" {
			return apperr.Validation(field+".method", "The payment method must be check or e-pay.")
		}
		if s.AgencyVendorID != nil && *s.AgencyVendorID <= 0 {
			s.AgencyVendorID = nil
		}
		if s.AgencyVendorID != nil && lk.OK {
			if _, ok := lk.Vendors[*s.AgencyVendorID]; !ok {
				return apperr.Validation(field+".agencyVendorId", "The payee is not a vendor in SerieX Books.")
			}
		}
	}
	ctx := c.Context()
	err = c.Write(func(tx *sql.Tx) error {
		sc, err := loadSchedules(ctx, tx)
		if err != nil {
			return err
		}
		now := store.Now()
		var changes []map[string]any
		for _, s := range in {
			old := sc.rows[s.PaymentGroup]
			if old != nil && old.Freq == s.Frequency && old.Method == s.Method && idEq(old.Vendor, s.AgencyVendorID) {
				continue
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO payment_schedules(payment_group, agency_vendor_id, frequency, method, updated_at)
				VALUES(?,?,?,?,?) ON CONFLICT(payment_group) DO UPDATE SET agency_vendor_id = excluded.agency_vendor_id,
				frequency = excluded.frequency, method = excluded.method, updated_at = excluded.updated_at`,
				s.PaymentGroup, store.NullID(s.AgencyVendorID), s.Frequency, s.Method, now); err != nil {
				return err
			}
			ch := map[string]any{"paymentGroup": s.PaymentGroup, "after": map[string]any{
				"frequency": s.Frequency, "method": s.Method, "agencyVendorId": s.AgencyVendorID}}
			if old != nil {
				ch["before"] = map[string]any{"frequency": old.Freq, "method": old.Method, "agencyVendorId": old.Vendor}
			}
			changes = append(changes, ch)
		}
		if len(changes) == 0 {
			return nil
		}
		var names []string
		for _, ch := range changes {
			names = append(names, ch["paymentGroup"].(string))
		}
		return store.Audit(ctx, tx, c.User, "modify", "payment_schedule", 0,
			"Tax payment schedule changed: "+strings.Join(names, ", "), map[string]any{"changes": changes})
	})
	if err != nil {
		return err
	}
	return getSchedulesRoute(c)
}

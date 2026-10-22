-- SerieX Payroll company file schema (SQLite).
-- One payroll file per SerieX Books company file; the file id is the Books
-- company id (data/<id>.sxp). Records that live in SerieX Books (accounts,
-- vendors, classes, customer:jobs, the employee's "other name") are referenced
-- by their Books ids in *_account_id / *_vendor_id / books_* columns; there are
-- no foreign keys to them because they are in another database.
-- Conventions (same as SerieX Books):
--   * Money columns are INTEGER cents. Hours, rates and percents are REAL.
--   * Dates are TEXT 'YYYY-MM-DD'. Timestamps are TEXT RFC3339.
--   * Paycheck and liability line amounts are positive; the category says how
--     they affect net pay and the liability balances.

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE company (
  id                       INTEGER PRIMARY KEY CHECK (id = 1),
  books_company_id         TEXT NOT NULL,
  name                     TEXT NOT NULL,
  legal_name               TEXT NOT NULL DEFAULT '',
  trade_name               TEXT NOT NULL DEFAULT '',
  address1                 TEXT NOT NULL DEFAULT '',
  address2                 TEXT NOT NULL DEFAULT '',
  city                     TEXT NOT NULL DEFAULT '',
  state                    TEXT NOT NULL DEFAULT '',
  zip                      TEXT NOT NULL DEFAULT '',
  phone                    TEXT NOT NULL DEFAULT '',
  email                    TEXT NOT NULL DEFAULT '',
  ein                      TEXT NOT NULL DEFAULT '',   -- 9 digits, no dash
  contact_name             TEXT NOT NULL DEFAULT '',
  contact_title            TEXT NOT NULL DEFAULT '',
  contact_phone            TEXT NOT NULL DEFAULT '',
  primary_state            TEXT NOT NULL DEFAULT '',   -- main work state (2-letter code)
  federal_deposit_schedule TEXT NOT NULL DEFAULT 'monthly', -- monthly | semiweekly
  first_payroll_year       INTEGER NOT NULL DEFAULT 0,
  prefs                    TEXT NOT NULL DEFAULT '{}', -- model.PayrollPrefs JSON
  setup_done               INTEGER NOT NULL DEFAULT 0, -- Payroll Setup finished
  setup_state              TEXT NOT NULL DEFAULT '{}', -- wizard progress JSON (frontend owned)
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL
);

-- Per-state employer settings. ui_rates / other_rates are keyed by calendar year.
CREATE TABLE state_settings (
  id                   INTEGER PRIMARY KEY,
  state                TEXT NOT NULL UNIQUE,
  withholding_id       TEXT NOT NULL DEFAULT '', -- state withholding account number
  ui_id                TEXT NOT NULL DEFAULT '', -- state unemployment account number
  ui_rates             TEXT NOT NULL DEFAULT '{}', -- {"2026": 2.7} percent
  other_rates          TEXT NOT NULL DEFAULT '{}', -- {"2026": {"ETT": 0.1}} percent by state program key
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

-- Users of SerieX Books that may open payroll besides Books administrators.
CREATE TABLE access (
  user       TEXT PRIMARY KEY COLLATE NOCASE,
  created_at TEXT NOT NULL
);

CREATE TABLE pay_schedules (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE COLLATE NOCASE,
  frequency       TEXT NOT NULL, -- weekly | biweekly | semimonthly | monthly | quarterly | semiannually | annually | daily
  next_period_end TEXT NOT NULL,
  next_check_date TEXT NOT NULL,
  semi_first_day  INTEGER NOT NULL DEFAULT 15, -- semimonthly: first period of a month ends on this day, second on the last day
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE payroll_items (
  id                   INTEGER PRIMARY KEY,
  name                 TEXT NOT NULL UNIQUE COLLATE NOCASE,
  type                 TEXT NOT NULL,              -- model.Item*
  tax_code             TEXT NOT NULL DEFAULT '',   -- tax items: model.Tax*
  state                TEXT NOT NULL DEFAULT '',   -- state tax items (2-letter code)
  tax_key              TEXT NOT NULL DEFAULT '',   -- ST_EE / ST_ER items: program key from the state tax data (e.g. "SDI")
  pto                  TEXT NOT NULL DEFAULT '',   -- wage items: '' | sick | vacation
  calc                 TEXT NOT NULL DEFAULT 'fixed', -- model.Calc*
  rate                 REAL NOT NULL DEFAULT 0,    -- default amount / percent / per-hour rate / overtime multiplier / tax rate override
  annual_limit         INTEGER,                    -- cents; NULL = no limit
  limit_kind           TEXT NOT NULL DEFAULT 'annual', -- annual | one_time
  match_item_id        INTEGER REFERENCES payroll_items(id),
  match_cap_pct        REAL NOT NULL DEFAULT 0,
  tax_tracking         TEXT NOT NULL DEFAULT 'compensation', -- model.Track*
  w2_box12             TEXT NOT NULL DEFAULT '',
  w2_box14             TEXT NOT NULL DEFAULT '',
  taxability           TEXT NOT NULL DEFAULT '{}', -- {"FIT":true,"SS":true,...}
  supplemental         INTEGER NOT NULL DEFAULT 0,
  not_paid             INTEGER NOT NULL DEFAULT 0, -- reported tips: taxed but not paid in the check
  expense_account_id   INTEGER,                    -- SerieX Books account
  liability_account_id INTEGER,                    -- SerieX Books account
  agency_vendor_id     INTEGER,                    -- SerieX Books vendor
  payment_group        TEXT NOT NULL DEFAULT '',   -- '' = default for the type (see model.DefaultPaymentGroup)
  active               INTEGER NOT NULL DEFAULT 1,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE INDEX ix_payroll_items_type ON payroll_items(type);
CREATE INDEX ix_payroll_items_tax ON payroll_items(tax_code, state);

CREATE TABLE employees (
  id                    INTEGER PRIMARY KEY,
  books_name_id         INTEGER,                  -- SerieX Books "other" name
  first_name            TEXT NOT NULL DEFAULT '',
  middle_name           TEXT NOT NULL DEFAULT '',
  last_name             TEXT NOT NULL DEFAULT '',
  suffix                TEXT NOT NULL DEFAULT '',
  display_name          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  print_as              TEXT NOT NULL DEFAULT '',
  ssn                   TEXT NOT NULL DEFAULT '', -- 9 digits
  birth_date            TEXT NOT NULL DEFAULT '',
  gender                TEXT NOT NULL DEFAULT '',
  address1              TEXT NOT NULL DEFAULT '',
  address2              TEXT NOT NULL DEFAULT '',
  city                  TEXT NOT NULL DEFAULT '',
  state                 TEXT NOT NULL DEFAULT '',
  zip                   TEXT NOT NULL DEFAULT '',
  phone                 TEXT NOT NULL DEFAULT '',
  mobile                TEXT NOT NULL DEFAULT '',
  email                 TEXT NOT NULL DEFAULT '',
  employee_number       TEXT NOT NULL DEFAULT '',
  hire_date             TEXT NOT NULL DEFAULT '',
  original_hire_date    TEXT NOT NULL DEFAULT '',
  release_date          TEXT NOT NULL DEFAULT '',
  employment_type       TEXT NOT NULL DEFAULT 'regular', -- regular | officer | statutory | owner
  pay_schedule_id       INTEGER REFERENCES pay_schedules(id),
  pay_frequency         TEXT NOT NULL DEFAULT 'biweekly',
  class_id              INTEGER,                  -- SerieX Books class
  work_state            TEXT NOT NULL DEFAULT '',
  -- federal Form W-4
  w4_version            TEXT NOT NULL DEFAULT '2020', -- 2020 | pre2020
  fed_filing_status     TEXT NOT NULL DEFAULT 'single',
  w4_step2              INTEGER NOT NULL DEFAULT 0,
  w4_dependents         INTEGER NOT NULL DEFAULT 0, -- cents per year (Step 3)
  w4_other_income       INTEGER NOT NULL DEFAULT 0, -- cents per year (Step 4a)
  w4_deductions         INTEGER NOT NULL DEFAULT 0, -- cents per year (Step 4b)
  w4_extra              INTEGER NOT NULL DEFAULT 0, -- cents per pay period (Step 4c)
  fed_allowances        INTEGER NOT NULL DEFAULT 0, -- 2019-or-earlier W-4
  fed_exempt            INTEGER NOT NULL DEFAULT 0,
  nonresident_alien     INTEGER NOT NULL DEFAULT 0,
  subject_ss            INTEGER NOT NULL DEFAULT 1,
  subject_medicare      INTEGER NOT NULL DEFAULT 1,
  subject_futa          INTEGER NOT NULL DEFAULT 1,
  -- state withholding certificate
  state_filing_status   TEXT NOT NULL DEFAULT '',
  state_allowances      INTEGER NOT NULL DEFAULT 0,
  state_extra           INTEGER NOT NULL DEFAULT 0, -- cents per pay period
  state_exempt          INTEGER NOT NULL DEFAULT 0,
  state_data            TEXT NOT NULL DEFAULT '{}',
  subject_sui           INTEGER NOT NULL DEFAULT 1,
  subject_sdi           INTEGER NOT NULL DEFAULT 1,
  -- direct deposit (recorded for pay stubs and reports; no money is moved)
  dd_enabled            INTEGER NOT NULL DEFAULT 0,
  dd_bank_name          TEXT NOT NULL DEFAULT '',
  dd_routing            TEXT NOT NULL DEFAULT '',
  dd_account            TEXT NOT NULL DEFAULT '',
  dd_account_type       TEXT NOT NULL DEFAULT 'checking',
  -- paid time off settings (model.PTOSettings JSON)
  sick                  TEXT NOT NULL DEFAULT '{}',
  vacation              TEXT NOT NULL DEFAULT '{}',
  notes                 TEXT NOT NULL DEFAULT '',
  active                INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  w4_exempt_year        INTEGER NOT NULL DEFAULT 0, -- year the federal exemption was claimed (expires Feb 15 of the next year); 0 = unknown
  books_sync_error      TEXT NOT NULL DEFAULT ''   -- last problem creating/updating the SerieX Books name ('' = none)
);

-- Default payroll items of an employee (Payroll Info tab).
CREATE TABLE employee_items (
  id           INTEGER PRIMARY KEY,
  employee_id  INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  item_id      INTEGER NOT NULL REFERENCES payroll_items(id),
  seq          INTEGER NOT NULL DEFAULT 0,
  rate         REAL NOT NULL DEFAULT 0,  -- hourly rate / annual salary / amount / percent
  annual_limit INTEGER,                  -- cents; NULL = use the item's limit
  qty          REAL                      -- default hours or quantity per paycheck
);
CREATE INDEX ix_employee_items ON employee_items(employee_id);

-- Paid time off hour adjustments (opening balances, manual corrections).
CREATE TABLE pto_adjustments (
  id          INTEGER PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL, -- sick | vacation
  date        TEXT NOT NULL,
  hours       REAL NOT NULL, -- + adds available hours, - removes
  memo        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);
CREATE INDEX ix_pto_adjustments ON pto_adjustments(employee_id, kind, date);

CREATE TABLE payroll_runs (
  id              INTEGER PRIMARY KEY,
  kind            TEXT NOT NULL DEFAULT 'scheduled', -- scheduled | unscheduled | termination
  pay_schedule_id INTEGER REFERENCES pay_schedules(id) ON DELETE SET NULL,
  period_start    TEXT NOT NULL,
  period_end      TEXT NOT NULL,
  check_date      TEXT NOT NULL,
  bank_account_id INTEGER,
  created_by      TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL
);

CREATE TABLE paychecks (
  id               INTEGER PRIMARY KEY,
  run_id           INTEGER REFERENCES payroll_runs(id) ON DELETE SET NULL,
  kind             TEXT NOT NULL DEFAULT 'regular', -- regular | ytd (Enter Year-to-Date Amounts: never posted, no check)
  employee_id      INTEGER NOT NULL REFERENCES employees(id),
  period_start     TEXT NOT NULL,
  period_end       TEXT NOT NULL,
  check_date       TEXT NOT NULL,
  bank_account_id  INTEGER,                     -- SerieX Books bank account
  check_number     TEXT NOT NULL DEFAULT '',
  to_be_printed    INTEGER NOT NULL DEFAULT 0,
  direct_deposit   INTEGER NOT NULL DEFAULT 0,
  memo             TEXT NOT NULL DEFAULT '',
  class_id         INTEGER,                     -- SerieX Books class
  gross            INTEGER NOT NULL DEFAULT 0,
  not_paid         INTEGER NOT NULL DEFAULT 0,  -- reported tips included in gross but not paid
  deductions       INTEGER NOT NULL DEFAULT 0,
  employee_taxes   INTEGER NOT NULL DEFAULT 0,
  net              INTEGER NOT NULL DEFAULT 0,
  employer_taxes   INTEGER NOT NULL DEFAULT 0,
  contributions    INTEGER NOT NULL DEFAULT 0,
  total_hours      REAL NOT NULL DEFAULT 0,
  sick_accrued     REAL NOT NULL DEFAULT 0,
  sick_used        REAL NOT NULL DEFAULT 0,
  vac_accrued      REAL NOT NULL DEFAULT 0,
  vac_used         REAL NOT NULL DEFAULT 0,
  no_accrual       INTEGER NOT NULL DEFAULT 0,
  inputs           TEXT NOT NULL DEFAULT '{}',  -- snapshot of W-4 / state data / rates used
  voided           INTEGER NOT NULL DEFAULT 0,
  books_txn_id     INTEGER,
  sync_status      TEXT NOT NULL DEFAULT 'pending', -- none | pending | posted | error
  sync_error       TEXT NOT NULL DEFAULT '',
  synced_at        TEXT NOT NULL DEFAULT '',
  created_by       TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX ix_paychecks_employee ON paychecks(employee_id, check_date);
CREATE INDEX ix_paychecks_date ON paychecks(check_date);
CREATE INDEX ix_paychecks_run ON paychecks(run_id);
CREATE INDEX ix_paychecks_sync ON paychecks(sync_status);

CREATE TABLE paycheck_lines (
  id          INTEGER PRIMARY KEY,
  paycheck_id INTEGER NOT NULL REFERENCES paychecks(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  item_id     INTEGER NOT NULL REFERENCES payroll_items(id),
  category    TEXT NOT NULL, -- earning | addition | deduction | contribution | employee_tax | employer_tax
  rate        REAL,
  qty         REAL,
  amount      INTEGER NOT NULL DEFAULT 0,
  wage_base   INTEGER NOT NULL DEFAULT 0, -- taxes: taxable wages of this check (after the annual wage base cap); deductions/contributions: the base used
  subject_wages INTEGER NOT NULL DEFAULT 0, -- taxes: wages subject to the tax this check BEFORE the annual wage base cap
  computed    INTEGER NOT NULL DEFAULT 0, -- amount the program calculated (differs from amount when manual)
  job_name_id INTEGER,                    -- SerieX Books customer:job
  class_id    INTEGER,                    -- SerieX Books class
  manual      INTEGER NOT NULL DEFAULT 0  -- amount typed by the user; kept on recalculation
);
CREATE INDEX ix_paycheck_lines ON paycheck_lines(paycheck_id);
CREATE INDEX ix_paycheck_lines_item ON paycheck_lines(item_id);

CREATE TABLE liability_payments (
  id               INTEGER PRIMARY KEY,
  kind             TEXT NOT NULL DEFAULT 'payment', -- payment | prior (Record Earlier Tax Payments: never posted)
  date             TEXT NOT NULL,
  period_start     TEXT NOT NULL,
  period_end       TEXT NOT NULL,
  agency_vendor_id INTEGER,                 -- SerieX Books vendor
  agency_name      TEXT NOT NULL DEFAULT '', -- cached Books vendor name
  bank_account_id  INTEGER,
  check_number     TEXT NOT NULL DEFAULT '',
  to_be_printed    INTEGER NOT NULL DEFAULT 0,
  method           TEXT NOT NULL DEFAULT 'check', -- check | e-pay
  memo             TEXT NOT NULL DEFAULT '',
  amount           INTEGER NOT NULL DEFAULT 0,
  voided           INTEGER NOT NULL DEFAULT 0,
  books_txn_id     INTEGER,
  sync_status      TEXT NOT NULL DEFAULT 'pending',
  sync_error       TEXT NOT NULL DEFAULT '',
  synced_at        TEXT NOT NULL DEFAULT '',
  created_by       TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX ix_liability_payments_date ON liability_payments(date);

-- kind 'item': pays a payroll item liability. kind 'expense': penalty/interest
-- line posted to account_id (the Expenses tab of a tax payment).
CREATE TABLE liability_payment_lines (
  id         INTEGER PRIMARY KEY,
  payment_id INTEGER NOT NULL REFERENCES liability_payments(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'item',
  item_id    INTEGER REFERENCES payroll_items(id),
  account_id INTEGER,
  amount     INTEGER NOT NULL DEFAULT 0,
  memo       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX ix_liability_payment_lines ON liability_payment_lines(payment_id);
CREATE INDEX ix_liability_payment_lines_item ON liability_payment_lines(item_id);

CREATE TABLE liability_adjustments (
  id               INTEGER PRIMARY KEY,
  date             TEXT NOT NULL,
  effective_date   TEXT NOT NULL,
  employee_id      INTEGER REFERENCES employees(id), -- NULL = company adjustment
  memo             TEXT NOT NULL DEFAULT '',
  affects_accounts INTEGER NOT NULL DEFAULT 1,
  class_id         INTEGER,
  books_txn_id     INTEGER,
  sync_status      TEXT NOT NULL DEFAULT 'pending',
  sync_error       TEXT NOT NULL DEFAULT '',
  synced_at        TEXT NOT NULL DEFAULT '',
  created_by       TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

-- amount: + increases the liability (and the expense for employer items),
-- - decreases it. wage_base: change of the taxable wages of that tax item.
CREATE TABLE liability_adjustment_lines (
  id            INTEGER PRIMARY KEY,
  adjustment_id INTEGER NOT NULL REFERENCES liability_adjustments(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  item_id       INTEGER NOT NULL REFERENCES payroll_items(id),
  amount        INTEGER NOT NULL DEFAULT 0,
  wage_base     INTEGER NOT NULL DEFAULT 0,
  memo          TEXT NOT NULL DEFAULT ''
);
CREATE INDEX ix_liability_adjustment_lines ON liability_adjustment_lines(adjustment_id);

-- Payment frequency / method per liability payment group (Tax Payment Schedule).
CREATE TABLE payment_schedules (
  id               INTEGER PRIMARY KEY,
  payment_group    TEXT NOT NULL UNIQUE,
  agency_vendor_id INTEGER,
  frequency        TEXT NOT NULL, -- semiweekly | monthly | quarterly | annually | after_payroll
  method           TEXT NOT NULL DEFAULT 'check',
  updated_at       TEXT NOT NULL
);

-- Saved tax forms (user-entered values and the snapshot at filing).
CREATE TABLE form_filings (
  id         INTEGER PRIMARY KEY,
  form       TEXT NOT NULL, -- 941 | 940 | W-2 | STATE-UI
  year       INTEGER NOT NULL,
  period     TEXT NOT NULL, -- Q1..Q4 | Y
  state      TEXT NOT NULL DEFAULT '',
  data       TEXT NOT NULL DEFAULT '{}', -- {"overrides": {...}, "snapshot": {...}}
  status     TEXT NOT NULL DEFAULT 'draft', -- draft | filed
  filed_at   TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_form_filings ON form_filings(form, year, period, state);

-- Company overrides of the built-in tax tables (Tax Tables window).
CREATE TABLE tax_overrides (
  id         INTEGER PRIMARY KEY,
  year       INTEGER NOT NULL,
  scope      TEXT NOT NULL, -- federal | state
  state      TEXT NOT NULL DEFAULT '',
  data       TEXT NOT NULL, -- JSON merged over the built-in table
  updated_by TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_tax_overrides ON tax_overrides(year, scope, state);

CREATE TABLE audit_log (
  id        INTEGER PRIMARY KEY,
  ts        TEXT NOT NULL,
  user      TEXT NOT NULL DEFAULT '',
  action    TEXT NOT NULL,          -- add | modify | delete | void | post | view_ssn | file_form | setup ...
  entity    TEXT NOT NULL DEFAULT '', -- paycheck | liability_payment | adjustment | employee | item | company ...
  entity_id INTEGER,
  summary   TEXT NOT NULL DEFAULT '',
  details   TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX ix_audit_ts ON audit_log(ts);
CREATE INDEX ix_audit_entity ON audit_log(entity, entity_id);

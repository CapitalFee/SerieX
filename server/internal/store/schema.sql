-- SerieX Books company file schema (SQLite).
-- Conventions:
--   * Money columns are INTEGER cents. Quantities, rates and unit costs are REAL.
--   * Dates are TEXT 'YYYY-MM-DD'. Timestamps are TEXT RFC3339.
--   * gl_entries.amount is signed: debit positive, credit negative.

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE company (
  id                      INTEGER PRIMARY KEY CHECK (id = 1),
  name                    TEXT NOT NULL,
  legal_name              TEXT NOT NULL DEFAULT '',
  address1                TEXT NOT NULL DEFAULT '',
  address2                TEXT NOT NULL DEFAULT '',
  city                    TEXT NOT NULL DEFAULT '',
  state                   TEXT NOT NULL DEFAULT '',
  zip                     TEXT NOT NULL DEFAULT '',
  country                 TEXT NOT NULL DEFAULT 'US',
  phone                   TEXT NOT NULL DEFAULT '',
  fax                     TEXT NOT NULL DEFAULT '',
  email                   TEXT NOT NULL DEFAULT '',
  website                 TEXT NOT NULL DEFAULT '',
  tax_id                  TEXT NOT NULL DEFAULT '',
  industry                TEXT NOT NULL DEFAULT '',
  entity_type             TEXT NOT NULL DEFAULT '',
  fiscal_year_start_month INTEGER NOT NULL DEFAULT 1,
  tax_year_start_month    INTEGER NOT NULL DEFAULT 1,
  closing_date            TEXT NOT NULL DEFAULT '',
  closing_password_hash   TEXT NOT NULL DEFAULT '',
  prefs                   TEXT NOT NULL DEFAULT '{}',
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);

CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL DEFAULT '',
  is_admin      INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);

-- Generic simple lists: class, customer_type, vendor_type, job_type, terms,
-- payment_method, ship_via, customer_message, sales_rep.
CREATE TABLE list_entries (
  id         INTEGER PRIMARY KEY,
  list       TEXT NOT NULL,
  name       TEXT NOT NULL COLLATE NOCASE,
  parent_id  INTEGER REFERENCES list_entries(id),
  active     INTEGER NOT NULL DEFAULT 1,
  data       TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT ''   -- compared on save: a save based on an older copy is refused
);
CREATE UNIQUE INDEX ux_list_entries ON list_entries(list, IFNULL(parent_id, 0), name);

CREATE TABLE accounts (
  id               INTEGER PRIMARY KEY,
  name             TEXT NOT NULL COLLATE NOCASE,
  number           TEXT NOT NULL DEFAULT '',
  type             TEXT NOT NULL,
  parent_id        INTEGER REFERENCES accounts(id),
  description      TEXT NOT NULL DEFAULT '',
  note             TEXT NOT NULL DEFAULT '',
  bank_acct_number TEXT NOT NULL DEFAULT '',
  routing_number   TEXT NOT NULL DEFAULT '',
  tax_line         TEXT NOT NULL DEFAULT '',
  special          TEXT NOT NULL DEFAULT '',
  active           INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_accounts_name ON accounts(IFNULL(parent_id, 0), name);
CREATE INDEX ix_accounts_special ON accounts(special);
CREATE INDEX ix_accounts_type ON accounts(type);

-- Customers (and their jobs), vendors and other names share one table: a
-- name must be unique across all of them.
CREATE TABLE names (
  id                  INTEGER PRIMARY KEY,
  kind                TEXT NOT NULL CHECK (kind IN ('customer', 'vendor', 'other')),
  name                TEXT NOT NULL COLLATE NOCASE,
  parent_id           INTEGER REFERENCES names(id),
  company_name        TEXT NOT NULL DEFAULT '',
  salutation          TEXT NOT NULL DEFAULT '',
  first_name          TEXT NOT NULL DEFAULT '',
  middle_name         TEXT NOT NULL DEFAULT '',
  last_name           TEXT NOT NULL DEFAULT '',
  job_title           TEXT NOT NULL DEFAULT '',
  phone               TEXT NOT NULL DEFAULT '',
  alt_phone           TEXT NOT NULL DEFAULT '',
  mobile              TEXT NOT NULL DEFAULT '',
  fax                 TEXT NOT NULL DEFAULT '',
  email               TEXT NOT NULL DEFAULT '',
  cc_email            TEXT NOT NULL DEFAULT '',
  website             TEXT NOT NULL DEFAULT '',
  bill_line1          TEXT NOT NULL DEFAULT '',
  bill_line2          TEXT NOT NULL DEFAULT '',
  bill_line3          TEXT NOT NULL DEFAULT '',
  bill_city           TEXT NOT NULL DEFAULT '',
  bill_state          TEXT NOT NULL DEFAULT '',
  bill_zip            TEXT NOT NULL DEFAULT '',
  bill_country        TEXT NOT NULL DEFAULT '',
  ship_line1          TEXT NOT NULL DEFAULT '',
  ship_line2          TEXT NOT NULL DEFAULT '',
  ship_line3          TEXT NOT NULL DEFAULT '',
  ship_city           TEXT NOT NULL DEFAULT '',
  ship_state          TEXT NOT NULL DEFAULT '',
  ship_zip            TEXT NOT NULL DEFAULT '',
  ship_country        TEXT NOT NULL DEFAULT '',
  account_number      TEXT NOT NULL DEFAULT '',
  terms_id            INTEGER REFERENCES list_entries(id),
  credit_limit        INTEGER,
  type_id             INTEGER REFERENCES list_entries(id),
  rep_id              INTEGER REFERENCES list_entries(id),
  payment_method_id   INTEGER REFERENCES list_entries(id),
  taxable             INTEGER NOT NULL DEFAULT 1,
  tax_item_id         INTEGER REFERENCES items(id),
  resale_number       TEXT NOT NULL DEFAULT '',
  print_on_check_as   TEXT NOT NULL DEFAULT '',
  tax_ident           TEXT NOT NULL DEFAULT '',
  is_1099             INTEGER NOT NULL DEFAULT 0,
  prefill_account_ids TEXT NOT NULL DEFAULT '[]',
  job_status          TEXT NOT NULL DEFAULT '',
  job_start_date      TEXT NOT NULL DEFAULT '',
  job_projected_end   TEXT NOT NULL DEFAULT '',
  job_end_date        TEXT NOT NULL DEFAULT '',
  job_description     TEXT NOT NULL DEFAULT '',
  job_type_id         INTEGER REFERENCES list_entries(id),
  notes               TEXT NOT NULL DEFAULT '',
  active              INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_names_name ON names(IFNULL(parent_id, 0), name);
CREATE INDEX ix_names_kind ON names(kind);

CREATE TABLE items (
  id                   INTEGER PRIMARY KEY,
  type                 TEXT NOT NULL,
  name                 TEXT NOT NULL COLLATE NOCASE,
  parent_id            INTEGER REFERENCES items(id),
  mpn                  TEXT NOT NULL DEFAULT '',
  description          TEXT NOT NULL DEFAULT '',
  purchase_description TEXT NOT NULL DEFAULT '',
  is_purchased         INTEGER NOT NULL DEFAULT 0,
  sales_price          REAL NOT NULL DEFAULT 0,
  rate_is_percent      INTEGER NOT NULL DEFAULT 0,
  cost                 REAL NOT NULL DEFAULT 0,
  income_account_id    INTEGER REFERENCES accounts(id),
  expense_account_id   INTEGER REFERENCES accounts(id),
  asset_account_id     INTEGER REFERENCES accounts(id),
  preferred_vendor_id  INTEGER REFERENCES names(id),
  taxable              INTEGER NOT NULL DEFAULT 0,
  reorder_point        REAL,
  max_qty              REAL,
  qty_on_hand          REAL NOT NULL DEFAULT 0,
  avg_cost             REAL NOT NULL DEFAULT 0,
  asset_value          INTEGER NOT NULL DEFAULT 0,
  tax_rate             REAL NOT NULL DEFAULT 0,
  tax_agency_id        INTEGER REFERENCES names(id),
  payment_method_id    INTEGER REFERENCES list_entries(id),
  deposit_account_id   INTEGER REFERENCES accounts(id),
  active               INTEGER NOT NULL DEFAULT 1,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_items_name ON items(IFNULL(parent_id, 0), name);
CREATE INDEX ix_items_type ON items(type);

-- Members of a Group item or a Sales Tax Group item.
CREATE TABLE item_group_lines (
  id       INTEGER PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  item_id  INTEGER NOT NULL REFERENCES items(id),
  qty      REAL NOT NULL DEFAULT 1,
  seq      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ix_item_group_lines ON item_group_lines(group_id);

CREATE TABLE txns (
  id                  INTEGER PRIMARY KEY,
  type                TEXT NOT NULL,
  ref_number          TEXT NOT NULL DEFAULT '',
  date                TEXT NOT NULL,
  name_id             INTEGER REFERENCES names(id),
  account_id          INTEGER REFERENCES accounts(id),
  ar_ap_account_id    INTEGER REFERENCES accounts(id),
  to_account_id       INTEGER REFERENCES accounts(id),
  amount              INTEGER NOT NULL DEFAULT 0,
  open_balance        INTEGER NOT NULL DEFAULT 0,
  due_date            TEXT NOT NULL DEFAULT '',
  ship_date           TEXT NOT NULL DEFAULT '',
  terms_id            INTEGER REFERENCES list_entries(id),
  class_id            INTEGER REFERENCES list_entries(id),
  rep_id              INTEGER REFERENCES list_entries(id),
  ship_via_id         INTEGER REFERENCES list_entries(id),
  customer_message_id INTEGER REFERENCES list_entries(id),
  payment_method_id   INTEGER REFERENCES list_entries(id),
  fob                 TEXT NOT NULL DEFAULT '',
  po_number           TEXT NOT NULL DEFAULT '',
  memo                TEXT NOT NULL DEFAULT '',
  bill_address        TEXT NOT NULL DEFAULT '',
  ship_address        TEXT NOT NULL DEFAULT '',
  tax_item_id         INTEGER REFERENCES items(id),
  tax_rate            REAL NOT NULL DEFAULT 0,
  tax_split           TEXT NOT NULL DEFAULT '',   -- JSON [{item, rate, agency}] of the tax item(s) when the rate was set
  tax_amount          INTEGER NOT NULL DEFAULT 0,
  subtotal            INTEGER NOT NULL DEFAULT 0,
  to_be_printed       INTEGER NOT NULL DEFAULT 0,
  to_be_emailed       INTEGER NOT NULL DEFAULT 0,
  is_pending          INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT '',
  voided              INTEGER NOT NULL DEFAULT 0,
  cash_back_account_id INTEGER REFERENCES accounts(id),
  cash_back_amount    INTEGER NOT NULL DEFAULT 0,
  cash_back_memo      TEXT NOT NULL DEFAULT '',
  template            TEXT NOT NULL DEFAULT '',
  extra               TEXT NOT NULL DEFAULT '{}',
  created_by          TEXT NOT NULL DEFAULT '',
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX ix_txns_type_date ON txns(type, date);
CREATE INDEX ix_txns_date ON txns(date);
CREATE INDEX ix_txns_name ON txns(name_id);
CREATE INDEX ix_txns_account ON txns(account_id);

CREATE TABLE txn_lines (
  id                INTEGER PRIMARY KEY,
  txn_id            INTEGER NOT NULL REFERENCES txns(id) ON DELETE CASCADE,
  seq               INTEGER NOT NULL,
  kind              TEXT NOT NULL DEFAULT 'item',
  item_id           INTEGER REFERENCES items(id),
  account_id        INTEGER REFERENCES accounts(id),
  description       TEXT NOT NULL DEFAULT '',
  qty               REAL,
  rate              REAL,
  rate_is_percent   INTEGER NOT NULL DEFAULT 0,
  amount            INTEGER NOT NULL DEFAULT 0,
  class_id          INTEGER REFERENCES list_entries(id),
  name_id           INTEGER REFERENCES names(id),
  billable          INTEGER NOT NULL DEFAULT 0,
  billed_txn_id     INTEGER REFERENCES txns(id) ON DELETE SET NULL,
  taxable           INTEGER NOT NULL DEFAULT 0,
  service_date      TEXT NOT NULL DEFAULT '',
  payment_method_id INTEGER REFERENCES list_entries(id),
  ref_number        TEXT NOT NULL DEFAULT '',
  linked_txn_id     INTEGER REFERENCES txns(id) ON DELETE SET NULL,
  linked_line_id    INTEGER REFERENCES txn_lines(id) ON DELETE SET NULL,
  received_qty      REAL NOT NULL DEFAULT 0,
  closed            INTEGER NOT NULL DEFAULT 0,
  cogs              INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ix_txn_lines_txn ON txn_lines(txn_id);
CREATE INDEX ix_txn_lines_linked ON txn_lines(linked_txn_id);
CREATE INDEX ix_txn_lines_linked_line ON txn_lines(linked_line_id);
CREATE INDEX ix_txn_lines_item ON txn_lines(item_id);
CREATE INDEX ix_txn_lines_billed ON txn_lines(billed_txn_id);

-- Applications of payments and credits.
--   from_txn_id: the payment / credit that is being used
--   to_txn_id:   the invoice / bill / credit being paid or consumed
--   owner_txn_id: the transaction whose save created this row (deleted/rebuilt with it)
CREATE TABLE txn_links (
  id                  INTEGER PRIMARY KEY,
  from_txn_id         INTEGER NOT NULL REFERENCES txns(id) ON DELETE CASCADE,
  to_txn_id           INTEGER NOT NULL REFERENCES txns(id) ON DELETE CASCADE,
  owner_txn_id        INTEGER NOT NULL REFERENCES txns(id) ON DELETE CASCADE,
  amount              INTEGER NOT NULL DEFAULT 0,
  discount            INTEGER NOT NULL DEFAULT 0,
  discount_account_id INTEGER REFERENCES accounts(id),
  date                TEXT NOT NULL
);
CREATE INDEX ix_txn_links_from ON txn_links(from_txn_id);
CREATE INDEX ix_txn_links_to ON txn_links(to_txn_id);
CREATE INDEX ix_txn_links_owner ON txn_links(owner_txn_id);

CREATE TABLE gl_entries (
  id           INTEGER PRIMARY KEY,
  txn_id       INTEGER NOT NULL REFERENCES txns(id) ON DELETE CASCADE,
  line_id      INTEGER REFERENCES txn_lines(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL DEFAULT 0,
  date         TEXT NOT NULL,
  account_id   INTEGER NOT NULL REFERENCES accounts(id),
  amount       INTEGER NOT NULL,
  name_id      INTEGER REFERENCES names(id),
  class_id     INTEGER REFERENCES list_entries(id),
  item_id      INTEGER REFERENCES items(id),
  memo         TEXT NOT NULL DEFAULT '',
  role         TEXT NOT NULL DEFAULT '',
  cleared      TEXT NOT NULL DEFAULT '',
  reconcile_id INTEGER REFERENCES reconciliations(id) ON DELETE SET NULL
);
CREATE INDEX ix_gl_account_date ON gl_entries(account_id, date);
CREATE INDEX ix_gl_txn ON gl_entries(txn_id);
CREATE INDEX ix_gl_name ON gl_entries(name_id);
CREATE INDEX ix_gl_date ON gl_entries(date);
CREATE INDEX ix_gl_line ON gl_entries(line_id);

-- Inventory quantity/value movements. qty and value are signed (+ in, - out).
-- cost_known = 1 when value is given by the transaction (purchases, value
-- adjustments, vendor credits); 0 when it is computed at average cost (sales,
-- credit memo returns, quantity-only adjustments).
CREATE TABLE inventory_moves (
  id         INTEGER PRIMARY KEY,
  txn_id     INTEGER NOT NULL REFERENCES txns(id) ON DELETE CASCADE,
  line_id    INTEGER REFERENCES txn_lines(id) ON DELETE CASCADE,
  item_id    INTEGER NOT NULL REFERENCES items(id),
  date       TEXT NOT NULL,
  qty        REAL NOT NULL,
  value      INTEGER NOT NULL DEFAULT 0,
  cost_known INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX ix_inventory_moves_item ON inventory_moves(item_id, date);
CREATE INDEX ix_inventory_moves_txn ON inventory_moves(txn_id);
CREATE INDEX ix_inventory_moves_line ON inventory_moves(line_id);

CREATE TABLE reconciliations (
  id                INTEGER PRIMARY KEY,
  account_id        INTEGER NOT NULL REFERENCES accounts(id),
  statement_date    TEXT NOT NULL,
  beginning_balance INTEGER NOT NULL,
  ending_balance    INTEGER NOT NULL,
  cleared_balance   INTEGER NOT NULL,
  service_charge_txn_id INTEGER REFERENCES txns(id) ON DELETE SET NULL,
  interest_txn_id   INTEGER REFERENCES txns(id) ON DELETE SET NULL,
  adjustment_txn_id INTEGER REFERENCES txns(id) ON DELETE SET NULL,
  completed_at      TEXT NOT NULL,
  completed_by      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX ix_reconciliations_account ON reconciliations(account_id, statement_date);

-- What each reconciliation cleared, with the amounts as reconciled (natural
-- sign of the account). Kept when the entries are later changed, unmarked or
-- deleted, so old reports still add up and the changes can be listed.
CREATE TABLE IF NOT EXISTS reconcile_items (
  id           INTEGER PRIMARY KEY,
  reconcile_id INTEGER NOT NULL REFERENCES reconciliations(id) ON DELETE CASCADE,
  gl_id        INTEGER NOT NULL,
  txn_id       INTEGER NOT NULL,
  txn_type     TEXT NOT NULL DEFAULT '',
  type_label   TEXT NOT NULL DEFAULT '',
  date         TEXT NOT NULL DEFAULT '',
  ref_number   TEXT NOT NULL DEFAULT '',
  name         TEXT NOT NULL DEFAULT '',
  memo         TEXT NOT NULL DEFAULT '',
  amount       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_reconcile_items ON reconcile_items(reconcile_id);

-- In-progress reconciliation header values ("Leave" keeps these).
CREATE TABLE reconcile_drafts (
  account_id     INTEGER PRIMARY KEY REFERENCES accounts(id),
  statement_date TEXT NOT NULL,
  ending_balance INTEGER NOT NULL,
  data           TEXT NOT NULL DEFAULT '{}',
  updated_at     TEXT NOT NULL
);

CREATE TABLE bank_feed_items (
  id           INTEGER PRIMARY KEY,
  account_id   INTEGER NOT NULL REFERENCES accounts(id),
  batch_id     TEXT NOT NULL DEFAULT '',
  fitid        TEXT NOT NULL DEFAULT '',
  date         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  amount       INTEGER NOT NULL,
  check_number TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'new',
  txn_id       INTEGER REFERENCES txns(id) ON DELETE SET NULL,
  raw          TEXT NOT NULL DEFAULT '',
  imported_at  TEXT NOT NULL
);
CREATE INDEX ix_bank_feed_items_account ON bank_feed_items(account_id, status);
CREATE INDEX ix_bank_feed_items_txn ON bank_feed_items(txn_id);
CREATE UNIQUE INDEX ux_bank_feed_fitid ON bank_feed_items(account_id, fitid) WHERE fitid <> '';

-- Per-account bank file import choices (CSV: reverse the amount signs, date order).
CREATE TABLE IF NOT EXISTS bank_feed_settings (
  account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  flip_signs INTEGER NOT NULL DEFAULT 0,
  date_order TEXT NOT NULL DEFAULT ''
);

CREATE TABLE bank_rules (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  account_id INTEGER REFERENCES accounts(id),
  match_text TEXT NOT NULL,
  direction  TEXT NOT NULL DEFAULT 'any',
  rename_to  TEXT NOT NULL DEFAULT '',
  name_id    INTEGER REFERENCES names(id),
  target_account_id INTEGER REFERENCES accounts(id),
  priority   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE memorized_txns (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE COLLATE NOCASE,
  txn_type        TEXT NOT NULL,
  template        TEXT NOT NULL,
  schedule        TEXT NOT NULL DEFAULT 'none',
  frequency       TEXT NOT NULL DEFAULT 'never',
  next_date       TEXT NOT NULL DEFAULT '',
  days_in_advance INTEGER NOT NULL DEFAULT 0,
  remaining       INTEGER,
  group_name      TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL
);

CREATE TABLE memorized_reports (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  report_key TEXT NOT NULL,
  params     TEXT NOT NULL DEFAULT '{}',
  group_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE budgets (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  fiscal_year INTEGER NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'pl',
  criteria    TEXT NOT NULL DEFAULT 'none',
  created_at  TEXT NOT NULL
);

-- amounts: JSON array of 12 integers (cents), one per fiscal month.
CREATE TABLE budget_lines (
  id         INTEGER PRIMARY KEY,
  budget_id  INTEGER NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  class_id   INTEGER REFERENCES list_entries(id),
  name_id    INTEGER REFERENCES names(id),
  amounts    TEXT NOT NULL DEFAULT '[0,0,0,0,0,0,0,0,0,0,0,0]'
);
CREATE INDEX ix_budget_lines ON budget_lines(budget_id);

CREATE TABLE todos (
  id         INTEGER PRIMARY KEY,
  title      TEXT NOT NULL,
  notes      TEXT NOT NULL DEFAULT '',
  due_date   TEXT NOT NULL DEFAULT '',
  name_id    INTEGER REFERENCES names(id) ON DELETE SET NULL,
  done       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY,
  ts         TEXT NOT NULL,
  user       TEXT NOT NULL DEFAULT '',
  action     TEXT NOT NULL,
  txn_id     INTEGER,
  txn_type   TEXT NOT NULL DEFAULT '',
  ref_number TEXT NOT NULL DEFAULT '',
  txn_date   TEXT NOT NULL DEFAULT '',
  name       TEXT NOT NULL DEFAULT '',
  amount     INTEGER NOT NULL DEFAULT 0,
  details    TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX ix_audit_ts ON audit_log(ts);
CREATE INDEX ix_audit_txn ON audit_log(txn_id);

-- Backups made of this file (automatic, on close, Back up now, before a
-- restore, downloads). Rows of another file_uid came with a copy or a
-- restored backup and are ignored. Settings: meta.backup_settings (JSON);
-- meta.change_seq counts the write transactions that changed the file.
CREATE TABLE IF NOT EXISTS backup_log (
  id         INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT '',
  path       TEXT NOT NULL DEFAULT '',
  size       INTEGER NOT NULL DEFAULT 0,
  change_seq INTEGER NOT NULL DEFAULT 0,
  file_uid   TEXT NOT NULL DEFAULT ''
);

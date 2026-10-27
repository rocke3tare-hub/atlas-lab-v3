-- Atlas v2 schema (SQLite). Money is INTEGER minor units of the row's currency;
-- odds are INTEGER thousandths; percentages are INTEGER basis points.

CREATE TABLE clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','closed')),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','shareholder')),
  client_id TEXT REFERENCES clients(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_login_at TEXT,
  CHECK ((role = 'shareholder') = (client_id IS NOT NULL))
);

CREATE TABLE admin_clients (
  user_id TEXT NOT NULL REFERENCES users(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  PRIMARY KEY (user_id, client_id)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  succeeded INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_login_attempts_email ON login_attempts(email, created_at);
CREATE INDEX idx_login_attempts_ip ON login_attempts(ip_hash, created_at);

CREATE TABLE shareholders (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL UNIQUE REFERENCES clients(id),
  investment INTEGER NOT NULL CHECK (investment > 0),
  currency TEXT NOT NULL,
  profit_share_bp INTEGER NOT NULL CHECK (profit_share_bp BETWEEN 0 AND 10000),
  invested_on TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE capital_contributions (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  requested_by TEXT NOT NULL REFERENCES users(id),
  decided_by TEXT REFERENCES users(id),
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Account holders (v1 "users"): people under a client who hold money and platform accounts.
CREATE TABLE holders (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  allocated_capital INTEGER NOT NULL DEFAULT 0 CHECK (allocated_capital >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE platforms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  code TEXT NOT NULL UNIQUE,
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Versioned rules: the version in force is the latest effective_from <= now.
CREATE TABLE platform_rules (
  id TEXT PRIMARY KEY,
  platform_id TEXT NOT NULL REFERENCES platforms(id),
  effective_from TEXT NOT NULL,
  min_odds INTEGER NOT NULL DEFAULT 1000,
  max_odds INTEGER NOT NULL DEFAULT 0,
  max_stake INTEGER NOT NULL DEFAULT 0,
  max_payout INTEGER NOT NULL DEFAULT 0,
  turnover_bp INTEGER NOT NULL DEFAULT 10000,
  turnover_base TEXT NOT NULL DEFAULT 'deposit' CHECK (turnover_base IN ('deposit','bonus','deposit_plus_bonus')),
  max_outcomes_per_event INTEGER NOT NULL DEFAULT 1 CHECK (max_outcomes_per_event >= 1),
  multiple_accounts_per_outcome INTEGER NOT NULL DEFAULT 0,
  manual_approval INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (platform_id, effective_from)
);

-- Wallets, banks and platform accounts. Balances are derived from movements.
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  holder_id TEXT NOT NULL REFERENCES holders(id),
  kind TEXT NOT NULL CHECK (kind IN ('wallet','bank','platform')),
  platform_id TEXT REFERENCES platforms(id),
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  username TEXT,
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','closed')),
  kyc_status TEXT NOT NULL DEFAULT 'verified' CHECK (kyc_status IN ('verified','pending','rejected')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK ((kind = 'platform') = (platform_id IS NOT NULL))
);
-- One wallet and one bank account per holder per currency (v1 allowed one of each in total,
-- which made rial-to-dollar exchanges impossible), and one account per platform.
CREATE UNIQUE INDEX idx_one_wallet_bank ON accounts(holder_id, kind, currency) WHERE kind IN ('wallet','bank');
CREATE UNIQUE INDEX idx_one_platform_account ON accounts(holder_id, platform_id) WHERE kind = 'platform';

-- Append-only money journal. A NULL side means "outside the books".
CREATE TABLE movements (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  kind TEXT NOT NULL CHECK (kind IN ('opening','capital','transfer','exchange','funding','withdrawal','stake','payout','income','cost','shareholder_payment','adjustment','reversal')),
  from_account_id TEXT REFERENCES accounts(id),
  to_account_id TEXT REFERENCES accounts(id),
  amount_out INTEGER NOT NULL DEFAULT 0 CHECK (amount_out >= 0),
  amount_in INTEGER NOT NULL DEFAULT 0 CHECK (amount_in >= 0),
  fee INTEGER NOT NULL DEFAULT 0 CHECK (fee >= 0),
  currency_out TEXT,
  currency_in TEXT,
  occurred_on TEXT NOT NULL,
  note TEXT,
  reference TEXT,
  source_type TEXT,
  source_id TEXT,
  reverses_id TEXT REFERENCES movements(id),
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (from_account_id IS NOT NULL OR to_account_id IS NOT NULL),
  CHECK (from_account_id IS NULL OR from_account_id <> COALESCE(to_account_id, '')),
  CHECK ((from_account_id IS NULL) = (currency_out IS NULL)),
  CHECK ((to_account_id IS NULL) = (currency_in IS NULL))
);
CREATE INDEX idx_movements_from ON movements(from_account_id);
CREATE INDEX idx_movements_to ON movements(to_account_id);
CREATE INDEX idx_movements_client_date ON movements(client_id, occurred_on);
CREATE INDEX idx_movements_source ON movements(source_type, source_id);
CREATE UNIQUE INDEX idx_one_reversal ON movements(reverses_id) WHERE reverses_id IS NOT NULL;

CREATE TABLE bonus_credits (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  kind TEXT NOT NULL CHECK (kind IN ('bonus','free_bet')),
  amount INTEGER NOT NULL CHECK (amount > 0),
  note TEXT,
  credited_on TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE withdrawals (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  platform_account_id TEXT NOT NULL REFERENCES accounts(id),
  destination_account_id TEXT NOT NULL REFERENCES accounts(id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  requested_on TEXT NOT NULL,
  expected_on TEXT,
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','delayed','verification','problem','received','cancelled')),
  reason TEXT,
  received_amount INTEGER,
  received_on TEXT,
  movement_id TEXT REFERENCES movements(id),
  created_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_withdrawals_status ON withdrawals(status);

CREATE TABLE operations (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planning' CHECK (status IN ('planning','live','closed')),
  notes TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES operations(id),
  name TEXT NOT NULL,
  market_type TEXT NOT NULL CHECK (market_type IN ('two_way','three_way')),
  starts_at TEXT,
  result TEXT CHECK (result IN ('team1','draw','team2','void')),
  settled_at TEXT,
  plan TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE bets (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  outcome TEXT NOT NULL,
  odds INTEGER NOT NULL CHECK (odds > 1000),
  stake INTEGER NOT NULL CHECK (stake > 0),
  stake_type TEXT NOT NULL CHECK (stake_type IN ('cash','bonus','free_bet')),
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','placed','won','lost','void','cancelled')),
  payout INTEGER,
  rule_id TEXT REFERENCES platform_rules(id),
  approval_note TEXT,
  approved_by TEXT REFERENCES users(id),
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  placed_at TEXT,
  settled_at TEXT
);
CREATE INDEX idx_bets_account ON bets(account_id, status);
CREATE INDEX idx_bets_event ON bets(event_id);

CREATE TABLE mixes (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  cash_stake INTEGER NOT NULL DEFAULT 0 CHECK (cash_stake >= 0),
  bonus_stake INTEGER NOT NULL DEFAULT 0 CHECK (bonus_stake >= 0),
  free_bet_stake INTEGER NOT NULL DEFAULT 0 CHECK (free_bet_stake >= 0),
  data TEXT NOT NULL,
  settled INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE shareholder_payments (
  id TEXT PRIMARY KEY,
  shareholder_id TEXT NOT NULL REFERENCES shareholders(id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL,
  from_account_id TEXT REFERENCES accounts(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','failed','cancelled')),
  note TEXT,
  movement_id TEXT REFERENCES movements(id),
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  client_id TEXT REFERENCES clients(id),
  title TEXT NOT NULL,
  detail TEXT,
  source_type TEXT,
  source_id TEXT,
  assignee_id TEXT REFERENCES users(id),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
  due_on TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','dismissed')),
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  closed_at TEXT
);
CREATE UNIQUE INDEX idx_one_open_task_per_source ON tasks(source_type, source_id) WHERE status = 'open' AND source_id IS NOT NULL;

CREATE TABLE questions (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  subject TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE question_messages (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES questions(id),
  body TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT,
  user_id TEXT,
  role TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  before_values TEXT,
  after_values TEXT,
  reason TEXT,
  request_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_audit_client ON audit_events(client_id, id);

CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit_events are immutable'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit_events are immutable'); END;
CREATE TRIGGER movements_no_update BEFORE UPDATE ON movements BEGIN SELECT RAISE(ABORT, 'movements are append-only; post a reversal'); END;
CREATE TRIGGER movements_no_delete BEFORE DELETE ON movements BEGIN SELECT RAISE(ABORT, 'movements are append-only; post a reversal'); END;
CREATE TRIGGER bonus_no_update BEFORE UPDATE ON bonus_credits BEGIN SELECT RAISE(ABORT, 'bonus credits are append-only'); END;
CREATE TRIGGER bonus_no_delete BEFORE DELETE ON bonus_credits BEGIN SELECT RAISE(ABORT, 'bonus credits are append-only'); END;

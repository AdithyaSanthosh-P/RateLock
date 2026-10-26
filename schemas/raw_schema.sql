-- Fresh-volume schema. Same end result as running schemas/migrations/001_contention.sql
-- on top of the old tables, so the migration is still safe to re-run.

CREATE TABLE tiers (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) UNIQUE NOT NULL,
  tokens_per_hour INT NOT NULL,
  burst INT                            -- bucket size, NULL means use tokens_per_hour
);

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(255) UNIQUE NOT NULL,
  api_key VARCHAR(255) UNIQUE NOT NULL,
  tier_id INT NOT NULL,
  FOREIGN KEY (tier_id) REFERENCES tiers(id)
);

CREATE TABLE usage_logs (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL,
  endpoint VARCHAR(255) NOT NULL,
  tokens_deducted INT NOT NULL,
  allowed BOOLEAN NOT NULL,
  latency_ms INT,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  status_code INT,
  reason TEXT,                         -- NULL, 'rate', 'contention_debt', 'acquire_timeout' or 'fail_open'
  overhead_us INT,                     -- time spent in the limiter
  handler_ms NUMERIC,                  -- time spent in the route handler
  cost NUMERIC,
  debt_at_admit NUMERIC,
  policy TEXT,
  run_id TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX idx_usage_logs_user_id ON usage_logs(user_id);
CREATE INDEX idx_usage_logs_endpoint ON usage_logs(endpoint);
CREATE INDEX idx_usage_logs_timestamp ON usage_logs(timestamp);
CREATE INDEX usage_logs_run ON usage_logs(run_id);

CREATE TABLE endpoint_costs (
  endpoint VARCHAR(255) PRIMARY KEY,
  base_token_cost INT NOT NULL DEFAULT 1,
  token_cost INT NOT NULL DEFAULT 1,
  expected_latency_ms FLOAT NOT NULL DEFAULT 50,
  avg_latency_ms FLOAT,
  sample_count INT DEFAULT 0,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  static_hold_ms NUMERIC,              -- normal hold time of the endpoint (static baseline)
  live_hold_ms NUMERIC                 -- last live baseline, for dashboards
);

-- one row per rate limited endpoint
-- expected_latency_ms is at least 5 because the calibrator divides by it
INSERT INTO endpoint_costs (endpoint, base_token_cost, token_cost, expected_latency_ms, static_hold_ms) VALUES
  ('endpoint-a',  1, 1, 5,    5),
  ('demo.cheap',  1, 1, 5,    5),
  ('demo.slow',   1, 1, 2000, 2000),
  ('demo.txn',    1, 1, 50,   50),
  ('demo.hotrow', 1, 1, 10,   10),
  ('demo.cpu',    1, 1, 5,    0);

-- one row per connection hold in the pool
CREATE TABLE pool_holds (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL,
  policy TEXT NOT NULL,
  api_key TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL,
  hold_ms NUMERIC NOT NULL,
  wait_ms NUMERIC NOT NULL,            -- how long this request waited before getting the connection
  imposed_ms NUMERIC NOT NULL,         -- waiting this hold caused for others
  overstay_ms NUMERIC NOT NULL,        -- max(0, hold_ms - gamma * baseline_ms)
  baseline_ms NUMERIC NOT NULL,        -- baseline used (0 in whole mode)
  debit_tokens NUMERIC NOT NULL DEFAULT 0,
  credit_tokens NUMERIC NOT NULL DEFAULT 0
);

CREATE INDEX pool_holds_endpoint_ts ON pool_holds(endpoint, acquired_at);
CREATE INDEX pool_holds_run ON pool_holds(run_id);

-- single row that the demo routes fight over
CREATE TABLE hot_rows (
  id INT PRIMARY KEY,
  v BIGINT NOT NULL DEFAULT 0
);

INSERT INTO hot_rows (id, v) VALUES (1, 0);

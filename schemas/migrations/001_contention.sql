-- 001: contention-debit support (see docs/plan/contracts.md section 4).
-- Idempotent: safe to re-run against a database that already has parts of it.

ALTER TABLE tiers ADD COLUMN IF NOT EXISTS burst integer;           -- bucket cap; NULL -> use tokens_per_hour

ALTER TABLE endpoint_costs ADD COLUMN IF NOT EXISTS static_hold_ms numeric;   -- static baseline per endpoint
ALTER TABLE endpoint_costs ADD COLUMN IF NOT EXISTS live_hold_ms   numeric;   -- last published B_e (for dashboards)

ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS status_code   integer;
ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS reason        text;          -- NULL | 'rate' | 'contention_debt' | 'acquire_timeout' | 'fail_open'
ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS overhead_us   integer;       -- middleware entry -> admission decision
ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS handler_ms    numeric;       -- admission decision -> response finish
ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS cost          numeric;
ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS debt_at_admit numeric;
ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS policy        text;
ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS run_id        text;

CREATE TABLE IF NOT EXISTS pool_holds (
  id            bigserial PRIMARY KEY,
  run_id        text        NOT NULL,
  policy        text        NOT NULL,
  api_key       text        NOT NULL,
  endpoint      text        NOT NULL,
  acquired_at   timestamptz NOT NULL,
  hold_ms       numeric     NOT NULL,
  wait_ms       numeric     NOT NULL,   -- this request's own wait before acquiring
  imposed_ms    numeric     NOT NULL,   -- E: request-ms of waiting attributed to this hold
  overstay_ms   numeric     NOT NULL,   -- max(0, hold_ms - gamma*baseline_ms)
  baseline_ms   numeric     NOT NULL,   -- B_e used (0 in whole mode)
  debit_tokens  numeric     NOT NULL DEFAULT 0,
  credit_tokens numeric     NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS pool_holds_endpoint_ts ON pool_holds (endpoint, acquired_at);
CREATE INDEX IF NOT EXISTS pool_holds_run ON pool_holds (run_id);
CREATE INDEX IF NOT EXISTS usage_logs_run ON usage_logs (run_id);

CREATE TABLE IF NOT EXISTS hot_rows (id integer PRIMARY KEY, v bigint NOT NULL DEFAULT 0);
INSERT INTO hot_rows (id, v) VALUES (1, 0) ON CONFLICT DO NOTHING;

-- One row per rate-limited endpoint (contracts.md section 6).
-- expected_latency_ms = static_hold_ms with a minimum of 5, as the own_usage calibrator needs a non-zero divisor.
INSERT INTO endpoint_costs (endpoint, base_token_cost, token_cost, expected_latency_ms, static_hold_ms) VALUES
  ('endpoint-a',   1, 1, 5,    5),
  ('demo.cheap',   1, 1, 5,    5),
  ('demo.slow',    1, 1, 2000, 2000),
  ('demo.txn',     1, 1, 50,   50),
  ('demo.hotrow',  1, 1, 10,   10),
  ('demo.cpu',     1, 1, 5,    0)
ON CONFLICT (endpoint) DO UPDATE
  SET base_token_cost     = EXCLUDED.base_token_cost,
      expected_latency_ms = EXCLUDED.expected_latency_ms,
      static_hold_ms      = EXCLUDED.static_hold_ms;

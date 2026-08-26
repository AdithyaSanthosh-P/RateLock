CREATE TABLE tiers (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) UNIQUE NOT NULL,
  tokens_per_hour INT NOT NULL
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
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX idx_usage_logs_user_id ON usage_logs(user_id);
CREATE INDEX idx_usage_logs_endpoint ON usage_logs(endpoint);
CREATE INDEX idx_usage_logs_timestamp ON usage_logs(timestamp);
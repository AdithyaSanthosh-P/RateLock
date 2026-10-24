-- settle.lua: apply one release's accounting to Redis atomically.
--   * debit  the holder's contention debt (the waiting it imposed), and/or
--   * credit a waiter's bucket (the time it spent waiting).
-- Contract: docs/plan/contracts.md section 3.
--
-- KEYS[1] = holder debt key, or '' for no debit      KEYS[2] = waiter bucket key, or '' for no credit
-- ARGV[1] = debit_tokens      ARGV[2] = debt_cap      ARGV[3] = debt_decay_per_ms
-- ARGV[4] = credit_tokens     ARGV[5] = waiter_cap    ARGV[6] = waiter_rate_per_ms    ARGV[7] = idle_ttl_ms
--
-- Returns {debt_after, tokens_after} as strings, -1 for a part that was skipped.

local debit = tonumber(ARGV[1])
local debt_cap = tonumber(ARGV[2])
local decay = tonumber(ARGV[3])
local credit = tonumber(ARGV[4])
local waiter_cap = tonumber(ARGV[5])
local waiter_rate = tonumber(ARGV[6])
local idle_ttl = tonumber(ARGV[7])

local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

local d_after = -1
local tokens_after = -1

-- Holder debit: decay the existing debt to now, add the new debit, cap it.
if KEYS[1] ~= '' and debit > 0 then
    local dh = redis.call('HMGET', KEYS[1], 'd', 'ts')
    local d = 0
    if dh[1] ~= false and dh[2] ~= false then
        d = math.max(0, tonumber(dh[1]) - math.max(0, now - tonumber(dh[2])) * decay)
    end
    d = math.min(debt_cap, d + debit)
    redis.call('HSET', KEYS[1], 'd', tostring(d), 'ts', tostring(now))
    redis.call('PEXPIRE', KEYS[1], idle_ttl)
    d_after = d
end

-- Waiter credit: refill the bucket to now (a missing bucket is full), add the credit, cap at the bucket size.
if KEYS[2] ~= '' and credit > 0 then
    local b = redis.call('HMGET', KEYS[2], 'tokens', 'ts')
    local tokens
    if b[1] == false or b[2] == false then
        tokens = waiter_cap
    else
        tokens = math.min(waiter_cap, tonumber(b[1]) + math.max(0, now - tonumber(b[2])) * waiter_rate)
    end
    tokens = math.min(waiter_cap, tokens + credit)
    redis.call('HSET', KEYS[2], 'tokens', tostring(tokens), 'ts', tostring(now))
    redis.call('PEXPIRE', KEYS[2], idle_ttl)
    tokens_after = tokens
end

return { tostring(d_after), tostring(tokens_after) }

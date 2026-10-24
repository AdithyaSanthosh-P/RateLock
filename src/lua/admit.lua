-- admit.lua: lazy token-bucket refill + contention-debt check + spend, all in one atomic step.
-- Contract: docs/plan/contracts.md section 3.
--
-- KEYS[1] = bucket key (hash: tokens, ts)     KEYS[2] = debt key (hash: d, ts)
-- ARGV[1] = cap   ARGV[2] = rate_per_ms   ARGV[3] = cost   ARGV[4] = idle_ttl_ms   ARGV[5] = debt_decay_per_ms
--
-- Returns {allowed, remaining, retry_ms, reason, debt}. Every non-integer is returned with tostring():
-- Redis truncates Lua floats to integers on reply.

local cap = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local idle_ttl = tonumber(ARGV[4])
local decay = tonumber(ARGV[5])

local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

-- Bucket: a missing bucket starts full; otherwise refill for the time since the last write.
local b = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens
if b[1] == false or b[2] == false then
    tokens = cap
else
    tokens = math.min(cap, tonumber(b[1]) + math.max(0, now - tonumber(b[2])) * rate)
end

-- Debt: decays linearly; a missing key means no debt.
local dh = redis.call('HMGET', KEYS[2], 'd', 'ts')
local d = 0
if dh[1] ~= false and dh[2] ~= false then
    d = math.max(0, tonumber(dh[1]) - math.max(0, now - tonumber(dh[2])) * decay)
end

-- Effective tokens: debt reduces headroom on every endpoint of this key (decision D7).
local eff = tokens - d
local allowed = 0
local reason = ''
local retry_ms = 0

if eff >= cost then
    tokens = tokens - cost
    allowed = 1
else
    if d > 0 and tokens >= cost then
        reason = 'contention_debt'
    else
        reason = 'rate'
    end
    local speed = rate + decay
    if speed > 0 then
        retry_ms = math.ceil((cost - eff) / speed)
    else
        retry_ms = 3600000
    end
end

redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(now))
redis.call('PEXPIRE', KEYS[1], idle_ttl)

if d > 0 then
    redis.call('HSET', KEYS[2], 'd', tostring(d), 'ts', tostring(now))
    redis.call('PEXPIRE', KEYS[2], idle_ttl)
else
    redis.call('DEL', KEYS[2])
end

return { allowed, tostring(tokens - d), tostring(retry_ms), reason, tostring(d) }

#!/bin/bash
# Resets runtime state between runs. Does NOT truncate usage_logs / pool_holds: earlier runs must survive.
docker exec ratelock-redis redis-cli --scan --pattern 'ratelock:*' | xargs -r docker exec -i ratelock-redis redis-cli UNLINK > /dev/null
docker exec ratelock-postgres psql -q -U ratelock -d ratelock -c "
    UPDATE endpoint_costs SET token_cost = base_token_cost, live_hold_ms = NULL;
    UPDATE hot_rows SET v = 0;
" > /dev/null

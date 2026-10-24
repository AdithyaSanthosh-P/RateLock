#!/bin/bash
# One experiment run: reset state, start the server with a policy, drive it with k6, stop, record metadata.
# usage: experiments/run.sh POLICY WORKLOAD REP [ALPHA] [BETA]
# env overrides: WARMUP_S (30), MEASURE_S (60), plus k6 rate knobs (CULPRIT_RATE, VICTIM_RATE_PER_KEY, CULPRIT_HOLD_MS)
set -u
POLICY=$1; WORKLOAD=$2; REP=$3; ALPHA=${4:-1}; BETA=${5:-1}
cd "$(dirname "$0")/.."
export WARMUP_S=${WARMUP_S:-30} MEASURE_S=${MEASURE_S:-60}

PREFIX="${WORKLOAD}_${POLICY}_a${ALPHA}_b${BETA}_r${REP}"
RUN_ID="${PREFIX}_$(date +%s)"
DIR="experiments/results/$RUN_ID"
mkdir -p "$DIR"

bash experiments/reset_state.sh

START=$(date -u +%FT%TZ)
RL_POLICY=$POLICY RL_RUN_ID=$RUN_ID RL_ALPHA=$ALPHA RL_BETA=$BETA RL_LOAD_MULTIPLIER=off APP_POOL_SIZE=${APP_POOL_SIZE:-10} \
    node index.js > "$DIR/server.log" 2>&1 &
SERVER=$!

for i in $(seq 1 30); do
    curl -sf localhost:${PORT:-3000}/health > /dev/null && break
    sleep 1
    if [ "$i" = 30 ]; then echo "server did not start"; kill $SERVER 2>/dev/null; exit 1; fi
done

experiments/bin/k6 run --quiet -e WORKLOAD=$WORKLOAD -e RUN_ID=$RUN_ID -e RESULTS_DIR=$DIR experiments/k6/workload.js > "$DIR/k6.log" 2>&1
K6_EXIT=$?

kill -TERM $SERVER           # SIGTERM flushes the log batches before exit
wait $SERVER 2>/dev/null
END=$(date -u +%FT%TZ)

cat > "$DIR/meta.json" <<JSON
{
  "run_id": "$RUN_ID", "prefix": "$PREFIX", "policy": "$POLICY", "workload": "$WORKLOAD", "rep": $REP,
  "alpha": $ALPHA, "beta": $BETA, "warmup_s": $WARMUP_S, "measure_s": $MEASURE_S,
  "start": "$START", "end": "$END", "k6_exit": $K6_EXIT,
  "commit": "$(git rev-parse --short HEAD)",
  "env": { "APP_POOL_SIZE": "${APP_POOL_SIZE:-10}", "RL_GAMMA": "${RL_GAMMA:-1.2}", "CULPRIT_RATE": "${CULPRIT_RATE:-8}",
           "VICTIM_RATE_PER_KEY": "${VICTIM_RATE_PER_KEY:-5}", "SLOW_RATE": "${SLOW_RATE:-4.8}", "CULPRIT_HOLD_MS": "${CULPRIT_HOLD_MS:-1500}" }
}
JSON
echo "$RUN_ID done (k6 exit $K6_EXIT)"

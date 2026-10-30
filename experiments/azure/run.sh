#!/bin/bash
# One Azure replay run (D26): reset state, start the server with a policy and the replay routes, replay the
# schedule, stop, record metadata. Same shape as experiments/run.sh; results in experiments/results/azure/.
# usage: experiments/azure/run.sh POLICY REP [ALPHA] [BETA]
# needs: venv/bin/python experiments/azure/prepare.py && node experiments/azure/seed.js (once)
set -u
POLICY=$1; REP=$2; ALPHA=${3:-1}; BETA=${4:-1}
cd "$(dirname "$0")/../.."

PREFIX="azure_${POLICY}_a${ALPHA}_b${BETA}_r${REP}"
RUN_ID="${PREFIX}_$(date +%s)"
DIR="experiments/results/azure/$RUN_ID"   # one level down, so experiments/analyze.py does not pick it up
mkdir -p "$DIR"
cp experiments/azure/out/window.json "$DIR/window.json"

bash experiments/reset_state.sh

START=$(date -u +%FT%TZ)
export RL_GAMMA=${RL_GAMMA:-1}   # baseline is the p95, so overstay starts at 1 x baseline (D27)
RL_POLICY=$POLICY RL_RUN_ID=$RUN_ID RL_ALPHA=$ALPHA RL_BETA=$BETA RL_LOAD_MULTIPLIER=off APP_POOL_SIZE=${APP_POOL_SIZE:-10} \
    REPLAY_ENDPOINTS_FILE=experiments/azure/out/endpoints.json \
    node index.js > "$DIR/server.log" 2>&1 &
SERVER=$!

for i in $(seq 1 30); do
    curl -sf localhost:${PORT:-3000}/health > /dev/null && break
    sleep 1
    if [ "$i" = 30 ]; then echo "server did not start"; kill $SERVER 2>/dev/null; exit 1; fi
done

node experiments/azure/replay.js "$DIR" > "$DIR/replay.log" 2>&1
REPLAY_EXIT=$?

kill -TERM $SERVER           # SIGTERM flushes the log batches before exit
wait $SERVER 2>/dev/null
END=$(date -u +%FT%TZ)

cat > "$DIR/meta.json" <<JSON
{
  "run_id": "$RUN_ID", "prefix": "$PREFIX", "policy": "$POLICY", "workload": "azure", "rep": $REP,
  "alpha": $ALPHA, "beta": $BETA, "warmup_s": $(node -p "require('./$DIR/window.json').warmup_s"), "measure_s": $(node -p "require('./$DIR/window.json').measure_s"),
  "start": "$START", "end": "$END", "replay_exit": $REPLAY_EXIT,
  "commit": "$(git rev-parse --short HEAD)",
  "env": { "APP_POOL_SIZE": "${APP_POOL_SIZE:-10}", "RL_GAMMA": "$RL_GAMMA" }
}
JSON
echo "$RUN_ID done (replay exit $REPLAY_EXIT)"

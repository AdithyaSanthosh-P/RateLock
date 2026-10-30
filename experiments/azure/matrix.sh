#!/bin/bash
# Runs the Azure replay matrix (D26/D27): 5 policies x 3 reps, ~5.4 min per run, ~80 min in all.
# Resumable: skips any run whose meta.json already exists, so after an interruption just run it again.
# usage: bash experiments/azure/matrix.sh
cd "$(dirname "$0")/../.."
POLICIES="plain own_usage conex holder_whole holder_overstay"
for r in 1 2 3; do
    for p in $POLICIES; do
        if ls experiments/results/azure/azure_${p}_a1_b1_r${r}_*/meta.json > /dev/null 2>&1; then
            echo "skip $p r$r"
        else
            bash experiments/azure/run.sh $p $r
            sleep 5
        fi
    done
done

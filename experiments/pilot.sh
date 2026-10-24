#!/bin/bash
# Pilot runs for tuning (P7.3): a few cells at full length.
cd "$(dirname "$0")/.."
for cell in "plain d" "plain a" "holder_whole a" "holder_overstay a" "holder_whole e" "holder_overstay e"; do
    set -- $cell
    bash experiments/run.sh $1 $2 0
    sleep 3
done

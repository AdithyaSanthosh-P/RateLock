#!/bin/bash
# Runs a block of the experiment matrix. Resumable: skips runs whose meta.json already exists.
# usage: experiments/matrix.sh core|beta|alpha|diag
cd "$(dirname "$0")/.."
POLICIES="plain own_usage conex holder_whole holder_overstay"

run() {   # POLICY WORKLOAD REP ALPHA BETA
    if ls experiments/results/${2}_${1}_a${4}_b${5}_r${3}_*/meta.json > /dev/null 2>&1; then
        echo "skip $2 $1 a$4 b$5 r$3"
    else
        bash experiments/run.sh $1 $2 $3 $4 $5
        sleep 5
    fi
}

case "$1" in
    core)   for r in 1 2 3 4 5; do for w in a d e; do for p in $POLICIES; do run $p $w $r 1 1; done; done; done ;;
    beta)   for r in 1 2 3 4 5; do for b in 1 0; do run holder_overstay a2 $r 1 $b; done; done ;;
    alpha)  for r in 1 2 3; do for a in 0.5 2; do run holder_overstay a $r $a 1; done; done ;;
    diag)   for r in 1 2 3; do for w in b c; do for p in $POLICIES; do run $p $w $r 1 1; done; done; done ;;
    *) echo "usage: $0 core|beta|alpha|diag"; exit 1 ;;
esac

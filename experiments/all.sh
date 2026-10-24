#!/bin/bash
# Whole matrix, in priority order. Resumable: finished runs are skipped.
cd "$(dirname "$0")/.."
for block in core beta alpha diag; do bash experiments/matrix.sh $block; done
echo ALL DONE

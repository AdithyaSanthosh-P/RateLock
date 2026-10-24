# Experiment harness

Compares five policies (`plain`, `own_usage`, `conex`, `holder_whole`, `holder_overstay`) on a pool of 10 Postgres connections.

## Run
```bash
docker compose up -d && npm run migrate && node experiments/seed.js     # once
bash experiments/run.sh POLICY WORKLOAD REP [ALPHA] [BETA]               # one run (~100 s)
bash experiments/matrix.sh core|beta|alpha|diag                          # a block; resumable
venv/bin/python experiments/analyze.py                                   # runs.csv, summary.csv, plots/
```
`k6` is a local binary in `experiments/bin/` (gitignored): download the linux-amd64 release from the k6 releases page.
Results go to `experiments/results/<run_id>/` (`k6_summary.json`, `meta.json`, `server.log`); rows in `usage_logs` / `pool_holds` carry the same `run_id`.

## Workloads (final parameters after the pilot)
Every run: 30 s warmup with normal traffic (the culprit sends 50 ms transactions), then 60 s of measurement. Tier `exp` = 10 req/s, burst 20.

| ID | Measurement traffic | Purpose |
|---|---|---|
| a | culprit: `/demo/txn?hold=1500`, **8/s**; 20 victims x `/demo/cheap`, 5/s each | main result |
| a2 | as (a) but victims at **11/s** each (just over their quota) | victim-credit (beta) ablation |
| d | 20 victims as in (a) + 5 keys `/demo/txn?hold=50`, 2/s each | false-positive control |
| e | 1 key `/demo/slow?ms=2000`, **4.8/s** (legitimate); victims as in (a) | fairness control: `overstay` must not debit it |
| b | culprit `/demo/txn?hold=1500&lock=1` 2/s; 10 victims `POST /demo/hotrow` 3/s; 10 victims cheap 5/s | diagnostic (row lock) |
| c | culprit `/demo/cpu?ms=100` 5/s; victims as in (a) | diagnostic (CPU hog) |

Tuning notes (pilot, 2026-10-24): the culprit rate of 6/s did not saturate the pool (6 x 1.5 s = 9 of 10 connections); 8/s does. Workload (e) at 4/s caused no pool waiting at all, so `holder_whole` and `holder_overstay` were indistinguishable; at 4.8/s about 96% of connections are busy and `holder_whole` debits the slow key.
Fixed settings: `APP_POOL_SIZE=10`, `RL_LOAD_MULTIPLIER=off`, `RL_ALPHA=1`, `RL_BETA=1`, `RL_GAMMA=1.2`, one Express instance, static baselines.

## Blocks
| Block | Workloads | Policies | Reps | Runs |
|---|---|---|---|---|
| core | a, d, e | all 5 | 5 | 75 |
| beta | a2 | holder_overstay with beta 1 and 0 | 5 | 10 |
| alpha | a | holder_overstay, alpha 0.5 and 2 | 3 | 6 |
| diag | b, c | all 5 | 3 | 30 |

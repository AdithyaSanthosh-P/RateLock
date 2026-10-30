"""Builds the Azure replay schedule from the Azure Functions Invocation Trace 2021 (decisions D25, D26).

Trace: Zhang et al., "Faster and Cheaper Serverless Computing on Harvested Resources", SOSP 2021 (CC-BY).
Download AzureFunctionsInvocationTraceForTwoWeeksJan2021.rar from github.com/Azure/AzurePublicDataset,
extract it with `unrar` into experiments/azure/data/.

usage: venv/bin/python experiments/azure/prepare.py [--hour 92] [--warmup 30] [--measure 270]
writes experiments/azure/out/{schedule.csv, endpoints.json, apps.json, window.json}

Steps:
  1. start = end_timestamp - duration (seconds). Keep calls that start in the chosen hour.
  2. Window: the run-length window (warmup + measure, 10 s steps) whose measure part has the most
     distinct apps and no app above 40% of its calls. Fixed rule, chosen before running (D26).
  3. k: durations are divided by k so the window's measure part averages 9.6 busy connections
     (offered load, holds capped at run end), the same utilisation as workloads a and e. Found by bisection.
  4. Baseline per endpoint: p95 of that function's durations over all 14 days, divided by the same k, with a
     5 ms floor (many functions report 0 s). Run with RL_GAMMA=1, so overstay = time beyond the function's
     normal spread. The pilot with the median showed real durations vary too much for 1.2 x median (D27).
  5. Hog label (for analysis only, never seen by the server): a call is "anomalous" if its duration is above
     the function's own 14-day p99, stricter than the p95 baseline so the label is not the policy's own rule.
  6. Tier per app (D27): tokens/hour = 2 x the app's mean call rate in the window; burst = the most calls the
     app starts in any 10 s of the window (at least 2). A tenant near its plan, so debt can matter.
"""
import argparse
import json
import math
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent
TRACE = ROOT / "data" / "AzureFunctionsInvocationTraceForTwoWeeksJan2021.txt"
OUT = ROOT / "out"

# Run length. 300 s (30 + 270), not the 90 s of the controlled runs: debt only acts on a key's *later* requests,
# and in 90 s the trace's hog apps send nothing after their long holds end (D26, pilot 2026-10-30).
STEP_S = 10
WARMUP_S, MEASURE_S, RUN_S = 30, 270, 300   # overwritten from the command line in main()
TARGET_BUSY = 9.6          # of APP_POOL_SIZE = 10
MAX_APP_SHARE = 0.40
BASELINE_FLOOR_MS = 5.0


def busy_in_measure(starts, durs, k):
    """Average busy connections over the measure part, with holds scaled by 1/k and capped at run end."""
    ends = (starts + durs / k).clip(upper=RUN_S)
    overlap = (ends.clip(lower=WARMUP_S) - starts.clip(lower=WARMUP_S)).clip(lower=0)
    return overlap.sum() / MEASURE_S


def find_k(starts, durs):
    lo, hi = 1e-4, 1e4                      # busy falls as k rises
    for _ in range(100):
        mid = (lo * hi) ** 0.5
        if busy_in_measure(starts, durs, mid) > TARGET_BUSY:
            lo = mid
        else:
            hi = mid
    return (lo * hi) ** 0.5


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--hour", type=int, default=92)
    ap.add_argument("--warmup", type=int, default=30)
    ap.add_argument("--measure", type=int, default=270)
    args = ap.parse_args()
    global WARMUP_S, MEASURE_S, RUN_S
    WARMUP_S, MEASURE_S, RUN_S = args.warmup, args.measure, args.warmup + args.measure

    d = pd.read_csv(TRACE)
    d["start"] = d["end_timestamp"] - d["duration"]
    d["fid"] = d["app"] + ":" + d["func"]
    stats = d.groupby("fid")["duration"].agg(p95=lambda x: x.quantile(0.95), p99=lambda x: x.quantile(0.99))

    h0 = args.hour * 3600
    hour = d[(d["start"] >= h0) & (d["start"] < h0 + 3600)]

    best = None
    for off in range(0, 3600 - RUN_S + 1, STEP_S):
        meas = hour[(hour["start"] >= h0 + off + WARMUP_S) & (hour["start"] < h0 + off + RUN_S)]
        if meas.empty:
            continue
        share = meas["app"].value_counts(normalize=True).iloc[0]
        score = (meas["app"].nunique(), len(meas))
        if share <= MAX_APP_SHARE and (best is None or score > best[1]):
            best = (off, score, share)
    if best is None:
        raise SystemExit(f"no window in hour {args.hour} satisfies the rule")
    off = best[0]

    w = hour[(hour["start"] >= h0 + off) & (hour["start"] < h0 + off + RUN_S)].copy()
    w["t"] = w["start"] - (h0 + off)                          # seconds from run start
    k = find_k(w["t"], w["duration"])

    apps = sorted(w["app"].unique())
    fids = sorted(w["fid"].unique())
    app_idx = {a: i for i, a in enumerate(apps)}
    ep_idx = {f: i for i, f in enumerate(fids)}

    w["hold_ms"] = ((w["duration"] / k).clip(upper=RUN_S - w["t"]) * 1000).round(1)
    w["anomalous"] = w["duration"] > w["fid"].map(stats["p99"])
    sched = pd.DataFrame({
        "offset_ms": (w["t"] * 1000).round(1),
        "app": w["app"].map(app_idx),
        "ep": w["fid"].map(ep_idx),
        "hold_ms": w["hold_ms"],
        "anomalous": w["anomalous"].astype(int),
        "phase": (w["t"] >= WARMUP_S).map({True: "measure", False: "warmup"}),
    }).sort_values("offset_ms")

    endpoints = [{
        "ep": ep_idx[f], "endpointId": f"replay.{ep_idx[f]}", "app": app_idx[f.split(":")[0]],
        "baseline_ms": round(max(BASELINE_FLOOR_MS, stats.loc[f, "p95"] * 1000 / k), 2),
        "p99_ms": round(stats.loc[f, "p99"] * 1000 / k, 2),
    } for f in fids]

    tiers = []
    for a in apps:
        t = w.loc[w["app"] == a, "t"].sort_values().to_numpy()
        burst = max(int(((t[None, :] >= t[:, None]) & (t[None, :] < t[:, None] + 10)).sum(axis=1).max()), 2)
        tiers.append({"app": app_idx[a], "tokens_per_hour": math.ceil(2 * len(t) / RUN_S * 3600), "burst": burst})

    OUT.mkdir(exist_ok=True)
    sched.to_csv(OUT / "schedule.csv", index=False)
    (OUT / "endpoints.json").write_text(json.dumps(endpoints, indent=1) + "\n")
    (OUT / "apps.json").write_text(json.dumps({"n_apps": len(apps), "tiers": tiers}, indent=1) + "\n")
    meas = sched[sched["phase"] == "measure"]
    window = {
        "hour": args.hour, "warmup_s": WARMUP_S, "measure_s": MEASURE_S, "window_offset_s": off, "trace_start_s": h0 + off, "k": round(k, 4),
        "busy_in_measure": round(busy_in_measure(w["t"], w["duration"], k), 2),
        "calls": len(sched), "measure_calls": len(meas), "apps": len(apps), "endpoints": len(fids),
        "measure_apps": int(meas["app"].nunique()), "top_app_share_measure": round(best[2], 3),
        "anomalous_calls": int(sched["anomalous"].sum()), "capped_holds": int((w["duration"] / k > RUN_S - w["t"]).sum()),
    }
    (OUT / "window.json").write_text(json.dumps(window, indent=1) + "\n")
    print(json.dumps(window))


if __name__ == "__main__":
    main()

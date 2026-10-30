"""Analysis of the Azure replay runs (D26). Reads experiments/results/azure/*/{meta.json,requests.csv}.

usage: venv/bin/python experiments/azure/analyze.py
writes experiments/results/azure/{runs.csv, summary.csv, plots/*.png}

The trace has no culprit/victim labels, so two labels are fixed in prepare.py, before any run, and are
independent of the policy's own gamma * median rule:
  * a call is "anomalous" if its duration is above its function's 14-day p99 (the policy's baseline is the p95);
    every other call is "normal";
  * a key (app) is a "hog key" if it has at least one anomalous call in the replayed window.
Metrics use the measure phase only:
  * normal_queue_p50/p95/p99_ms: latency minus the call's own hold, for normal calls that got a 200.
    This is the time spent waiting for a connection plus limiter overhead, i.e. the harm contention does.
  * normal_429_rate: share of normal calls refused (collateral damage).
  * fp_per_min: contention-debt refusals of keys that are not hog keys, per minute (false positives).
  * debt_precision: share of contention-debt refusals that hit hog keys.
  * hog_key_refusals: contention-debt refusals of hog keys.
  * timeout_rate: share of calls that gave up waiting for a connection (503).
"""
import json
import math
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import pandas as pd

RESULTS = Path(__file__).resolve().parents[1] / "results" / "azure"
POLICIES = ["plain", "own_usage", "conex", "holder_whole", "holder_overstay"]


def analyze_run(run_dir):
    meta = json.loads((run_dir / "meta.json").read_text())
    r = pd.read_csv(run_dir / "requests.csv", keep_default_na=False)
    hog_apps = set(r.loc[r["anomalous"] == 1, "app"])
    m = r[r["phase"] == "measure"].copy()
    m["hog_key"] = m["app"].isin(hog_apps)
    normal = m[m["anomalous"] == 0]
    ok = normal[normal["status"] == 200]
    queue = ok["latency_ms"] - ok["hold_ms"]
    debt = m[(m["status"] == 429) & (m["reason"] == "contention_debt")]
    minutes = meta["measure_s"] / 60
    return {
        "run_id": meta["run_id"], "policy": meta["policy"], "rep": meta["rep"],
        "calls": len(m), "normal_calls": len(normal),
        "normal_queue_p50_ms": queue.quantile(0.50),
        "normal_queue_p95_ms": queue.quantile(0.95),
        "normal_queue_p99_ms": queue.quantile(0.99),
        "normal_429_rate": (normal["status"] == 429).mean(),
        "fp_per_min": len(debt[~debt["hog_key"]]) / minutes,
        "debt_precision": debt["hog_key"].mean() if len(debt) else math.nan,
        "hog_key_refusals": int(debt["hog_key"].sum()),
        "debt_refusals": len(debt),
        "timeout_rate": (m["status"] == 503).mean(),
        "max_send_lag_ms": r["lag_ms"].max(),
    }


def summarize(runs):
    metrics = [c for c in runs.columns if c not in ("run_id", "policy", "rep")]
    g = runs.groupby("policy")[metrics]
    out = g.mean().add_suffix("_mean").join(g.std().add_suffix("_sd")).join(runs.groupby("policy").size().rename("n"))
    order = [p for p in POLICIES if p in out.index]
    return out.loc[order].reset_index()


def bar(summary, metric, label, path):
    fig, ax = plt.subplots(figsize=(7, 3.5))
    ax.bar(summary["policy"], summary[f"{metric}_mean"], yerr=summary[f"{metric}_sd"].fillna(0), capsize=4)
    ax.set_ylabel(label)
    ax.set_title(f"Azure Functions trace replay: {label}")
    fig.tight_layout()
    fig.savefig(path, dpi=150)
    plt.close(fig)


def main():
    rows = [analyze_run(d.parent) for d in sorted(RESULTS.glob("*/meta.json")) if (d.parent / "requests.csv").exists()]
    if not rows:
        print("no azure runs found")
        return
    runs = pd.DataFrame(rows)
    runs.to_csv(RESULTS / "runs.csv", index=False)
    summary = summarize(runs)
    summary.to_csv(RESULTS / "summary.csv", index=False)
    plots = RESULTS / "plots"
    plots.mkdir(exist_ok=True)
    bar(summary, "normal_queue_p99_ms", "normal-call queueing p99 (ms)", plots / "queue_p99.png")
    bar(summary, "fp_per_min", "false positives / min", plots / "false_positives.png")
    bar(summary, "normal_429_rate", "normal-call 429 rate", plots / "normal_429.png")
    pd.set_option("display.width", 250)
    cols = ["policy", "n"] + [f"{m}_mean" for m in ["normal_queue_p50_ms", "normal_queue_p99_ms", "normal_429_rate",
                                                   "fp_per_min", "debt_precision", "hog_key_refusals", "timeout_rate"]]
    print(summary[cols].round(3).to_string(index=False))


if __name__ == "__main__":
    main()

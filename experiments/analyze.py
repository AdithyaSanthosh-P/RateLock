"""Analysis for the experiment (docs/plan/phase7-experiment.md, P7.4).

Per run: reads meta.json, k6_summary.json and the usage_logs / pool_holds rows with that run_id, restricted to the
measurement window. Across repetitions: mean and 95% CI (t distribution) per (workload, policy, alpha, beta).

usage:  venv/bin/python experiments/analyze.py [--results experiments/results]
writes: <results>/runs.csv, <results>/summary.csv, <results>/plots/*.png
"""
import argparse
import json
import math
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import warnings
import pandas as pd
import psycopg2
from scipy import stats as st

warnings.filterwarnings("ignore", message="pandas only supports SQLAlchemy")
ROOT = Path(__file__).resolve().parent.parent
KEYS = json.loads((ROOT / "experiments" / "keys.json").read_text())

# Which keys are the misbehaving ("culprit-role") ones in each workload. In (e) the slow key is legitimate.
CULPRIT_WORKLOADS = {"a", "a2", "b", "c"}


def connect():
    conn = psycopg2.connect(host="localhost", port=54321, user="ratelock", password="ratelock123", dbname="ratelock")
    conn.cursor().execute("SET TIME ZONE 'UTC'")
    return conn


def q(conn, sql, params):
    return pd.read_sql_query(sql, conn, params=params)


def k6_value(summary, name, stat):
    m = summary["metrics"].get(name)
    return m.get(stat) if m else math.nan


def analyze_run(conn, run_dir):
    meta = json.loads((run_dir / "meta.json").read_text())
    summary = json.loads((run_dir / "k6_summary.json").read_text())
    run_id, wl = meta["run_id"], meta["workload"]
    culprit_keys = set(KEYS["culprit"]) if wl in CULPRIT_WORKLOADS else set()

    # Measurement window, in server time: starts WARMUP_S after the first logged request of the run.
    t0 = q(conn, "SELECT min(timestamp) AT TIME ZONE 'UTC' AS t0 FROM usage_logs WHERE run_id = %s", (run_id,))["t0"][0]
    if pd.isna(t0):
        return None
    win = (t0 + pd.Timedelta(seconds=meta["warmup_s"]), t0 + pd.Timedelta(seconds=meta["warmup_s"] + meta["measure_s"]))

    reqs = q(conn, """
        SELECT u.api_key, ul.allowed, ul.reason, ul.status_code, ul.overhead_us, ul.handler_ms
        FROM usage_logs ul JOIN users u ON u.id = ul.user_id
        WHERE ul.run_id = %s AND (ul.timestamp AT TIME ZONE 'UTC') >= %s AND (ul.timestamp AT TIME ZONE 'UTC') < %s
    """, (run_id, *win))
    holds = q(conn, """
        SELECT wait_ms, imposed_ms FROM pool_holds
        WHERE run_id = %s AND acquired_at >= %s AND acquired_at < %s
    """, (run_id, *win))

    reqs["culprit"] = reqs["api_key"].isin(culprit_keys)
    denied = reqs[~reqs["allowed"]]
    debt = denied[denied["reason"] == "contention_debt"]
    victims = reqs[~reqs["culprit"]]
    ok_victims = victims[victims["allowed"] & (victims["status_code"] == 200)]
    minutes = meta["measure_s"] / 60.0

    return {
        "run_id": run_id, "workload": wl, "policy": meta["policy"], "alpha": meta["alpha"], "beta": meta["beta"], "rep": meta["rep"],
        "contention_precision": debt["culprit"].mean() if len(debt) else math.nan,
        "any429_precision": denied["culprit"].mean() if len(denied) else math.nan,
        "culprit_denial_rate": (~reqs[reqs["culprit"]]["allowed"]).mean() if reqs["culprit"].any() else math.nan,
        "victim_p50_ms": k6_value(summary, "lat_victim_measure", "med"),
        "victim_p99_ms": k6_value(summary, "lat_victim_measure", "p(99)"),
        "victim_429_rate": (~victims["allowed"]).mean() if len(victims) else math.nan,
        "false_positives_per_min": len(debt[~debt["culprit"]]) / minutes,
        "pool_wait_mean_ms": holds["wait_ms"].astype(float).mean() if len(holds) else math.nan,
        "pool_wait_p99_ms": holds["wait_ms"].astype(float).quantile(0.99) if len(holds) else math.nan,
        "throughput_rps": (reqs["allowed"] & (reqs["status_code"] == 200)).sum() / meta["measure_s"],
        "victim_throughput_rps": len(ok_victims) / meta["measure_s"],
        "overhead_p50_us": reqs["overhead_us"].astype(float).quantile(0.5) if len(reqs) else math.nan,
        "overhead_p99_us": reqs["overhead_us"].astype(float).quantile(0.99) if len(reqs) else math.nan,
    }


def ci95(x):
    x = x.dropna()
    n = len(x)
    if n < 2:
        return math.nan
    return st.t.ppf(0.975, n - 1) * x.std(ddof=1) / math.sqrt(n)


def summarize(runs):
    metrics = [c for c in runs.columns if c not in ("run_id", "workload", "policy", "alpha", "beta", "rep")]
    g = runs.groupby(["workload", "policy", "alpha", "beta"])
    rows = []
    for key, grp in g:
        row = dict(zip(["workload", "policy", "alpha", "beta"], key))
        row["reps"] = len(grp)
        for m in metrics:
            row[f"{m}_mean"] = grp[m].mean()
            row[f"{m}_ci95"] = ci95(grp[m])
        rows.append(row)
    return pd.DataFrame(rows)


POLICY_ORDER = ["plain", "own_usage", "conex", "holder_whole", "holder_overstay"]


def bar_by_policy(summary, workload, metric, ylabel, out):
    d = summary[(summary.workload == workload) & (summary.alpha == 1) & (summary.beta == 1)]
    d = d.set_index("policy").reindex([p for p in POLICY_ORDER if p in set(d.policy)])
    if d.empty:
        return
    fig, ax = plt.subplots(figsize=(6, 3.5))
    ax.bar(d.index, d[f"{metric}_mean"], yerr=d[f"{metric}_ci95"].fillna(0), capsize=4)
    ax.set_ylabel(ylabel)
    ax.set_title(f"workload {workload}")
    plt.xticks(rotation=25, ha="right")
    fig.tight_layout()
    fig.savefig(out, dpi=140)
    plt.close(fig)


def beta_plot(summary, out):
    d = summary[(summary.workload == "a2") & (summary.policy == "holder_overstay") & (summary.alpha == 1)].sort_values("beta")
    if len(d) < 2:
        return
    fig, axes = plt.subplots(1, 2, figsize=(7, 3.2))
    for ax, (metric, label) in zip(axes, [("victim_429_rate", "victim 429 rate"), ("victim_throughput_rps", "victim throughput (req/s)")]):
        ax.bar([f"beta={b:g}" for b in d.beta], d[f"{metric}_mean"], yerr=d[f"{metric}_ci95"].fillna(0), capsize=4)
        ax.set_ylabel(label)
    fig.suptitle("victim credit ablation (workload a2, holder_overstay)")
    fig.tight_layout()
    fig.savefig(out, dpi=140)
    plt.close(fig)


def alpha_plot(summary, out):
    d = summary[(summary.workload == "a") & (summary.policy == "holder_overstay") & (summary.beta == 1)].sort_values("alpha")
    if len(d) < 2:
        return
    fig, axes = plt.subplots(1, 2, figsize=(7, 3.2))
    for ax, (metric, label) in zip(axes, [("victim_p99_ms", "victim p99 (ms)"), ("contention_precision", "contention precision")]):
        ax.errorbar(d.alpha, d[f"{metric}_mean"], yerr=d[f"{metric}_ci95"].fillna(0), marker="o", capsize=4)
        ax.set_xlabel("alpha")
        ax.set_ylabel(label)
    fig.tight_layout()
    fig.savefig(out, dpi=140)
    plt.close(fig)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--results", default=str(ROOT / "experiments" / "results"))
    args = ap.parse_args()
    results = Path(args.results)

    conn = connect()
    rows = []
    for d in sorted(results.glob("*/meta.json")):
        r = analyze_run(conn, d.parent)
        if r:
            rows.append(r)
    if not rows:
        print("no runs found")
        return
    runs = pd.DataFrame(rows)
    runs.to_csv(results / "runs.csv", index=False)
    summary = summarize(runs)
    summary.to_csv(results / "summary.csv", index=False)

    plots = results / "plots"
    plots.mkdir(exist_ok=True)
    for wl in sorted(runs.workload.unique()):
        bar_by_policy(summary, wl, "contention_precision", "contention precision", plots / f"{wl}_precision.png")
        bar_by_policy(summary, wl, "victim_p99_ms", "victim p99 (ms)", plots / f"{wl}_victim_p99.png")
        bar_by_policy(summary, wl, "false_positives_per_min", "false positives / min", plots / f"{wl}_false_positives.png")
    beta_plot(summary, plots / "beta_ablation.png")
    alpha_plot(summary, plots / "alpha_ablation.png")

    pd.set_option("display.width", 220)
    print(runs.round(3).to_string(index=False))


if __name__ == "__main__":
    main()

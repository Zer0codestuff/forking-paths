"""Benchmark inputs and the engine-side benchmark (CPython).

    python3 bench/bench.py [--rows 10000] [--indicators 12] [--specs 512]

Generates bench/out/bench-<rows>x<indicators>.csv (seeded synthetic data with 2% missing
values), runs a ranking plan with `specs` specifications through fpengine.api exactly as the
browser does, and writes bench/out/engine-results.json.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import platform
import resource
import sys
import time

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "engine"))
from fpengine import api, runtime_info  # noqa: E402


def generate(rows: int, k: int, path: str) -> list[str]:
    rng = np.random.Generator(np.random.PCG64(42))
    latent = rng.normal(size=rows)
    names = [f"ind_{j + 1:02d}" for j in range(k)]
    with open(path, "w", newline="") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(["entity", *names])
        for i in range(rows):
            vals = []
            for j in range(k):
                v = 50 + 10 * (0.6 * latent[i] + 0.8 * rng.normal()) + j
                vals.append("" if rng.random() < 0.02 else f"{v:.3f}")
            w.writerow([f"E{i:05d}", *vals])
    return names


def plan_for(names: list[str], specs: int) -> dict:
    per = 3 * 2  # normalizations x missing rules, arithmetic only
    draws = int(np.ceil(specs / per)) - 1
    return {
        "schema": "fp.plan/1", "workflow": "ranking", "title": "benchmark", "entity": "entity",
        "indicators": [{"column": n, "direction": "higher" if j % 3 else "lower", "unit": "", "include": True} for j, n in enumerate(names)],
        "decisions": {
            "normalization": {"options": [{"id": "minmax"}, {"id": "zscore"}, {"id": "rank"}]},
            "missing": {"options": [{"id": "exclude"}, {"id": "median"}]},
            "aggregation": {"options": [{"id": "arithmetic"}]},
            "weights": {"fixed": [{"id": "equal", "weights": {n: 1 for n in names}}], "sampling": {"enabled": True, "count": draws, "seed": 7, "alpha": 1.0, "minWeight": 0, "maxWeight": 1, "maxAttempts": 1000}},
        },
        "ties": "min", "constantRule": "invalid", "topK": 100, "maxSpecs": specs,
    }


def dataset_from_csv(path: str) -> dict:
    with open(path) as fh:
        r = list(csv.reader(fh))
    header, body = r[0], r[1:]
    cols = [{"name": header[0], "kind": "string", "values": [b[0] for b in body]}]
    for j in range(1, len(header)):
        cols.append({"name": header[j], "kind": "number", "values": [None if b[j] == "" else float(b[j]) for b in body]})
    return {"schema": "fp.dataset/1", "columns": cols}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--rows", type=int, default=10000)
    ap.add_argument("--indicators", type=int, default=12)
    ap.add_argument("--specs", type=int, default=512)
    a = ap.parse_args()
    os.makedirs("bench/out", exist_ok=True)
    path = f"bench/out/bench-{a.rows}x{a.indicators}.csv"
    names = generate(a.rows, a.indicators, path)
    plan = plan_for(names, a.specs)
    json.dump(plan, open("bench/out/bench-plan.json", "w"))
    t0 = time.perf_counter()
    ds = dataset_from_csv(path)
    ds_json = json.dumps(ds)
    t_load = time.perf_counter() - t0
    timings = []
    for _ in range(3):
        t0 = time.perf_counter()
        out = api.run_all(ds_json, json.dumps(plan))
        timings.append(time.perf_counter() - t0)
    res = json.loads(out)
    report = {
        "input": {"rows": a.rows, "indicators": a.indicators, "csvBytes": os.path.getsize(path), "missingShare": 0.02, "plannedSpecs": len(res["specs"]), "computedSpecs": res["selection"]["computed"], "resultJsonBytes": len(out)},
        "counts": res["summary"]["counts"],
        "runtime": runtime_info(),
        "host": {"platform": platform.platform(), "cpu": platform.processor() or platform.machine(), "cpus": os.cpu_count()},
        "seconds": {"csvToDataset (test helper, not the app importer)": round(t_load, 3), "runAll": [round(t, 3) for t in timings], "runAllMedian": round(sorted(timings)[1], 3)},
        "maxRssMb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1),
    }
    json.dump(report, open("bench/out/engine-results.json", "w"), indent=2)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()

"""Command-line reproduction tool.

    python -m fpengine info
    python -m fpengine examples [--out public/examples]
    python -m fpengine run --dataset dataset.json --plan plan.json [--out result.json]
    python -m fpengine reproduce project.fpbundle.json [--json]

`reproduce` recomputes every stored result from the bundle's dataset and plans with this same
engine and compares values within the documented tolerance. Exit code 0 means everything matched.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import sys

import numpy as np

from . import SCHEMAS, api, runtime_info
from .canonical import dataset_hash, hash_json

MAX_BUNDLE_BYTES = 200 * 1024 * 1024
TOLERANCE = {"rank": 0.0, "scoreAbs": 1e-9, "estimateRel": 1e-8, "estimateAbs": 1e-12}


def _close(a, b, rel=TOLERANCE["estimateRel"], abs_=TOLERANCE["estimateAbs"]) -> bool:
    if a is None or b is None:
        return a is None and b is None
    return abs(a - b) <= max(abs_, rel * max(abs(a), abs(b)))


def compare_results(stored: dict, fresh: dict) -> list[dict]:
    checks = []

    def add(name, ok, detail):
        checks.append({"name": name, "ok": bool(ok), "detail": detail})

    add("cache key inputs", stored["datasetHash"] == fresh["datasetHash"] and stored["planHash"] == fresh["planHash"], f"dataset {fresh['datasetHash'][:12]}, plan {fresh['planHash'][:12]}")
    st_a = [s["status"] for s in stored["specs"]]
    st_b = [s["status"] for s in fresh["specs"]]
    add("specification statuses", st_a == st_b, f"{sum(x == y for x, y in zip(st_a, st_b))} of {len(st_a)} match")
    if stored["workflow"] == "ranking":
        shape = tuple(stored["arrays"]["shape"])
        ra = api.unb64(stored["arrays"]["ranks"], "<f4", shape)
        rb = api.unb64(fresh["arrays"]["ranks"], "<f4", shape)
        both = ~np.isnan(ra) & ~np.isnan(rb)
        same_mask = np.array_equal(np.isnan(ra), np.isnan(rb))
        dr = float(np.max(np.abs(ra[both] - rb[both]))) if both.any() else 0.0
        add("ranks", same_mask and dr <= TOLERANCE["rank"], f"max rank difference {dr:g} over {int(both.sum())} ranked cells (tolerance {TOLERANCE['rank']})")
        sa = api.unb64(stored["arrays"]["scores"], "<f8", shape)
        sb = api.unb64(fresh["arrays"]["scores"], "<f8", shape)
        bs = ~np.isnan(sa) & ~np.isnan(sb)
        ds = float(np.max(np.abs(sa[bs] - sb[bs]))) if bs.any() else 0.0
        add("scores", ds <= TOLERANCE["scoreAbs"], f"max absolute score difference {ds:.3g} (tolerance {TOLERANCE['scoreAbs']:g})")
        ea = {e["id"]: e for e in stored["summary"]["entities"]}
        worst = 0.0
        for e in fresh["summary"]["entities"]:
            if "topK" in e and "topK" in ea.get(e["id"], {}):
                worst = max(worst, abs(e["topK"] - ea[e["id"]]["topK"]), abs(e["median"] - ea[e["id"]]["median"]))
        add("rank summaries", worst <= 1e-12, f"max difference in top-k fraction or median rank {worst:g}")
    else:
        worst, n = 0.0, 0
        ok = True
        for a, b in zip(stored["specs"], fresh["specs"]):
            for k in ("estimate", "low", "high", "se"):
                if not _close(a.get(k), b.get(k)):
                    ok = False
                if a.get(k) is not None and b.get(k) is not None:
                    worst = max(worst, abs(a[k] - b[k]) / max(1e-300, abs(a[k]), abs(b[k])))
                    n += 1
        add("estimates and intervals", ok, f"{n} values, max relative difference {worst:.3g} (tolerance {TOLERANCE['estimateRel']:g})")
    return checks


def reproduce(path: str) -> dict:
    size = os.path.getsize(path)
    report = {"bundle": path, "runtime": runtime_info(), "checks": []}

    def add(name, ok, detail):
        report["checks"].append({"name": name, "ok": bool(ok), "detail": detail})

    if size > MAX_BUNDLE_BYTES:
        add("size limit", False, f"{size} bytes exceeds {MAX_BUNDLE_BYTES}")
        report["ok"] = False
        return report
    with open(path, "r", encoding="utf-8") as fh:
        bundle = json.load(fh)
    add("bundle schema", bundle.get("schema") == SCHEMAS["bundle"], f"{bundle.get('schema')!r}")
    src = bundle.get("source") or {}
    if src.get("bytesBase64") is not None:
        raw = base64.b64decode(src["bytesBase64"])
        got = hashlib.sha256(raw).hexdigest()
        add("source bytes", got == src.get("sha256"), f"sha256 {got[:16]} ({len(raw)} bytes); identifies bytes, does not prove provenance")
    else:
        add("source bytes", True, f"not embedded; reference {src.get('url') or 'unknown'} sha256 {str(src.get('sha256'))[:16]}")
    ds = bundle["dataset"]
    dh = dataset_hash(ds["columns"])
    add("dataset", dh == ds.get("hash"), f"computed {dh[:16]}, recorded {str(ds.get('hash'))[:16]}")
    plans = {hash_json(p): p for p in bundle.get("plans", [])}
    for res in bundle.get("results", []):
        plan = plans.get(res["planHash"])
        if plan is None:
            add(f"result {res['key'][:12]}", False, "no plan in the bundle matches the result's plan hash")
            continue
        fresh = json.loads(api.run_all(json.dumps(ds), json.dumps(plan)))
        for c in compare_results(res, fresh):
            add(f"{plan.get('title', plan['workflow'])}: {c['name']}", c["ok"], c["detail"])
        stored_rt = res.get("runtime", {})
        report.setdefault("runtimeDifferences", []).append({k: [stored_rt.get(k), report["runtime"].get(k)] for k in ("python", "numpy", "scipy") if stored_rt.get(k) != report["runtime"].get(k)})
    report["ok"] = all(c["ok"] for c in report["checks"])
    return report


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="fpengine", description="Forking Paths numerical engine and reproduction tool")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("info")
    ex = sub.add_parser("examples")
    ex.add_argument("--out", default="public/examples")
    r = sub.add_parser("run")
    r.add_argument("--dataset", required=True)
    r.add_argument("--plan", required=True)
    r.add_argument("--out")
    rp = sub.add_parser("reproduce")
    rp.add_argument("bundle")
    rp.add_argument("--json", action="store_true")
    a = p.parse_args(argv)
    if a.cmd == "info":
        print(api.info())
        return 0
    if a.cmd == "examples":
        from .examples import write_all

        for f in write_all(a.out):
            print(os.path.join(a.out, f))
        return 0
    if a.cmd == "run":
        with open(a.dataset, encoding="utf-8") as fh:
            ds = fh.read()
        with open(a.plan, encoding="utf-8") as fh:
            pl = fh.read()
        out = api.run_all(ds, pl)
        if a.out:
            with open(a.out, "w", encoding="utf-8") as fh:
                fh.write(out)
        res = json.loads(out)
        counts = res["summary"]["counts"] if res["workflow"] == "ranking" else res["counts"]
        print(f"{res['workflow']} result {res['key'][:12]}: " + ", ".join(f"{k} {v}" for k, v in counts.items()))
        return 0
    if a.cmd == "reproduce":
        rep = reproduce(a.bundle)
        if a.json:
            print(json.dumps(rep, indent=2))
        else:
            rt = rep["runtime"]
            print(f"Reproducing {a.bundle} with engine {rt['engine']}, Python {rt['python']}, NumPy {rt['numpy']}, SciPy {rt['scipy']}")
            for c in rep["checks"]:
                print(f"  [{'ok' if c['ok'] else 'FAIL'}] {c['name']}: {c['detail']}")
            for d in rep.get("runtimeDifferences", []):
                if d:
                    print("  runtime differs from the exporting runtime: " + ", ".join(f"{k} {v[0]} -> {v[1]}" for k, v in d.items()))
            print("REPRODUCED within tolerance." if rep["ok"] else "NOT REPRODUCED.")
        return 0 if rep["ok"] else 1
    return 2


if __name__ == "__main__":
    sys.exit(main())

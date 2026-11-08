"""Result comparison used by CLI reproduction and by in-browser reproduction of imported bundles."""

from __future__ import annotations

import numpy as np

MAX_BUNDLE_BYTES = 200 * 1024 * 1024

from .api import unb64

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
        ra = unb64(stored["arrays"]["ranks"], "<f4", shape)
        rb = unb64(fresh["arrays"]["ranks"], "<f4", shape)
        both = ~np.isnan(ra) & ~np.isnan(rb)
        same_mask = np.array_equal(np.isnan(ra), np.isnan(rb))
        dr = float(np.max(np.abs(ra[both] - rb[both]))) if both.any() else 0.0
        add("ranks", same_mask and dr <= TOLERANCE["rank"], f"max rank difference {dr:g} over {int(both.sum())} ranked cells (tolerance {TOLERANCE['rank']})")
        sa = unb64(stored["arrays"]["scores"], "<f8", shape)
        sb = unb64(fresh["arrays"]["scores"], "<f8", shape)
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



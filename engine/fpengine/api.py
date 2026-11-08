"""JSON-in, JSON-out entry points shared by the browser worker and the CLI.

Large numeric arrays cross the boundary as base64 little-endian buffers: ranks as float32 (exact
for integer and half-integer ranks below 2**24) and scores as float64.
"""

from __future__ import annotations

import base64
import json
from datetime import datetime, timezone
from typing import Any

import numpy as np

from . import ENGINE_VERSION, SCHEMAS, ranking, relationship, runtime_info
from .canonical import canonical_json, dataset_hash, hash_json

_SESSIONS: dict[str, dict] = {}


def b64(a: np.ndarray, dtype: str) -> str:
    return base64.b64encode(np.ascontiguousarray(a, dtype=dtype).tobytes()).decode("ascii")


def unb64(s: str, dtype: str, shape: tuple[int, ...]) -> np.ndarray:
    return np.frombuffer(base64.b64decode(s), dtype=dtype).reshape(shape).astype(float)


def _json(obj: Any) -> str:
    return json.dumps(obj, allow_nan=False, default=lambda o: o.item() if hasattr(o, "item") else str(o))


def _clean(v: Any) -> Any:
    """Replace NaN/inf with None so results are valid JSON."""
    if isinstance(v, float):
        return v if np.isfinite(v) else None
    if isinstance(v, dict):
        return {k: _clean(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_clean(x) for x in v]
    return v


def _load(x: Any) -> Any:
    """Accept JSON text (CLI) or already-decoded objects (browser worker passes plain values)."""
    return json.loads(x) if isinstance(x, (str, bytes)) else x


def _selection(n: int, limit: int, seed: int) -> list[int]:
    """Specifications to compute when the limit is below the planned count: a uniform random
    subset drawn with a recorded seed, so truncation does not drop whole decision options."""
    if limit >= n:
        return list(range(n))
    rng = np.random.Generator(np.random.PCG64(seed))
    return sorted(int(i) for i in rng.choice(n, size=limit, replace=False))


def info() -> str:
    return _json({"runtime": runtime_info(), "schemas": SCHEMAS, "algorithms": {"ranking": ranking.ALGORITHM_VERSION, "relationship": relationship.ALGORITHM_VERSION}, "methods": {"normalization": ranking.NORMALIZATIONS, "missing": ranking.MISSING_RULES, "aggregation": ranking.AGGREGATIONS, "ties": ranking.TIE_RULES}})


def hash_dataset(dataset_json: str) -> str:
    return dataset_hash(_load(dataset_json)["columns"])


def plan_hash(plan: dict) -> str:
    return hash_json(plan)


def plan_info(dataset_json: str, plan_json: str) -> str:
    plan = _load(plan_json)
    try:
        if plan["workflow"] == "ranking":
            c = ranking.planned_count(plan)
        else:
            specs = relationship.enumerate_specs(plan)
            limit = int(plan.get("maxSpecs", len(specs)))
            c = {"planned": len(specs), "limit": limit, "willRun": min(limit, len(specs)), "uncomputed": max(0, len(specs) - limit)}
            c["blockedIntervals"] = sorted({s["interval"] + ": " + r for s in specs if (r := relationship.interval_validity(plan, s["interval"]))})
        return _json({"ok": True, **c, "planHash": plan_hash(plan)})
    except (ranking.PlanError, relationship.PlanError, KeyError) as e:
        return _json({"ok": False, "error": str(e)})


def start(dataset_json: str, plan_json: str) -> str:
    """Validate inputs and enumerate specifications. Returns a session id and the cache key."""
    dataset = _load(dataset_json)
    plan = _load(plan_json)
    dh = dataset_hash(dataset["columns"])
    if dataset.get("hash") and dataset["hash"] != dh:
        raise ValueError(f"Dataset hash mismatch: recorded {dataset['hash'][:12]}, computed {dh[:12]}")
    rt = runtime_info()
    if plan["workflow"] == "ranking":
        specs = ranking.enumerate_specs(plan)
        prep = ranking.prepare(dataset, plan)
        key = ranking.plan_key(dh, plan, rt)
        n = len(prep.entity_ids)
        sess = {"workflow": "ranking", "plan": plan, "dataset": dataset, "prep": prep, "specs": specs, "scores": np.full((len(specs), n), np.nan), "ranks": np.full((len(specs), n), np.nan), "remaining": [None] * len(specs), "excludedCount": [None] * len(specs)}
    elif plan["workflow"] == "relationship":
        specs = relationship.enumerate_specs(plan)
        key = relationship.plan_key(dh, plan, rt)
        sess = {"workflow": "relationship", "plan": plan, "dataset": dataset, "specs": specs, "results": [None] * len(specs)}
    else:
        raise ValueError(f"Unknown workflow {plan.get('workflow')!r}")
    limit = min(int(plan.get("maxSpecs", len(specs))), len(specs))
    order = _selection(len(specs), limit, int(plan.get("limitSeed", 0)))
    sess.update({"key": key, "datasetHash": dh, "limit": limit, "order": order, "selected": set(order), "runtime": rt, "next": 0})
    _SESSIONS[key] = sess
    return _json({"key": key, "datasetHash": dh, "planHash": plan_hash(plan), "planned": len(specs), "limit": sess["limit"], "subset": limit < len(specs), "runtime": rt})


def run_batch(key: str, count: int) -> str:
    """Compute up to `count` further specifications. Returns progress."""
    s = _SESSIONS[key]
    end = min(s["limit"], s["next"] + int(count))
    for i in s["order"][s["next"]:end]:
        if s["workflow"] == "ranking":
            spec = s["specs"][i]
            if spec.status == "invalid":
                continue
            r = ranking.compute_spec(s["prep"], spec, s["plan"])
            spec.status = r["status"]
            spec.reason = r.get("reason")
            spec.notes = r.get("notes", [])
            s["excludedCount"][i] = len(r.get("excluded", {}))
            if r["status"] == "valid":
                s["scores"][i] = r["scores"]
                s["ranks"][i] = r["ranks"]
                s["remaining"][i] = r["remaining"]
        else:
            s["results"][i] = relationship.fit(s["dataset"], s["plan"], s["specs"][i])
    s["next"] = end
    return _json({"done": end, "limit": s["limit"], "finished": end >= s["limit"]})


def finish(key: str, cancelled: bool = False, created_at: str | None = None) -> str:
    """Close the session and return the full result record. Specs not reached are 'cancelled' if
    the user stopped the run, and specs beyond the limit are 'uncomputed'."""
    s = _SESSIONS.pop(key)
    created = created_at or datetime.now(timezone.utc).isoformat()
    selection = {"planned": len(s["specs"]), "computed": s["limit"], "method": "all" if s["limit"] >= len(s["specs"]) else f"uniform random subset without replacement, NumPy PCG64 seed {int(s['plan'].get('limitSeed', 0))}"}
    base = {"selection": selection, "schema": SCHEMAS["result"], "workflow": s["workflow"], "key": key, "datasetHash": s["datasetHash"], "planHash": plan_hash(s["plan"]), "runtime": s["runtime"], "createdAt": created, "engine": ENGINE_VERSION}
    if s["workflow"] == "ranking":
        specs = s["specs"]
        for i, spec in enumerate(specs):
            if spec.status == "pending" or (spec.status == "invalid" and i not in s["selected"]):
                if i in s["selected"]:
                    spec.status, spec.reason = "cancelled", "Run cancelled before this specification"
                else:
                    spec.status, spec.reason = "uncomputed", f"Not in the seeded random subset of {s['limit']} of {len(specs)} specifications"
        top_k = int(s["plan"].get("topK", 10))
        rec = {
            **base,
            "algorithm": ranking.ALGORITHM_VERSION,
            "entities": s["prep"].entity_ids,
            "indicators": s["prep"].names,
            "specs": [{**sp.describe(), "status": sp.status, "reason": sp.reason, "notes": sp.notes, "remaining": s["remaining"][i], "excludedCount": s["excludedCount"][i]} for i, sp in enumerate(specs)],
            "summary": ranking.summarize(s["prep"], specs, s["ranks"], top_k),
            "digest": ranking.result_digest(specs, s["scores"], s["ranks"]),
            "arrays": {"shape": list(s["ranks"].shape), "ranks": b64(s["ranks"], "<f4"), "scores": b64(s["scores"], "<f8")},
        }
    else:
        specs = s["specs"]
        results = []
        for i, r in enumerate(s["results"]):
            if r is None:
                r = {"status": "cancelled", "reason": "Run cancelled before this specification"} if i in s["selected"] else {"status": "uncomputed", "reason": f"Not in the seeded random subset of {s['limit']} of {len(specs)} specifications"}
            results.append(r)
        counts = {k: sum(1 for r in results if r["status"] == k) for k in ("valid", "invalid", "cancelled", "uncomputed")}
        rec = {
            **base,
            "algorithm": relationship.ALGORITHM_VERSION,
            "specs": [{**sp, **{k: v for k, v in r.items() if k != "detail"}} for sp, r in zip(specs, results)],
            "counts": counts,
            "summary": relationship.summarize(s["plan"], specs, results),
            "digest": {"estimates": hash_json([[r.get("status"), None if r.get("estimate") is None else round(r["estimate"], 9)] for r in results])},
        }
    return _json(_clean(rec))


def run_all(dataset_json: str, plan_json: str, batch: int = 64) -> str:
    key = json.loads(start(dataset_json, plan_json))["key"]
    while not json.loads(run_batch(key, batch))["finished"]:
        pass
    return finish(key)


def inspect(dataset_json: str, plan_json: str, spec_index: int) -> str:
    """Recompute one specification with full detail (inputs, exclusions, normalized values, contributions)."""
    dataset, plan = _load(dataset_json), _load(plan_json)
    if plan["workflow"] == "ranking":
        specs = ranking.enumerate_specs(plan)
        spec = specs[spec_index]
        if spec.status == "invalid":
            return _json(_clean({"spec": spec.describe(), "status": "invalid", "reason": spec.reason}))
        prep = ranking.prepare(dataset, plan)
        r = ranking.compute_spec(prep, spec, plan, detail=True)
        out = {"spec": spec.describe(), "status": r["status"], "reason": r.get("reason"), "notes": r.get("notes", []), "excluded": [{"entity": prep.entity_ids[k], "reason": v} for k, v in sorted(r.get("excluded", {}).items())], "methods": {"normalization": ranking.NORMALIZATIONS[spec.normalization], "missing": ranking.MISSING_RULES[spec.missing], "aggregation": ranking.AGGREGATIONS[spec.aggregation], "ties": ranking.TIE_RULES[plan.get("ties", "min")]}}
        if r["status"] == "valid":
            d = r["detail"]
            out["rows"] = [
                {"entity": prep.entity_ids[e], "rank": float(r["ranks"][e]), "score": float(r["scores"][e]), "raw": d["raw"][i], "normalized": d["normalized"][i], "contributions": d["contributions"][i], "imputed": d["imputed"][i]}
                for i, e in enumerate(d["entityIndex"])
            ]
            out["rows"].sort(key=lambda x: (x["rank"], x["entity"]))
            out["indicators"] = d["indicators"]
            out["weights"] = d["weights"]
            out["contributionScale"] = d["contributionScale"]
        return _json(_clean(out))
    specs = relationship.enumerate_specs(plan)
    r = relationship.fit(dataset, plan, specs[spec_index], detail=True)
    return _json(_clean({"spec": specs[spec_index], "estimandLabel": relationship.estimand_label(plan, specs[spec_index]["estimand"]), **r}))


def query_pairwise(ranks_b64: str, shape: list[int], valid: list[bool], idx: list[int]) -> str:
    R = unb64(ranks_b64, "<f4", tuple(shape))
    R[R != R] = np.nan
    return _json(_clean(ranking.pairwise(R, np.array(valid, dtype=bool), idx)))


def query_influence(dataset_json: str, plan_json: str, ranks_b64: str, shape: list[int], statuses: list[str], entity: int) -> str:
    dataset, plan = _load(dataset_json), _load(plan_json)
    prep = ranking.prepare(dataset, plan)
    specs = ranking.enumerate_specs(plan)
    for s, st in zip(specs, statuses):
        s.status = st
    R = unb64(ranks_b64, "<f4", tuple(shape))
    return _json(_clean(ranking.influence(prep, specs, R, entity)))


def canonical(value_json: str) -> str:
    return canonical_json(json.loads(value_json))


def compare(stored_json: str, fresh_json: str) -> str:
    from .reproduce import TOLERANCE, compare_results

    checks = compare_results(_load(stored_json), _load(fresh_json))
    return _json({"ok": all(c["ok"] for c in checks), "checks": checks, "tolerance": TOLERANCE})

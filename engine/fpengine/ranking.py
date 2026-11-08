"""Ranking robustness: composite indicators under alternative normalization, missing-data,
aggregation and weighting decisions.

Every specification is one combination of decision options. Specifications are enumerated in a
fixed order, so a pinned plan always produces the same list. Sampled weights come from a seeded
NumPy PCG64 generator and are drawn when the plan is enumerated, never during execution.

Outcomes per specification: "valid", "invalid" (with a reason), "cancelled" or "uncomputed"
(beyond the specification limit). None are dropped.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from itertools import product
from typing import Any

import numpy as np

from .canonical import computational, array_digest, hash_json

ALGORITHM_VERSION = "ranking/1"

NORMALIZATIONS = {
    "minmax": "Min-max to [0, 1]: (x - min) / (max - min). Lower-is-better indicators use (max - x) / (max - min).",
    "zscore": "Standard score: (x - mean) / sd with sample sd (ddof = 1). Lower-is-better indicators are negated.",
    "rank": "Percentile rank: (average rank - 0.5) / n, in (0, 1). Lower-is-better indicators are reversed. Insensitive to outliers; discards distances.",
    "target": "Distance to best: x / max for higher-is-better, min / x for lower-is-better. Requires strictly positive values.",
}
MISSING_RULES = {
    "exclude": "Exclude any entity with a missing value in an included indicator.",
    "median": "Replace a missing value with the median of the observed values of that indicator.",
    "worst": "Replace a missing value with the worst observed value of that indicator.",
}
AGGREGATIONS = {
    "arithmetic": "Weighted arithmetic mean of normalized values. Indicators fully compensate each other.",
    "geometric": "Weighted geometric mean. Requires strictly positive normalized values; compensation is partial.",
}
TIE_RULES = {"min": "Tied entities share the best rank of their group (1, 2, 2, 4).", "average": "Tied entities share the average rank of their group (1, 2.5, 2.5, 4)."}
SCORE_SIGNIFICANT_DIGITS = 12  # scores are rounded to this many significant digits before ranking


@dataclass
class Spec:
    index: int
    normalization: str
    missing: str
    aggregation: str
    weights_id: str
    weights: dict[str, float]
    weights_source: str  # "fixed" or "sampled"
    status: str = "pending"
    reason: str | None = None
    notes: list[str] = field(default_factory=list)

    def describe(self) -> dict:
        return {
            "index": self.index,
            "normalization": self.normalization,
            "missing": self.missing,
            "aggregation": self.aggregation,
            "weightsId": self.weights_id,
            "weightsSource": self.weights_source,
            "weights": self.weights,
        }


class PlanError(ValueError):
    pass


def _indicator_columns(plan: dict) -> list[dict]:
    inds = [i for i in plan["indicators"] if i.get("include", True)]
    if len(inds) < 2:
        raise PlanError("A ranking needs at least two included indicators.")
    for i in inds:
        if i.get("direction") not in ("higher", "lower"):
            raise PlanError(f"Indicator {i.get('column')!r} needs direction 'higher' or 'lower'.")
    return inds


def sample_weights(names: list[str], sampling: dict) -> list[tuple[str, dict[str, float] | None, str | None]]:
    """Seeded Dirichlet sampling with optional per-indicator bounds (rejection sampling).

    Returns (id, weights or None, failure reason) for every requested draw, so draws that cannot
    satisfy the constraints are reported instead of silently skipped.
    """
    count = int(sampling.get("count", 0))
    if count <= 0:
        return []
    seed = int(sampling["seed"])
    alpha = float(sampling.get("alpha", 1.0))
    if alpha <= 0:
        raise PlanError("Dirichlet concentration alpha must be positive.")
    lo = float(sampling.get("minWeight", 0.0))
    hi = float(sampling.get("maxWeight", 1.0))
    max_attempts = int(sampling.get("maxAttempts", 1000))
    rng = np.random.Generator(np.random.PCG64(seed))
    out = []
    for d in range(count):
        found = None
        for _ in range(max_attempts):
            w = rng.dirichlet(np.full(len(names), alpha))
            if np.all(w >= lo - 1e-15) and np.all(w <= hi + 1e-15):
                found = w
                break
        sid = f"sample-{d + 1:04d}"
        if found is None:
            out.append((sid, None, f"No Dirichlet draw satisfied {lo} <= w <= {hi} within {max_attempts} attempts"))
        else:
            out.append((sid, {n: float(x) for n, x in zip(names, found)}, None))
    return out


def enumerate_specs(plan: dict) -> list[Spec]:
    inds = _indicator_columns(plan)
    names = [i["column"] for i in inds]
    dec = plan["decisions"]
    norms = [o["id"] for o in dec["normalization"]["options"]]
    missing = [o["id"] for o in dec["missing"]["options"]]
    aggs = [o["id"] for o in dec["aggregation"]["options"]]
    for group, allowed, chosen in (("normalization", NORMALIZATIONS, norms), ("missing", MISSING_RULES, missing), ("aggregation", AGGREGATIONS, aggs)):
        if not chosen:
            raise PlanError(f"Choose at least one {group} option.")
        for c in chosen:
            if c not in allowed:
                raise PlanError(f"Unknown {group} option {c!r}.")
    weight_cfgs: list[tuple[str, dict[str, float] | None, str, str | None]] = []
    for fw in dec["weights"].get("fixed", []):
        w = {n: float(fw["weights"].get(n, 0.0)) for n in names}
        reason = None
        if any(v < 0 for v in w.values()):
            reason = "Fixed weights must be non-negative"
        elif sum(w.values()) <= 0:
            reason = "Fixed weights sum to zero"
        total = sum(w.values())
        weight_cfgs.append((fw["id"], None if reason else {n: v / total for n, v in w.items()}, "fixed", reason))
    sampling = dec["weights"].get("sampling")
    if sampling and sampling.get("enabled", True):
        for sid, w, reason in sample_weights(names, sampling):
            weight_cfgs.append((sid, w, "sampled", reason))
    if not weight_cfgs:
        raise PlanError("Declare at least one fixed weight configuration or enable sampling.")
    specs = []
    for idx, (n, m, a, (wid, w, src, reason)) in enumerate(product(norms, missing, aggs, weight_cfgs)):
        s = Spec(idx, n, m, a, wid, w or {}, src)
        if reason:
            s.status, s.reason = "invalid", reason
        specs.append(s)
    return specs


def planned_count(plan: dict) -> dict:
    specs = enumerate_specs(plan)
    limit = int(plan.get("maxSpecs", len(specs)))
    return {"planned": len(specs), "limit": limit, "willRun": min(limit, len(specs)), "uncomputed": max(0, len(specs) - limit)}


def _normalize_all(X: np.ndarray, method: str, directions: list[str]) -> tuple[np.ndarray, list[str | None]]:
    """Normalize every column at once. Returns the matrix and a per-column problem (or None)."""
    lower = np.array([d == "lower" for d in directions])
    lo, hi = X.min(axis=0), X.max(axis=0)
    const = hi == lo
    problems: list[str | None] = ["constant" if c else None for c in const]
    with np.errstate(divide="ignore", invalid="ignore"):
        if method == "minmax":
            rng = np.where(const, 1.0, hi - lo)
            Z = np.where(lower, (hi - X) / rng, (X - lo) / rng)
        elif method == "zscore":
            if X.shape[0] < 2:
                return X, ["too few entities for a sample standard deviation"] * X.shape[1]
            sd = X.std(axis=0, ddof=1)
            problems = ["constant" if s == 0 else None for s in sd]
            Z = (X - X.mean(axis=0)) / np.where(sd == 0, 1.0, sd)
            Z = np.where(lower, -Z, Z)
        elif method == "rank":
            from scipy.stats import rankdata

            Z = (rankdata(X, method="average", axis=0) - 0.5) / X.shape[0]
            Z = np.where(lower, 1.0 - Z, Z)
        elif method == "target":
            problems = ["non-positive values (target normalization requires x > 0)" if l <= 0 else ("constant" if c else None) for l, c in zip(lo, const)]
            Z = np.where(lower, lo / X, X / np.where(hi == 0, 1.0, hi))
        else:
            raise PlanError(f"Unknown normalization {method!r}")
    return Z, problems


def _round_sig(a: np.ndarray, digits: int) -> np.ndarray:
    out = np.zeros_like(a)
    nz = a != 0
    mags = np.floor(np.log10(np.abs(a[nz])))
    factors = 10.0 ** (digits - 1 - mags)
    out[nz] = np.round(a[nz] * factors) / factors
    return out + 0.0


def _rank(scores: np.ndarray, ties: str) -> np.ndarray:
    from scipy.stats import rankdata

    r = rankdata(-_round_sig(scores, SCORE_SIGNIFICANT_DIGITS), method="min" if ties == "min" else "average")
    return r.astype(float)


class _Count(dict):
    """Exclusion count without building per-entity reason strings (batch runs)."""

    def __init__(self, n: int):
        super().__init__()
        self.n = n

    def __len__(self) -> int:
        return self.n


@dataclass
class Prepared:
    entity_ids: list[str]
    names: list[str]
    directions: list[str]
    matrix: np.ndarray  # n x m, NaN for missing


def prepare(dataset: dict, plan: dict) -> Prepared:
    cols = {c["name"]: c for c in dataset["columns"]}
    ent = plan["entity"]
    if ent not in cols:
        raise PlanError(f"Entity column {ent!r} is not in the dataset.")
    ids = ["" if v is None else str(v) for v in cols[ent]["values"]]
    if len(set(ids)) != len(ids):
        raise PlanError("Entity identifiers must be unique. Resolve duplicates during data inspection first.")
    inds = _indicator_columns(plan)
    mats = []
    for i in inds:
        c = cols.get(i["column"])
        if c is None:
            raise PlanError(f"Indicator column {i['column']!r} is not in the dataset.")
        if c["kind"] != "number":
            raise PlanError(f"Indicator {i['column']!r} is not numeric.")
        mats.append(np.array([np.nan if v is None else float(v) for v in c["values"]], dtype=float))
    return Prepared(ids, [i["column"] for i in inds], [i["direction"] for i in inds], np.column_stack(mats))


def compute_spec(prep: Prepared, spec: Spec, plan: dict, detail: bool = False) -> dict:
    """Run one specification. Returns scores and ranks over all entities (NaN where excluded)."""
    n_all = len(prep.entity_ids)
    X = prep.matrix.copy()
    miss = np.isnan(X)
    if spec.missing == "exclude":
        keep = ~miss.any(axis=1)
        if detail:
            excluded: dict[int, str] | _Count = {int(r): "missing " + ", ".join(prep.names[j] for j in np.where(miss[r])[0]) for r in np.where(~keep)[0]}
        else:
            excluded = _Count(int((~keep).sum()))
    else:
        keep = np.ones(n_all, dtype=bool)
        excluded = {} if detail else _Count(0)
        for j in range(X.shape[1]):
            obs = X[~miss[:, j], j]
            if len(obs) == 0:
                return {"status": "invalid", "reason": f"Indicator {prep.names[j]} has no observed values"}
            if spec.missing == "median":
                fill = float(np.median(obs))
            else:
                fill = float(np.min(obs) if prep.directions[j] == "higher" else np.max(obs))
            X[miss[:, j], j] = fill
    if keep.sum() < 2:
        return {"status": "invalid", "reason": f"Only {int(keep.sum())} entities remain after the missing-data rule", "excluded": excluded}
    Xk = X[keep]
    used, notes = [], []
    constant_rule = plan.get("constantRule", "invalid")
    Zall, problems = _normalize_all(Xk, spec.normalization, prep.directions)
    for j, name in enumerate(prep.names):
        problem = problems[j]
        if problem == "constant" and constant_rule == "drop":
            notes.append(f"Dropped constant indicator {name}; remaining weights renormalized")
            continue
        if problem:
            return {"status": "invalid", "reason": f"{spec.normalization} normalization undefined for {name}: {problem}", "excluded": excluded}
        used.append(j)
    if len(used) < 1:
        return {"status": "invalid", "reason": "No indicator left after dropping constant indicators", "excluded": excluded}
    Z = Zall[:, used] if len(used) < Zall.shape[1] else Zall
    w = np.array([spec.weights[prep.names[j]] for j in used], dtype=float)
    if w.sum() <= 0:
        return {"status": "invalid", "reason": "Weights of the remaining indicators sum to zero", "excluded": excluded}
    w = w / w.sum()
    if spec.aggregation == "arithmetic":
        contrib = Z * w
        scores_k = contrib.sum(axis=1)
    else:
        if np.any(Z <= 0):
            r, c = np.argwhere(Z <= 0)[0]
            ent = np.array(prep.entity_ids)[keep][r]
            return {"status": "invalid", "reason": f"Geometric mean undefined: normalized {prep.names[used[c]]} is {Z[r, c]:.3g} for {ent} (requires > 0)", "excluded": excluded}
        contrib = w * np.log(Z)  # additive on the log scale
        scores_k = np.exp(contrib.sum(axis=1))
    ranks_k = _rank(scores_k, plan.get("ties", "min"))
    scores = np.full(n_all, np.nan)
    ranks = np.full(n_all, np.nan)
    scores[keep] = scores_k
    ranks[keep] = ranks_k
    out: dict[str, Any] = {"status": "valid", "scores": scores, "ranks": ranks, "excluded": excluded, "notes": notes, "remaining": int(keep.sum())}
    if detail:
        out["detail"] = {
            "indicators": [prep.names[j] for j in used],
            "weights": w.tolist(),
            "entityIndex": np.where(keep)[0].tolist(),
            "raw": Xk[:, used].tolist(),
            "normalized": Z.tolist(),
            "contributions": contrib.tolist(),
            "contributionScale": "share of the score" if spec.aggregation == "arithmetic" else "weighted log of the normalized value (scores are exp of the sum)",
            "imputed": [[bool(miss[r, j]) and spec.missing != "exclude" for j in used] for r in np.where(keep)[0]],
        }
    return out


def plan_key(dataset_hash: str, plan: dict, runtime: dict) -> str:
    """Cache key: input content, plan, algorithm version, seed (inside the plan) and runtime."""
    return hash_json({"dataset": dataset_hash, "plan": computational(plan), "algorithm": ALGORITHM_VERSION, "runtime": {k: runtime[k] for k in ("engine", "numpy", "scipy")}})


def summarize(prep: Prepared, specs: list[Spec], ranks: np.ndarray, top_k: int) -> dict:
    """Per-entity rank distributions over valid specifications. ranks: specs x entities, NaN when excluded/invalid."""
    valid = np.array([s.status == "valid" for s in specs], dtype=bool)
    R = ranks[valid] if valid.any() else np.zeros((0, len(prep.entity_ids)))
    evaluated = (~np.isnan(R)).sum(axis=0)
    entities = []
    if R.shape[0]:
        import warnings

        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)  # all-NaN columns are reported as not evaluated
            mean = np.nanmean(R, axis=0)
        # Linear-interpolation quantiles (NumPy's default method) for every entity at once:
        # sorting puts NaN last, so each column's first `evaluated` values are its ranks.
        Rs = np.sort(R, axis=0)
        nn = np.maximum(evaluated, 1)
        q = np.empty((7, R.shape[1]))
        for qi, p in enumerate((0.0, 0.05, 0.25, 0.5, 0.75, 0.95, 1.0)):
            pos = p * (nn - 1)
            i0 = np.floor(pos).astype(int)
            i1 = np.minimum(i0 + 1, nn - 1)
            t = pos - i0
            a = np.take_along_axis(Rs, i0[None, :], 0)[0]
            b = np.take_along_axis(Rs, i1[None, :], 0)[0]
            q[qi] = a + (b - a) * t
        ranked = ~np.isnan(R)
        top = np.where(ranked, R <= top_k, False).sum(axis=0)
        best = np.where(ranked, R == 1, False).sum(axis=0)
    for e, eid in enumerate(prep.entity_ids):
        n = int(evaluated[e])
        if n == 0:
            entities.append({"id": eid, "evaluated": 0})
            continue
        entities.append({
            "id": eid,
            "evaluated": n,
            "min": float(q[0, e]), "p05": float(q[1, e]), "p25": float(q[2, e]), "median": float(q[3, e]), "p75": float(q[4, e]), "p95": float(q[5, e]), "max": float(q[6, e]),
            "mean": float(mean[e]),
            "topK": float(top[e] / n),
            "best": float(best[e] / n),
        })
    counts = {k: sum(1 for s in specs if s.status == k) for k in ("valid", "invalid", "cancelled", "uncomputed")}
    return {"entities": entities, "counts": counts, "topK": top_k, "topKNote": f"Fraction of the {int(valid.sum())} evaluated valid specifications in which the entity ranks in the top {top_k}. It describes the declared specification space, not the probability that a ranking is true."}


def pairwise(ranks: np.ndarray, valid: np.ndarray, idx: list[int]) -> list[list[float | None]]:
    """Fraction of valid specs (where both are ranked) in which row entity ranks strictly above column entity."""
    R = ranks[valid]
    out = []
    for a in idx:
        row = []
        for b in idx:
            if a == b:
                row.append(None)
                continue
            both = ~np.isnan(R[:, a]) & ~np.isnan(R[:, b])
            row.append(float(np.mean(R[both, a] < R[both, b])) if both.any() else None)
        out.append(row)
    return out


def influence(prep: Prepared, specs: list[Spec], ranks: np.ndarray, entity: int) -> dict:
    """How decisions accompany rank changes for one entity: mean rank per option, and Spearman
    correlation between each indicator's weight and the entity's rank across sampled specs."""
    from scipy.stats import spearmanr

    valid = [s for s in specs if s.status == "valid" and not np.isnan(ranks[s.index, entity])]
    by_option: dict[str, list[dict]] = {}
    for dim in ("normalization", "missing", "aggregation", "weights_source"):
        groups: dict[str, list[float]] = {}
        for s in valid:
            groups.setdefault(getattr(s, dim), []).append(float(ranks[s.index, entity]))
        by_option[dim] = [{"option": k, "n": len(v), "meanRank": float(np.mean(v)), "medianRank": float(np.median(v)), "min": float(np.min(v)), "max": float(np.max(v))} for k, v in groups.items()]
    sampled = [s for s in valid if s.weights_source == "sampled"]
    corr = []
    if len(sampled) >= 3:
        r = np.array([ranks[s.index, entity] for s in sampled])
        for name in prep.names:
            w = np.array([s.weights[name] for s in sampled])
            if np.ptp(w) == 0 or np.ptp(r) == 0:
                corr.append({"indicator": name, "rho": None, "n": len(sampled)})
            else:
                rho = spearmanr(w, r).statistic
                corr.append({"indicator": name, "rho": float(rho), "n": len(sampled)})
    return {"entity": prep.entity_ids[entity], "byOption": by_option, "weightRankCorrelation": corr, "note": "Negative correlation means a larger weight on that indicator accompanies a better (smaller) rank. Associations across the declared specification space, not causal effects."}


def result_digest(specs: list[Spec], scores: np.ndarray, ranks: np.ndarray) -> dict:
    return {
        "ranks": array_digest(np.nan_to_num(ranks, nan=-1.0), decimals=6),
        "scores": array_digest(scores, decimals=9),
        "statuses": hash_json([[s.status, s.reason] for s in specs]),
    }

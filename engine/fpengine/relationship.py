"""Relationship robustness: a restricted family of linear regressions.

Each specification fits y_t = a + b * x + c' Z + e by ordinary least squares (numpy.linalg.lstsq)
on the rows kept by its filter, missing-data and outlier decisions. The reported effect is b, the
change in the (possibly transformed) outcome per one unit of the predictor, holding the listed
covariates fixed. Specifications whose outcome transformation differs estimate different
quantities and are grouped into separate estimands, never pooled.

Intervals:
- "classical": t interval from the usual OLS variance. Assumes independent rows, constant variance.
- "hc3": t interval with HC3 heteroskedasticity-robust variance. Assumes independent rows.
- "cluster": CR1 cluster-robust variance with G - 1 degrees of freedom. Requires a cluster column.
- "bootstrap": percentile interval from a seeded pairs bootstrap (independent rows) or cluster
  bootstrap (clustered rows).
Time-ordered or repeated-measure data without a declared cluster unit get no interval: rows are
not independent and none of these methods is valid. The estimate is still shown, labelled.
"""

from __future__ import annotations

from itertools import product
from typing import Any

import numpy as np

from .canonical import computational, hash_json

ALGORITHM_VERSION = "relationship/1"
OPS = {"==", "!=", ">", ">=", "<", "<=", "in", "not-in"}
OUTCOME_TRANSFORMS = {
    "identity": ("y", "Change in {y} ({unit}) per one-unit increase in {x}"),
    "log": ("log(y)", "Change in log({y}) per one-unit increase in {x}; 100 x b is roughly the percent change for small b"),
}
INTERVALS = {"classical", "hc3", "cluster", "bootstrap", "none"}


class PlanError(ValueError):
    pass


def _cols(dataset: dict) -> dict[str, dict]:
    return {c["name"]: c for c in dataset["columns"]}


def _rule_mask(col: dict, rule: dict) -> np.ndarray:
    op, val = rule["op"], rule["value"]
    if op not in OPS:
        raise PlanError(f"Unsupported filter operator {op!r}")
    vals = col["values"]
    out = np.zeros(len(vals), dtype=bool)
    for i, v in enumerate(vals):
        if v is None:
            out[i] = False
            continue
        if op == "in":
            out[i] = v in val
        elif op == "not-in":
            out[i] = v not in val
        elif op == "==":
            out[i] = v == val
        elif op == "!=":
            out[i] = v != val
        else:
            if col["kind"] != "number":
                raise PlanError(f"Operator {op} needs a numeric column; {col['name']} is text")
            out[i] = {">": v > val, ">=": v >= val, "<": v < val, "<=": v <= val}[op]
    return out


def enumerate_specs(plan: dict) -> list[dict]:
    d = plan["decisions"]
    groups = [("filter", d["filters"]["options"]), ("covariates", d["covariates"]["options"]), ("outliers", d["outliers"]["options"]), ("transform", d["outcomeTransform"]["options"]), ("interval", d["interval"]["options"])]
    for name, opts in groups:
        if not opts:
            raise PlanError(f"Choose at least one {name} option.")
    specs = []
    for i, combo in enumerate(product(*[opts for _, opts in groups])):
        s = {"index": i}
        for (name, _), opt in zip(groups, combo):
            s[name] = opt["id"]
        s["estimand"] = s["transform"]
        specs.append(s)
    return specs


def interval_validity(plan: dict, method: str) -> str | None:
    """Reason an interval method is invalid for the declared sampling unit, or None."""
    unit = plan["sampling"]["unit"]
    if method == "none":
        return None
    if unit == "ordered":
        return "Rows are time-ordered or repeated measurements without a declared cluster unit; classical, robust, cluster and bootstrap intervals assume independence that is not available"
    if unit == "independent" and method == "cluster":
        return "Cluster-robust intervals need a declared cluster column"
    if unit == "cluster" and method in ("classical", "hc3"):
        return f"{method} intervals assume independent rows, but rows are clustered by {plan['sampling'].get('clusterColumn')}"
    if method not in INTERVALS:
        return f"Unknown interval method {method}"
    return None


def _design(dataset: dict, plan: dict, spec: dict) -> dict:
    cols = _cols(dataset)
    y_name, x_name = plan["outcome"], plan["predictor"]
    for n in (y_name, x_name):
        if n not in cols or cols[n]["kind"] != "number":
            raise PlanError(f"{n!r} must be a numeric column")
    n = len(cols[y_name]["values"])
    d = plan["decisions"]
    filt = next(o for o in d["filters"]["options"] if o["id"] == spec["filter"])
    cov = next(o for o in d["covariates"]["options"] if o["id"] == spec["covariates"])
    keep = np.ones(n, dtype=bool)
    excluded: list[dict] = []

    def drop(mask: np.ndarray, why: str) -> None:
        nonlocal keep
        newly = keep & ~mask
        if newly.any():
            excluded.append({"rule": why, "rows": np.where(newly)[0].tolist()})
        keep &= mask

    for rule in filt.get("rules", []):
        if rule["column"] not in cols:
            raise PlanError(f"Filter column {rule['column']!r} is not in the dataset")
        drop(_rule_mask(cols[rule["column"]], rule), f"filter {rule['column']} {rule['op']} {rule['value']}")
    needed = [y_name, x_name] + list(cov.get("columns", []))
    unit = plan["sampling"]
    if unit["unit"] == "cluster":
        needed.append(unit["clusterColumn"])
    for c in needed:
        if c not in cols:
            raise PlanError(f"Column {c!r} is not in the dataset")
        drop(np.array([v is not None and not (isinstance(v, float) and np.isnan(v)) for v in cols[c]["values"]]), f"complete case on {c}")
    y = np.array([np.nan if v is None else float(v) for v in cols[y_name]["values"]])
    x = np.array([np.nan if v is None else float(v) for v in cols[x_name]["values"]])
    if spec["transform"] == "log":
        bad = keep & ~(y > 0)
        if bad.any():
            return {"invalid": f"log outcome undefined for {int(bad.sum())} kept row(s) with {y_name} <= 0; the specification is not computed rather than dropping them silently"}
        y = np.where(keep, np.log(np.where(y > 0, y, 1.0)), np.nan)
    if spec["outliers"] == "drop-z3":
        yk = y[keep]
        if len(yk) > 2 and np.std(yk, ddof=1) > 0:
            z = np.zeros(n)
            z[keep] = (yk - yk.mean()) / np.std(yk, ddof=1)
            drop(np.abs(z) <= 3, "outlier |z| > 3 on the (transformed) outcome")
    elif spec["outliers"] != "keep":
        raise PlanError(f"Unknown outlier rule {spec['outliers']!r}")
    rows = np.where(keep)[0]
    X_parts = [np.ones(len(rows)), x[rows]]
    names = ["(intercept)", x_name]
    for c in cov.get("columns", []):
        col = cols[c]
        if col["kind"] == "number":
            X_parts.append(np.array([float(col["values"][r]) for r in rows]))
            names.append(c)
        else:
            levels = sorted({col["values"][r] for r in rows})
            for lv in levels[1:]:  # first level is the reference
                X_parts.append(np.array([1.0 if col["values"][r] == lv else 0.0 for r in rows]))
                names.append(f"{c}={lv}")
    clusters = None
    if unit["unit"] == "cluster":
        clusters = np.array([str(cols[unit["clusterColumn"]]["values"][r]) for r in rows])
    return {"X": np.column_stack(X_parts), "y": y[rows], "rows": rows, "names": names, "excluded": excluded, "clusters": clusters, "n_total": n}


def _ols(X: np.ndarray, y: np.ndarray) -> dict:
    beta, _, rank, sv = np.linalg.lstsq(X, y, rcond=None)
    resid = y - X @ beta
    return {"beta": beta, "rank": int(rank), "sv": sv, "resid": resid}


def fit(dataset: dict, plan: dict, spec: dict, detail: bool = False) -> dict:
    from scipy import stats

    try:
        des = _design(dataset, plan, spec)
    except PlanError as e:
        return {"status": "invalid", "reason": str(e)}
    if "invalid" in des:
        return {"status": "invalid", "reason": des["invalid"]}
    X, y = des["X"], des["y"]
    n, k = X.shape
    if n <= k + 1:
        return {"status": "invalid", "reason": f"{n} rows for {k} parameters; at least {k + 2} are needed", "n": n}
    o = _ols(X, y)
    if o["rank"] < k:
        return {"status": "invalid", "reason": f"Design matrix is rank deficient (rank {o['rank']} < {k} columns); a covariate is collinear with the predictor or constant after filtering", "n": n}
    beta, resid = o["beta"], o["resid"]
    df = n - k
    XtX_inv = np.linalg.inv(X.T @ X)
    sigma2 = float(resid @ resid) / df
    h = np.einsum("ij,jk,ik->i", X, XtX_inv, X)
    tss = float(((y - y.mean()) ** 2).sum())
    r2 = 1 - float(resid @ resid) / tss if tss > 0 else float("nan")
    Xs = (X[:, 1:] - X[:, 1:].mean(0)) / np.where(X[:, 1:].std(0) > 0, X[:, 1:].std(0), 1)
    cond = float(np.linalg.cond(Xs)) if Xs.shape[1] else 1.0
    cooks = (resid**2 / (k * sigma2)) * (h / (1 - h) ** 2) if sigma2 > 0 else np.zeros(n)
    est = float(beta[1])
    method = spec["interval"]
    invalid_interval = interval_validity(plan, method)
    lo = hi = se = None
    interval_note = None
    if invalid_interval:
        interval_note = invalid_interval
    elif method == "none":
        interval_note = "No interval requested"
    else:
        level = float(plan.get("confidence", 0.95))
        if method in ("classical", "hc3", "cluster"):
            if method == "classical":
                V = sigma2 * XtX_inv
                tdf = df
            elif method == "hc3":
                meat = (X * (resid / (1 - h))[:, None] ** 2).T @ X
                V = XtX_inv @ meat @ XtX_inv
                tdf = df
            else:
                groups = des["clusters"]
                uniq = np.unique(groups)
                G = len(uniq)
                if G < 5:
                    return _result(est, None, None, None, f"Only {G} clusters; cluster-robust intervals are unreliable below 5 clusters and are not reported", des, beta, r2, cond, h, cooks, n, k, df, spec, detail, XtX_inv, sigma2)
                meat = np.zeros((k, k))
                for g in uniq:
                    m = groups == g
                    sg = X[m].T @ resid[m]
                    meat += np.outer(sg, sg)
                c = (G / (G - 1)) * ((n - 1) / (n - k))
                V = c * XtX_inv @ meat @ XtX_inv
                tdf = G - 1
            se = float(np.sqrt(V[1, 1]))
            t = float(stats.t.ppf(0.5 + level / 2, tdf))
            lo, hi = est - t * se, est + t * se
            interval_note = f"{int(level * 100)}% {method} t interval, {tdf} df"
        else:
            B = int(plan.get("bootstrap", {}).get("replicates", 999))
            seed = int(plan.get("bootstrap", {}).get("seed", 1))
            rng = np.random.Generator(np.random.PCG64(seed + 7919 * spec["index"]))
            draws = []
            failed = 0
            if plan["sampling"]["unit"] == "cluster":
                groups = des["clusters"]
                uniq = np.unique(groups)
                idx_by = {g: np.where(groups == g)[0] for g in uniq}
                for _ in range(B):
                    pick = rng.choice(uniq, size=len(uniq), replace=True)
                    ii = np.concatenate([idx_by[g] for g in pick])
                    ob = _ols(X[ii], y[ii])
                    if ob["rank"] < k:
                        failed += 1
                        continue
                    draws.append(ob["beta"][1])
                kind = "cluster bootstrap"
            else:
                for _ in range(B):
                    ii = rng.integers(0, n, n)
                    ob = _ols(X[ii], y[ii])
                    if ob["rank"] < k:
                        failed += 1
                        continue
                    draws.append(ob["beta"][1])
                kind = "pairs bootstrap"
            draws = np.array(draws)
            if len(draws) < 0.9 * B:
                interval_note = f"{kind}: {failed} of {B} resamples were rank deficient; interval not reported"
            else:
                lo, hi = (float(v) for v in np.quantile(draws, [(1 - level) / 2, (1 + level) / 2]))
                se = float(np.std(draws, ddof=1))
                interval_note = f"{int(level * 100)}% percentile {kind}, {len(draws)} replicates, seed {seed}"
    return _result(est, se, lo, hi, interval_note, des, beta, r2, cond, h, cooks, n, k, df, spec, detail, XtX_inv, sigma2)


def _result(est, se, lo, hi, note, des, beta, r2, cond, h, cooks, n, k, df, spec, detail, XtX_inv, sigma2) -> dict:
    out: dict[str, Any] = {
        "status": "valid",
        "estimate": est,
        "se": se,
        "low": lo,
        "high": hi,
        "intervalNote": note,
        "n": int(n),
        "excludedCount": int(des["n_total"] - n),
        "diagnostics": {
            "r2": r2,
            "adjR2": 1 - (1 - r2) * (n - 1) / df if df > 0 and np.isfinite(r2) else None,
            "residualSd": float(np.sqrt(sigma2)),
            "conditionNumber": cond,
            "maxLeverage": float(h.max()),
            "maxCooksDistance": float(np.max(cooks)),
            "parameters": int(k),
        },
    }
    if detail:
        out["detail"] = {
            "terms": des["names"],
            "coefficients": beta.tolist(),
            "classicalSe": np.sqrt(np.diag(sigma2 * XtX_inv)).tolist(),
            "rows": des["rows"].tolist(),
            "excluded": des["excluded"],
        }
    return out


def estimand_label(plan: dict, transform: str) -> str:
    y, x = plan["outcome"], plan["predictor"]
    unit = plan.get("outcomeUnit") or "outcome units"
    return OUTCOME_TRANSFORMS[transform][1].format(y=y, x=x, unit=unit)


def summarize(plan: dict, specs: list[dict], results: list[dict]) -> dict:
    groups = {}
    for s, r in zip(specs, results):
        g = groups.setdefault(s["estimand"], {"estimand": s["estimand"], "label": estimand_label(plan, s["estimand"]), "valid": 0, "invalid": 0, "estimates": []})
        if r.get("status") == "valid":
            g["valid"] += 1
            g["estimates"].append(r["estimate"])
        elif r.get("status") == "invalid":
            g["invalid"] += 1
    out = []
    for g in groups.values():
        e = np.array(g.pop("estimates"))
        if len(e):
            g.update({"median": float(np.median(e)), "min": float(e.min()), "max": float(e.max()), "positiveFraction": float(np.mean(e > 0))})
        out.append(g)
    return {
        "estimands": out,
        "note": "Exploratory. Each estimand is summarized separately. The fraction of specifications with a positive estimate describes the tested specification space; it is not a posterior probability, does not correct for multiple testing, and does not establish causation.",
    }


def plan_key(dataset_hash: str, plan: dict, runtime: dict) -> str:
    return hash_json({"dataset": dataset_hash, "plan": computational(plan), "algorithm": ALGORITHM_VERSION, "runtime": {k: runtime[k] for k in ("engine", "numpy", "scipy")}})

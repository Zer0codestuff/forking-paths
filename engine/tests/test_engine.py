"""Engine tests against independently derived values.

Expected numbers below were derived by hand (ranking) or with SciPy's linregress, a separate
established implementation (regression), not by running this engine.
"""

import csv
import io
import json
import math

import numpy as np
import pytest
from scipy import stats

from fpengine import api, ranking, relationship
from fpengine.canonical import canonical_json, dataset_hash
from fpengine.examples import RANKING_DIRECTIONS, ranking_csv, simpson_csv


def ds(cols):
    out = []
    for name, vals in cols.items():
        kind = "number" if all(v is None or isinstance(v, (int, float)) for v in vals) else "string"
        out.append({"name": name, "kind": kind, "values": vals})
    return {"schema": "fp.dataset/1", "columns": out}


def rplan(norm=("minmax",), missing=("exclude",), agg=("arithmetic",), fixed=None, sampling=None, **kw):
    p = {
        "schema": "fp.plan/1", "workflow": "ranking", "title": "t", "entity": "id",
        "indicators": [{"column": "a", "direction": "higher", "unit": "u"}, {"column": "b", "direction": "lower", "unit": "u"}],
        "decisions": {
            "normalization": {"options": [{"id": n} for n in norm]},
            "missing": {"options": [{"id": m} for m in missing]},
            "aggregation": {"options": [{"id": g} for g in agg]},
            "weights": {"fixed": fixed if fixed is not None else [{"id": "equal", "weights": {"a": 1, "b": 1}}], **({"sampling": sampling} if sampling else {})},
        },
        "ties": "min", "topK": 1,
    }
    p.update(kw)
    return p


TINY = ds({"id": ["A", "B", "C"], "a": [10.0, 20.0, 30.0], "b": [5.0, 1.0, 3.0]})


def run(dataset, plan):
    return json.loads(api.run_all(json.dumps(dataset), json.dumps(plan)))


def ranks_of(res, spec=0):
    shape = tuple(res["arrays"]["shape"])
    return api.unb64(res["arrays"]["ranks"], "<f4", shape)[spec].tolist()


def scores_of(res, spec=0):
    shape = tuple(res["arrays"]["shape"])
    return api.unb64(res["arrays"]["scores"], "<f8", shape)[spec].tolist()


@pytest.mark.parametrize("norm,expected", [
    ("minmax", [0.0, 0.75, 0.75]),
    ("zscore", [-1.0, 0.5, 0.5]),
    ("rank", [1 / 6, 2 / 3, 2 / 3]),
    ("target", [(1 / 3 + 1 / 5) / 2, (2 / 3 + 1) / 2, (1 + 1 / 3) / 2]),
])
def test_hand_derived_normalizations(norm, expected):
    res = run(TINY, rplan(norm=(norm,)))
    assert res["specs"][0]["status"] == "valid"
    assert scores_of(res) == pytest.approx(expected, abs=1e-12)


def test_ties_min_and_average():
    assert ranks_of(run(TINY, rplan())) == [3, 1, 1]
    assert ranks_of(run(TINY, rplan(ties="average"))) == [3, 1.5, 1.5]


def test_weights_change_order():
    res = run(TINY, rplan(fixed=[{"id": "a-heavy", "weights": {"a": 4, "b": 1}}]))
    assert scores_of(res) == pytest.approx([0.0, 0.6, 0.9])
    assert ranks_of(res) == [3, 2, 1]


def test_geometric_needs_positive_values():
    res = run(TINY, rplan(norm=("minmax", "rank"), agg=("geometric",)))
    a, b = res["specs"]
    assert a["status"] == "invalid" and "Geometric mean undefined" in a["reason"]
    assert b["status"] == "valid"
    assert scores_of(res, 1) == pytest.approx([1 / 6, math.sqrt(5 / 12), math.sqrt(5 / 12)])


def test_missing_rules_are_explicit():
    d = ds({"id": ["A", "B", "C", "D"], "a": [10.0, 20.0, None, 40.0], "b": [4.0, 3.0, 2.0, 1.0]})
    res = run(d, rplan(missing=("exclude", "median", "worst")))
    ex, med, worst = res["specs"]
    assert ex["remaining"] == 3 and ex["excludedCount"] == 1
    assert math.isnan(ranks_of(res, 0)[2])
    # median of a = 20 -> C = (20, 2); worst a = 10 -> C = (10, 2)
    assert scores_of(res, 1)[2] == pytest.approx(((20 - 10) / 30 + (4 - 2) / 3) / 2)
    assert scores_of(res, 2)[2] == pytest.approx((0 + (4 - 2) / 3) / 2)
    assert res["summary"]["counts"] == {"valid": 3, "invalid": 0, "cancelled": 0, "uncomputed": 0}


def test_constant_indicator_rule():
    d = ds({"id": ["A", "B", "C"], "a": [1.0, 2.0, 3.0], "b": [5.0, 5.0, 5.0]})
    inv = run(d, rplan())
    assert inv["specs"][0]["status"] == "invalid" and "constant" in inv["specs"][0]["reason"]
    drop = run(d, rplan(constantRule="drop"))
    assert drop["specs"][0]["status"] == "valid" and drop["specs"][0]["notes"]
    assert ranks_of(drop) == [3, 2, 1]


def test_seeded_sampling_is_reproducible_and_reports_infeasible_draws():
    s = {"count": 20, "seed": 7, "alpha": 1.0}
    a = run(TINY, rplan(fixed=[], sampling=s))
    b = run(TINY, rplan(fixed=[], sampling=s))
    assert a["digest"] == b["digest"]
    w = [sp["weights"]["a"] for sp in a["specs"]]
    assert w == [sp["weights"]["a"] for sp in b["specs"]] and len(set(w)) == 20
    c = run(TINY, rplan(fixed=[], sampling={**s, "seed": 8}))
    assert c["digest"]["scores"] != a["digest"]["scores"]
    infeasible = run(TINY, rplan(fixed=[], sampling={"count": 5, "seed": 1, "minWeight": 0.6, "maxAttempts": 50}))
    assert [sp["status"] for sp in infeasible["specs"]] == ["invalid"] * 5
    assert "No Dirichlet draw" in infeasible["specs"][0]["reason"]


def test_spec_limit_marks_uncomputed():
    res = run(TINY, rplan(norm=("minmax", "zscore", "rank"), maxSpecs=2))
    assert [s["status"] for s in res["specs"]] == ["valid", "valid", "uncomputed"]
    assert res["summary"]["counts"]["uncomputed"] == 1


def test_cancellation_marks_remaining_cancelled():
    plan = rplan(norm=("minmax", "zscore", "rank", "target"))
    key = json.loads(api.start(json.dumps(TINY), json.dumps(plan)))["key"]
    api.run_batch(key, 1)
    res = json.loads(api.finish(key, cancelled=True))
    assert [s["status"] for s in res["specs"]] == ["valid", "cancelled", "cancelled", "cancelled"]


def parse_example_csv(text, drop_duplicates=True):
    """Test helper only (the app's importer is TypeScript): dot decimals, 'n/a' and '' missing,
    unparseable numbers become missing."""
    rows = list(csv.reader(io.StringIO(text)))
    header, body = rows[0], rows[1:]
    if drop_duplicates:
        seen, uniq = set(), []
        for r in body:
            if tuple(r) not in seen:
                seen.add(tuple(r))
                uniq.append(r)
        body = uniq
    cols = {}
    for j, name in enumerate(header):
        vals = [r[j] for r in body]
        if j == 0:
            cols[name] = vals
            continue
        out = []
        for v in vals:
            try:
                out.append(None if v in ("", "n/a") else float(v))
            except ValueError:
                out.append(None)
        cols[name] = out
    return ds(cols)


def synthetic_plan():
    names = [c for c in RANKING_DIRECTIONS]
    return {
        "schema": "fp.plan/1", "workflow": "ranking", "title": "synthetic", "entity": "region",
        "indicators": [{"column": c, "direction": RANKING_DIRECTIONS[c], "unit": ""} for c in names],
        "decisions": {
            "normalization": {"options": [{"id": n} for n in ("minmax", "zscore", "rank", "target")]},
            "missing": {"options": [{"id": m} for m in ("exclude", "median", "worst")]},
            "aggregation": {"options": [{"id": "arithmetic"}, {"id": "geometric"}]},
            "weights": {"fixed": [{"id": "equal", "weights": {c: 1 for c in names}}], "sampling": {"count": 40, "seed": 11, "alpha": 1.0}},
        },
        "ties": "min", "topK": 5,
    }


def test_synthetic_example_known_behavior():
    d = parse_example_csv(ranking_csv())
    res = run(d, synthetic_plan())
    ents = res["entities"]
    R = api.unb64(res["arrays"]["ranks"], "<f4", tuple(res["arrays"]["shape"]))
    valid = [i for i, s in enumerate(res["specs"]) if s["status"] == "valid"]
    assert len(valid) > 0 and res["summary"]["counts"]["invalid"] > 0  # zscore/minmax geometric are invalid
    alder, zephyr, elm, fir = (ents.index(n) for n in ("Alder", "Zephyr", "Elm", "Fir"))
    assert all(R[i, alder] == 1 for i in valid)  # dominance
    for i in valid:
        ranked = int(np.sum(~np.isnan(R[i])))
        if ranked == len(ents):
            assert R[i, zephyr] == ranked  # dominated by everyone
        assert R[i, elm] == R[i, fir]  # identical rows tie
    dune = ents.index("Dune")
    for i in valid:
        assert math.isnan(R[i, dune]) == (res["specs"][i]["missing"] == "exclude")
    infl = json.loads(api.query_influence(json.dumps(d), json.dumps(synthetic_plan()), res["arrays"]["ranks"], res["arrays"]["shape"], [s["status"] for s in res["specs"]], ents.index("Birch")))
    rho = {c["indicator"]: c["rho"] for c in infl["weightRankCorrelation"]}
    assert rho["cost_eur"] < -0.5  # more weight on cost -> better (smaller) rank for Birch


def test_pairwise_fractions():
    res = run(TINY, rplan(fixed=[{"id": "x", "weights": {"a": 4, "b": 1}}, {"id": "y", "weights": {"a": 1, "b": 4}}]))
    m = json.loads(api.query_pairwise(res["arrays"]["ranks"], res["arrays"]["shape"], [True, True], [1, 2]))
    # x: C above B; y: scores B = .2*.5 + .8*1 = .9, C = .2 + .8*.5 = .6 -> B above C
    assert m == [[None, 0.5], [0.5, None]]


# --- relationship -----------------------------------------------------------------------

def simpson_dataset():
    rows = list(csv.reader(io.StringIO(simpson_csv())))
    header, body = rows[0], rows[1:]
    cols = {h: [r[j] for r in body] for j, h in enumerate(header)}
    for h in ("training_hours", "errors_per_month", "tenure_years"):
        cols[h] = [float(v) for v in cols[h]]
    return ds(cols)


def relplan(unit="independent", intervals=("classical",), covs=None, transforms=("identity",), filters=None, **kw):
    p = {
        "schema": "fp.plan/1", "workflow": "relationship", "title": "r", "outcome": "errors_per_month", "predictor": "training_hours", "outcomeUnit": "errors per month",
        "sampling": {"unit": unit, **({"clusterColumn": "department"} if unit == "cluster" else {})},
        "decisions": {
            "filters": {"options": filters or [{"id": "all", "rules": []}]},
            "covariates": {"options": covs or [{"id": "none", "columns": []}]},
            "outliers": {"options": [{"id": "keep"}]},
            "outcomeTransform": {"options": [{"id": t} for t in transforms]},
            "interval": {"options": [{"id": i} for i in intervals]},
        },
        "confidence": 0.95,
    }
    p.update(kw)
    return p


def test_simple_regression_matches_scipy_linregress():
    d = simpson_dataset()
    res = run(d, relplan())
    s = res["specs"][0]
    x = np.array(d["columns"][2]["values"])
    y = np.array(d["columns"][3]["values"])
    lr = stats.linregress(x, y)
    t = stats.t.ppf(0.975, len(x) - 2)
    assert s["estimate"] == pytest.approx(lr.slope, rel=1e-10)
    assert s["se"] == pytest.approx(lr.stderr, rel=1e-10)
    assert s["low"] == pytest.approx(lr.slope - t * lr.stderr, rel=1e-10)
    assert s["diagnostics"]["r2"] == pytest.approx(lr.rvalue**2, rel=1e-10)


def test_hc3_matches_direct_formula():
    d = simpson_dataset()
    s = run(d, relplan(intervals=("hc3",)))["specs"][0]
    x = np.array(d["columns"][2]["values"])
    y = np.array(d["columns"][3]["values"])
    n = len(x)
    xc = x - x.mean()
    b = (xc @ (y - y.mean())) / (xc @ xc)
    e = y - (y.mean() - b * x.mean()) - b * x
    h = 1 / n + xc**2 / (xc @ xc)  # leverage in simple regression
    var_b = np.sum((xc**2) * (e / (1 - h)) ** 2) / (xc @ xc) ** 2
    assert s["se"] == pytest.approx(math.sqrt(var_b), rel=1e-9)


def test_simpson_sign_reverses_with_department():
    d = simpson_dataset()
    res = run(d, relplan(covs=[{"id": "none", "columns": []}, {"id": "dept", "columns": ["department"]}]))
    pooled, adj = res["specs"]
    assert pooled["estimate"] > 0.5
    assert adj["estimate"] == pytest.approx(-0.6, abs=0.15)
    assert adj["high"] < 0


def test_transformations_are_separate_estimands():
    res = run(simpson_dataset(), relplan(transforms=("identity", "log")))
    est = {e["estimand"] for e in res["summary"]["estimands"]}
    assert est == {"identity", "log"}
    assert "not a posterior probability" in res["summary"]["note"]


def test_log_outcome_with_nonpositive_values_is_invalid_not_dropped():
    d = ds({"x": [1.0, 2.0, 3.0, 4.0, 5.0], "y": [1.0, 0.0, 3.0, 4.0, 5.0]})
    p = relplan(transforms=("log",))
    p["outcome"], p["predictor"] = "y", "x"
    s = run(d, p)["specs"][0]
    assert s["status"] == "invalid" and "log outcome undefined" in s["reason"]


def test_interval_validity_follows_sampling_unit():
    assert relationship.interval_validity(relplan(unit="ordered"), "bootstrap")
    assert relationship.interval_validity(relplan(unit="cluster"), "hc3")
    assert relationship.interval_validity(relplan(unit="independent"), "cluster")
    assert relationship.interval_validity(relplan(unit="cluster"), "cluster") is None
    s = run(simpson_dataset(), relplan(unit="ordered"))["specs"][0]
    assert s["status"] == "valid" and s["low"] is None and "independence" in s["intervalNote"]
    few = run(simpson_dataset(), relplan(unit="cluster", intervals=("cluster",)))["specs"][0]
    assert few["low"] is None and "Only 3 clusters" in few["intervalNote"]


def test_bootstrap_is_seeded():
    p = relplan(intervals=("bootstrap",), bootstrap={"replicates": 199, "seed": 5})
    a = run(simpson_dataset(), p)["specs"][0]
    b = run(simpson_dataset(), p)["specs"][0]
    assert a["low"] == b["low"] and a["high"] == b["high"]
    assert a["low"] < a["estimate"] < a["high"]


# --- hashing ----------------------------------------------------------------------------

GOLDEN = ds({"id": ["a", "b", None, "é"], "v": [1.5, None, -0.0, 1e21]})


def test_dataset_hash_golden_value():
    # The TypeScript importer test asserts the same constant (src/lib/hash.test.ts).
    assert dataset_hash(GOLDEN["columns"]) == "e2f14ab9901e440291bd360e5e9040da31c2a9eeb39f48ce3c3d0d15049ae86f"


def test_canonical_json():
    assert canonical_json({"b": 1.0, "a": [0.1, -0.0, 2.5]}) == '{"a":[0.1,0,2.5],"b":1}'

"""Deterministic synthetic examples with known behavior. They verify mechanisms; they are not findings.

ranking-synthetic.csv (30 regions, 6 indicators)
  - Alder is at least as good as every other region on every indicator and strictly better on at
    least one, so it ranks first in every valid specification with non-negative weights.
  - Zephyr is the worst on every indicator, so it ranks last whenever all regions are ranked.
  - Birch is the cheapest region but weak elsewhere: it rises only when cost carries a large weight.
  - Cedar has an extreme access value: min-max normalization rewards it far more than rank
    normalization does.
  - Dune and two others have a missing coverage value, so the missing-data rule decides their fate.
  - Elm and Fir have identical indicator values and always tie.
  - The file contains one exact duplicate row (Gorse), one "n/a" missing token, and one value
    written with a decimal comma ("61,5") that fails numeric parsing in a dot-decimal file.

relationship-simpson.csv (240 rows, 3 departments)
  - Within each department, hours of training (x) is associated with fewer errors (slope -0.6),
    but departments with more training also have more errors, so the pooled slope is positive.
    Adding department as a covariate reverses the sign. Errors are strictly positive so a log
    outcome is defined.
"""

from __future__ import annotations

import csv
import io

import numpy as np

RANKING_COLUMNS = ["region", "access_index", "cost_eur", "safety_pct", "emissions_t", "coverage_pct", "satisfaction"]
RANKING_UNITS = {"access_index": "index 0-100", "cost_eur": "EUR per month", "safety_pct": "% of trips without incident", "emissions_t": "t CO2e per person", "coverage_pct": "% of households", "satisfaction": "score 1-10"}
RANKING_DIRECTIONS = {"access_index": "higher", "cost_eur": "lower", "safety_pct": "higher", "emissions_t": "lower", "coverage_pct": "higher", "satisfaction": "higher"}
NAMES = ["Alder", "Birch", "Cedar", "Dune", "Elm", "Fir", "Gorse", "Hazel", "Iris", "Juniper", "Kale", "Larch", "Maple", "Nettle", "Oak", "Pine", "Quince", "Rowan", "Sage", "Teak", "Umber", "Vale", "Willow", "Xylem", "Yarrow", "Aspen", "Briar", "Clover", "Daisy", "Zephyr"]


def ranking_rows() -> list[list[str]]:
    rng = np.random.Generator(np.random.PCG64(20261028))
    rows = []
    for name in NAMES:
        access = rng.uniform(40, 70)
        cost = rng.uniform(600, 900)
        safety = rng.uniform(80, 95)
        emis = rng.uniform(4.0, 8.0)
        cover = rng.uniform(60, 90)
        sat = rng.uniform(5.0, 8.0)
        rows.append([name, access, cost, safety, emis, cover, sat])
    by = {r[0]: r for r in rows}
    by["Alder"][1:] = [75.0, 560.0, 97.0, 3.5, 94.0, 8.6]  # dominates every region
    by["Zephyr"][1:] = [35.0, 960.0, 76.0, 9.0, 55.0, 4.5]  # dominated by every region
    by["Birch"][1:] = [42.0, 565.0, 81.0, 7.6, 62.0, 5.2]  # cheap, weak elsewhere
    by["Cedar"][1:] = [74.5, 880.0, 84.0, 7.0, 70.0, 6.0]  # extreme access, otherwise middling
    by["Fir"][1:] = list(by["Elm"][1:])  # exact tie with Elm
    out = []
    for r in rows:
        cells = [r[0]] + [f"{v:.1f}" if i != 3 else f"{v:.1f}" for i, v in enumerate(r[1:])]
        out.append(cells)
    idx = {r[0]: r for r in out}
    idx["Dune"][5] = ""  # missing coverage
    idx["Iris"][5] = "n/a"  # missing token
    idx["Oak"][3] = "61,5"  # decimal comma: a parse failure in a dot-decimal file
    gorse = list(idx["Gorse"])
    order = out + [gorse]  # exact duplicate row
    return order


def ranking_csv() -> str:
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(RANKING_COLUMNS)
    w.writerows(ranking_rows())
    return buf.getvalue()


def simpson_csv() -> str:
    rng = np.random.Generator(np.random.PCG64(1973))
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(["employee", "department", "training_hours", "errors_per_month", "tenure_years"])
    k = 0
    for dept, x_mean, y_base in (("Assembly", 4.0, 6.0), ("Logistics", 8.0, 10.0), ("Quality", 12.0, 14.0)):
        for _ in range(80):
            k += 1
            x = max(0.5, rng.normal(x_mean, 1.5))
            tenure = max(0.0, rng.normal(5, 2))
            y = y_base - 0.6 * (x - x_mean) + 0.1 * tenure + rng.normal(0, 0.8)
            w.writerow([f"E{k:03d}", dept, f"{x:.2f}", f"{max(y, 0.2):.2f}", f"{tenure:.1f}"])
    return buf.getvalue()


def write_all(out_dir: str) -> list[str]:
    import os

    os.makedirs(out_dir, exist_ok=True)
    files = {"ranking-synthetic.csv": ranking_csv(), "relationship-simpson.csv": simpson_csv()}
    for name, text in files.items():
        with open(os.path.join(out_dir, name), "w", encoding="utf-8", newline="") as fh:
            fh.write(text)
    return list(files)

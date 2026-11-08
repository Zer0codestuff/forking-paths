# Verification

Recorded on 2026-11-08. Every number below comes from a command in this repository.

## 1. Numerical feasibility in the browser

The chosen architecture (React/Vite UI, Pyodide worker running the Python engine) was proven before the UI was built:

- `scripts/fetch-runtime.mjs` prepared Pyodide 314.0.7 with NumPy 2.4.6 and SciPy 1.18.0 (wheel SHA-256 values checked against `pyodide-lock.json`).
- The engine loaded in a module Web Worker in headless Chromium in about 5.5 s (stages: Python runtime, NumPy, SciPy, engine).
- A 984-specification ranking plan on the synthetic example produced byte-identical rank, score and status digests in the browser and under CPython 3.12 with NumPy 1.26.4.

After the final optimizations the same parity holds for the shipped example: a bundle exported from the browser (504 specifications) has the same three digests when recomputed under CPython.

## 2. Engine tests (`npm run test:py`, 25 passed)

Expected values are derived independently of the engine:

- Hand-derived scores for every normalization on a 3 x 2 table, tie rules, weights changing the order, geometric aggregation rejecting zeros, the three missing-data rules, the constant-indicator rule.
- Seeded Dirichlet sampling reproduces exactly; a changed seed changes results; unsatisfiable bounds produce invalid specifications with a reason.
- The specification limit computes a seeded subset and marks the rest uncomputed; cancellation marks unreached specifications cancelled.
- Known behavior of the synthetic example: dominance, last place, ties, missing-data exclusion, and Birch's negative weight-rank correlation for cost.
- Regression against `scipy.stats.linregress` (slope, standard error, interval, R²) and an HC3 variance computed with a separate closed-form formula; the Simpson reversal; separate estimands; log outcomes with non-positive values rejected rather than dropped; interval validity by sampling unit; seeded bootstrap.
- The dataset hash golden value (shared with the TypeScript test) and canonical JSON.
- Vectorized summaries equal `numpy.quantile`; committed example CSVs equal the generator output.

## 3. TypeScript tests (`npm test`, 6 passed)

CSV tokenizing (quotes, delimiters, CRLF), profiling (types, missing values, parse failures, duplicates), decimal-comma parsing, strict number parsing, spreadsheet formula protection, and the dataset hash golden value.

## 4. Browser checks (`npm run build && npm run ui-check`, 42 of 42)

`scripts/ui-check.mjs` drives the built app in headless Chromium with reduced motion requested. Results are written to `docs/ui-check.json`. It checks:

- Data inspection shows the deliberate parse failure and duplicate row; a ragged CSV blocks acceptance; an invalid bundle is rejected with its reason.
- Cold engine load with visible loading stages in the Results view, then a ranking run with valid and invalid specifications counted separately; the selected-run inspector shows raw values, normalized values and contributions.
- Keyboard: number keys switch views, chart rows toggle with Enter, the rank chart has an equivalent table.
- Changing a decision marks the result stale; restoring it makes the cached result current again (rationale edits never invalidate results).
- Cancelling a 20,000-specification run stops between batches and reports cancelled specifications while the interface stays responsive.
- Exported bundle reproduces with the CLI in an empty directory containing only `fpengine` and the bundle, and again after reimport in the browser.
- Relationship example: separate estimands, the exploratory caveat, positive pooled and negative department-adjusted estimates, all interval methods blocked for time-ordered rows, and CLI reproduction including bootstrap intervals.
- Real case study: license and source shown; 268 of 780 planned specifications reported as uncomputed with the subset method described.
- No page-wide horizontal scrolling on any view at 1440, 1024, 768 and 390 CSS pixels; no console or page errors.

## 5. Cross-runtime reproduction

From `scripts/reproduce-clean.sh` on bundles exported by the browser:

```
Reproducing bundle.json with engine 0.1.0, Python 3.12.12, NumPy 1.26.4, SciPy 1.13.1
  [ok] specification statuses: 504 of 504 match
  [ok] ranks: max rank difference 0 over 10962 ranked cells (tolerance 0.0)
  [ok] scores: max absolute score difference 2.22e-16 (tolerance 1e-09)
  runtime differs from the exporting runtime: python 3.14.2 -> 3.12.12, numpy 2.4.6 -> 1.26.4, scipy 1.18.0 -> 1.13.1
REPRODUCED within tolerance.

  [ok] Training and errors: estimates and intervals: 192 values, max relative difference 8.83e-14 (tolerance 1e-08)
REPRODUCED within tolerance.
```

## Not verified

- Browsers other than Chromium, mobile devices, and Apple hardware.
- Persistence under a real storage quota limit (the error path exists but was not triggered).
- Offline caching of the runtime by a deployed site; no deployment was made.

# Performance

Measured on 2026-11-08 in a Linux cloud sandbox: Intel Xeon @ 2.60 GHz, 4 vCPUs, 7.8 GB RAM. Numbers vary by roughly 10 to 20% between runs. Apple hardware and browsers other than Chromium were not tested.

Reproduce:

```bash
python3 bench/bench.py                      # generates bench/out/bench-10000x12.csv and times the engine under CPython
npm run build && node scripts/browser-bench.mjs   # same input through the app in headless Chromium
```

## Input

- 10,000 entities x 12 numeric indicators, seeded synthetic data (`bench/bench.py`, seed 42), 2% of cells missing. CSV size 895,890 bytes.
- Plan: 3 normalizations (min-max, z-score, rank) x 2 missing-data rules (exclude, median) x arithmetic aggregation x 86 weight configurations (equal + 85 Dirichlet draws) = 516 planned specifications, limit 512 (a seeded random subset; 4 uncomputed).
- Result: 512 valid specifications; rank and score matrices of 512 x 10,000.

## Runtimes

| Runtime | Versions |
| --- | --- |
| Browser | Chromium 156.0.8078.73 headless (Playwright), Pyodide 314.0.7, Python 3.14.2, NumPy 2.4.6, SciPy 1.18.0 |
| CLI | CPython 3.12.12, NumPy 1.26.4, SciPy 1.13.1 |

## Results

| Step | Time |
| --- | --- |
| Browser: read, parse and profile the CSV | 0.18 s |
| Browser: accept the dataset (typed columns and dataset hash) | 0.10 s |
| Browser: cold run (load Pyodide, NumPy, SciPy and the engine, compute, transfer, render) | 17.8 s |
| of which the computation inside the worker | 12.2 s |
| Browser: warm run (engine already loaded), two repetitions | 10.0 s and 11.3 s |
| of which the computation inside the worker | 8.3 s and 8.9 s |
| CLI: the same plan under CPython, median of 3 | 4.5 s |
| CLI: peak resident memory | 517 MB |
| Browser: main-thread JS heap after the runs (`performance.memory`) | 519 MB |
| Browser: worker (Pyodide) heap, whole-browser memory, GPU | unavailable from the page |

Cold load and warm runs are reported separately: starting the runtime and loading the packages costs about 5 to 6 s on the first run only. The remaining difference between worker time and total time is the result transfer, the first render of the views and the IndexedDB save.

Small cases are interactive: the shipped synthetic ranking example (30 entities, 504 specifications) runs in about 0.6 s warm, and the relationship example (240 rows, 48 specifications including 24 bootstraps of 499 replicates) in about 5 s.

## Bottlenecks found and fixed

1. **Per-entity quantiles.** The rank summary called `numpy.quantile` once per entity (10,000 calls). It now sorts the rank matrix once and interpolates every entity's quantiles in one pass, using the same linear method. A test checks the result against `numpy.quantile`.
2. **Per-indicator normalization and Python-level exclusion bookkeeping.** Each specification normalized its 12 indicators one by one and built a reason string for every excluded entity. Normalization is now one vectorized call per specification, and reason strings are only built when a specification is inspected.
3. **Result transfer as base64 inside JSON.** The worker sent the 512 x 10,000 rank and score matrices as base64 text (about 80 MB) inside the result JSON. They now cross as binary buffers that are transferred, not copied, and the worker keeps the rank matrix cached for pairwise and influence queries. Base64 is used only in exported bundles.

| Measurement | Before | After |
| --- | --- | --- |
| CLI, 512 specifications (median) | 6.8 s | 4.5 s |
| Browser, main-thread heap after runs | 669 MB | 519 MB |
| Browser, cold run total | 20.3 s | 17.8 s |

## Remaining limits

- WebAssembly NumPy is about twice as slow as native NumPy for this workload.
- Memory grows with entities x specifications. A bundle with the full matrices for this benchmark is about 85 MB of JSON.
- Larger cases were not measured; these sizes are benchmark inputs, not promises of speed.

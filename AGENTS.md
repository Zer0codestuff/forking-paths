# AGENTS.md

## Purpose

Forking Paths is a local browser application for multiverse-style robustness analysis: how normalization, missing-data, aggregation and weighting choices change a ranking, and how filters, covariates, outliers, transformations and interval methods change a regression estimate. Every displayed result can be exported and reproduced. The adopted brief is `docs/BRIEF.md`.

## Architecture

- `engine/fpengine/` is the only implementation of the numerical methods (Python, NumPy, SciPy). The browser runs it in Pyodide inside `src/worker/engine.worker.ts`; the CLI (`python -m fpengine`) runs the same files under CPython. Never add JavaScript copies of formulas.
  - `ranking.py`, `relationship.py`: methods, specification enumeration, summaries.
  - `api.py`: JSON entry points shared by worker and CLI; binary matrix transfer and a worker-side rank cache.
  - `canonical.py`: canonical JSON, binary dataset hash (mirrored in `src/lib/hash.ts`, golden value tested on both sides), `computational()` plan view used for cache keys.
  - `reproduce.py`, `__main__.py`: result comparison and the reproduction CLI.
- `src/lib/`: CSV import and inspection (TypeScript; parsing happens once, at import), project model, bundles, HTML report, IndexedDB persistence, examples.
- `src/components/`: Data, Decisions, Results (ranking and relationship), Export.
- Schemas: `fp.source/1`, `fp.dataset/1`, `fp.plan/1`, `fp.result/1`, `fp.bundle/1`, `fp.project/1`.

## Commands

```bash
npm install && npm run setup:runtime   # Pyodide + pinned NumPy/SciPy wheels into public/pyodide (git-ignored)
npm run dev | npm run build | npm run preview
npm test                # TypeScript tests
npm run test:py         # Python engine tests (needs numpy, scipy, pytest)
npm run typecheck
node scripts/ui-check.mjs          # after build; Playwright end-to-end checks, writes docs/ui-check.json and screenshots
python3 bench/bench.py && node scripts/browser-bench.mjs   # benchmarks
scripts/reproduce-clean.sh <bundle.json>                   # CLI reproduction in an empty directory
python3 scripts/fetch_wdi.py --year 2022                   # refresh the WDI case study
cd engine && python -m fpengine examples --out ../public/examples   # regenerate synthetic examples
```

## Current status

Milestones 1 to 5 are implemented on `feat/initial-implementation` (PR to `main`, awaiting owner review). Not deployed. Verification and performance results: `docs/VERIFICATION.md`, `docs/PERFORMANCE.md`.

## Recent changes

- Engine: ranking and relationship workflows, seeded weight sampling, seeded subset when a plan exceeds the limit, interval validity by sampling unit, separate estimands, CLI reproduction.
- Web: workspace with data inspection, decision editor, Pyodide worker with progress and cancellation, linked ranking views, specification curve, exports and in-browser reproduction.
- Performance: vectorized normalization and rank summaries, binary transfer of result matrices.
- Real case study: EU-27 World Bank WDI 2022 (CC BY 4.0) with a retrieval recipe and provenance file.

## Constraints

- All copy, code and docs in English; no em dashes.
- Results must stay reproducible: seeds are part of plans; changing computational behavior requires bumping `ENGINE_VERSION` or the algorithm versions in `ranking.py` and `relationship.py`.
- Descriptive fields (rationales, titles) must not affect cache keys; every computational field must.
- Imported data and bundles are untrusted: validate, escape, never execute.
- No network calls at runtime except loading the local Python runtime; no telemetry.
- Branch work only; the owner reviews and merges. Commits are authored by the owner with no agent signatures or co-author trailers.

## Known issues

- Large runs keep full rank and score matrices in memory and IndexedDB (about 60 MB for 10,000 entities x 512 specifications); bundles of such runs are large.
- Only Chromium on Linux was tested.
- No time-series workflow; ordered data get estimates without intervals.
- The WDI example is a teaching adaptation, not an official index.

## Do not

- Do not push to `main`, merge pull requests, deploy, connect hosting, or change the owner's portfolio.
- Do not implement numerical methods outside `engine/fpengine`.
- Do not call a top-k fraction or a positive-estimate fraction a probability, or pool estimates from different estimands.
- Do not silently drop invalid, cancelled or uncomputed specifications.
- Do not commit `public/pyodide/`, `bench/out/`, private datasets, or credentials.
- Do not redistribute data whose license has not been checked at the source.

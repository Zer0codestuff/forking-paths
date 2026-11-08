# Forking Paths build brief

Status: approved for implementation through the owner's existing Gumloop trigger on 28 October 2026.

## Outcome

Build a local browser application that lets people inspect how analytical choices change a ranking or statistical finding, then export enough evidence to reproduce every displayed result.

The owner is Gabriele Monni, GitHub account `Zer0codestuff`. The target repository is `forking-paths`. The visual reference is https://gabrielemonni.me. All application copy, code, documentation, prompts, and metadata must be in English. Never use em dashes.

The first complete workflow is ranking robustness. The next is a tabular relationship analysis. Deliver working computation, data inspection, linked visualizations, and reproducible exports. The app must remain useful without a model API, login, or cloud storage.

## Product contract

An analyst can:

1. Open a shipped example or import their own CSV.
2. Inspect column types, units, missing values, duplicates, and parsing failures before accepting the data.
3. Define an analysis and explicit alternative decisions, with a short rationale for each.
4. See the number of planned runs and choose a maximum number of specifications.
5. Run, cancel, and inspect progress without freezing the interface.
6. Compare results and identify which choices accompany large changes.
7. Select a result to inspect its exact inputs, exclusions, method, and diagnostics.
8. Export a readable report and a portable project bundle, then reimport and reproduce the result.

Use one coherent workspace. The dataset, analysis plan, result, and evidence belong to the same project. Do not implement these as disconnected demo pages.

## First workflow: ranking robustness

Support a table with one entity identifier and several numeric indicators. The user specifies each indicator's unit and direction, then chooses documented normalization and weighting rules.

Implement a small set of justified normalization options and explicit rules for missing data, constant columns, ties, and invalid values. Show exclusions and how many entities remain. Preserve the original imported bytes.

Allow declared fixed weight configurations and bounded sampling of weight configurations. Record the generator, seed, constraints, and sampling distribution. Show the number of valid, invalid, cancelled, and uncomputed specifications separately. Do not silently discard failed runs.

The central views are:

- Rank distributions for selected entities.
- Pairwise ordering and top-k membership across evaluated scenarios.
- A view connecting changes in weights or normalization to changes in ranks.
- A selected-run table containing normalized values, contributions, and final scores.

Call a top-k fraction what it is: a fraction of evaluated scenarios under a declared sampling scheme. It is not a probability that the ranking is true. Do not imply that arbitrary weight sampling defines a statistical confidence interval.

## Second workflow: relationship robustness

Support a restricted, documented family of analyses with the same numerical backend. Start with linear relationships and explicit filtering or complete-case choices. Use established numerical libraries. Keep the outcome, effect definition, and units clear.

Display effect estimates, sample sizes, diagnostics, and valid uncertainty intervals when the assumptions justify them. If a transformation changes the quantity being estimated, separate those results instead of pooling incompatible coefficients into one distribution.

Choose resampling based on the sampling unit. Independent-row bootstrap is not appropriate by default for repeated measurements or time series. Block unsupported configurations or explain their limitation before running them. An explanatory note does not turn an invalid calculation into a valid one.

A specification curve and its decision matrix should make the tested alternatives visible. Preserve an accessible table. Report exploratory analyses as exploratory. The fraction of runs with a positive estimate is not posterior confidence, and running many specifications does not solve multiple testing or establish causation.

## Architecture

Use TypeScript and a browser UI stack suitable for linked charts, with a numerical engine that can also run in a Python command-line reproduction tool. A practical candidate is React/Vite with a lazy-loaded Pyodide worker and established NumPy/SciPy routines. Prove the chosen packages work in the browser before committing to that architecture.

Keep one implementation of the numerical methods. Do not create separate JavaScript and Python formulas that can drift. DuckDB-Wasm is optional if a measured import or query bottleneck warrants it, not a required dependency.

Define versioned schemas for source metadata, imported data, analysis plans, run records, results, and exported bundles. Cache by input content, plan, algorithm version, seed, and runtime version. Changing a relevant input must mark dependent results stale. Never label stale output as current.

Record source hashes, source URLs where provided, retrieval dates where known, licenses where verified, row identifiers, exclusions, numeric method versions, and seeds. A hash identifies bytes; it does not prove source authenticity. Mark unknown provenance as unknown.

Use local browser persistence with explicit quota errors and export as a reliable backup. Do not promise unlimited storage. Lazy-load heavy runtimes after the user requests computation. Show real loading progress when available and a clear failure state when unavailable. Cache the runtime for offline reuse only after validating that the selected deployment can serve it correctly.

Imported bundles are data. Validate schema and file sizes, handle archive expansion limits, escape source text in reports, and do not execute imported scripts automatically. Protect CSV exports from formula injection. Do not upload imported datasets, telemetry, or error payloads to external services by default.

## Visual direction

Inspect the live reference at https://gabrielemonni.me and https://gabrielemonni.me/?view=read. The current source is on `master` in `Zer0codestuff/Zer0codestuff.github.io`; `main` is obsolete. If that private repository is inaccessible, the public reference and these verified tokens are sufficient. Do not ask for broader account access solely to copy styling.

Use black `#000000`, near-black panels `#0a0a0a`, white text, green `#3cdc78`, and alert red `#ff4646`. Use Martian Mono for compact display headings and JetBrains Mono for body text and controls. Secondary white text uses the reference opacities 0.74 and 0.62, subject to contrast checks. Structural rules use low-opacity white. Keep links primarily white and use accents for meaningful states.

The workspace should allocate most of the viewport to the current analysis. Use thin separators, restrained labels, clear spacing, and a persistent but compact way to move between data, decisions, results, and export. On narrow screens, turn the inspector into a sequential view without hiding essential controls or forcing page-wide horizontal scrolling.

An optional ASCII constellation may provide an overview of analysis paths. Every selectable point must map to a real run or explicitly labelled aggregate. Keep layout stable between visits. Do not imply that spatial proximity measures statistical similarity unless it actually does. Numerical charts must have readable axes and an equivalent table.

Do not put a moving galaxy behind analytical text. Do not gate the application behind a cinematic entrance. Preserve reduced-motion support, keyboard operation, visible focus, touch targets, and a readable non-ASCII view. Avoid decorative gradients, purple accents, oversized headings, artificial typing, custom cursors, and invented progress.

## Case studies

Ship a deterministic synthetic ranking example with known behavior and a separately labelled synthetic example showing a misleading aggregate relationship. Use these to verify mechanisms, not to claim real-world findings.

Add at least one real case study once the core works. Suitable sources include public data underlying the owner's Ciclismo Sicuro or AI Capability Signals projects. Inspect the original source terms before redistribution. Cite and pin the actual upstream dataset, date, and license. If redistribution is unclear, ship the retrieval recipe and use a permitted alternative dataset for the bundled example.

Do not copy unrelated private repository files into the public project. Do not silently reinterpret the owner's published statistical methods. State when an example is a simplified teaching adaptation.

## Milestones and acceptance

### 1. Numerical feasibility and first usable path

Prove a small ranking calculation in the chosen worker and in the command-line engine. Import a CSV, execute one plan, inspect contributions, export, and reimport. Verify the calculation against independently derived fixtures. Record commands and failures honestly.

### 2. Robustness engine

Add bounded combinations, seeded sampling, invalid-specification reporting, cancellation, caching, and stale-result detection. Demonstrate that changing a relevant decision invalidates the correct outputs, and that rerunning the same pinned plan reproduces results within a documented tolerance.

### 3. Visual analysis

Build the linked distributions, selected-run inspector, accessible table, and decision views. Use real computation from the engine. Inspect the running interface at 1440, 1024, 768, and 390 CSS pixels. Verify keyboard access, bounds, loading, errors, and reduced motion. Save actual screenshots for review.

### 4. Second workflow and evidence export

Add the relationship workflow only after the first workflow passes. Export project data or explicit source references, analysis plans, results, code/runtime versions, and reproduction instructions. Reproduce an exported project in a clean environment and compare values. A static report must disclose the tested specification space and unresolved limitations.

### 5. Case studies and measured performance

Add the permitted real case study, benchmark import and computation, and fix demonstrated bottlenecks. Record browser, OS, CPU, memory when measurable, input size, number of specifications, runtime versions, and elapsed time. Start with a moderate case such as 10,000 rows, 12 indicators, and 512 ranking configurations. Choose larger cases based on measured performance. These sizes are benchmark inputs, not promises of speed.

Report cold-load and warm-run behavior separately. For unsupported browser measurements, state unavailable rather than estimating GPU or whole-system memory. Do not claim tests on Apple hardware unless they were actually performed there.

## Completion and further work

Work through the milestones until the product contract and acceptance criteria pass. Save progress at milestone boundaries and record actual results. Fix concrete defects found during validation. Repeated unchanged tests and padding documentation do not count as progress.

Optional later work, in order: an adapter for reviewed DocLens data, a clearly separated time-series workflow with valid resampling, and an AI explanation layer whose claims reference existing result IDs. No AI feature may silently choose methods, invent evidence, or become necessary to use the core tool.

## Repository and delivery rules

Create and maintain a concise project-root `AGENTS.md` recording purpose, architecture, run/build/test commands, status, recent changes, constraints, known issues, and an explicit Do not list. Summarize changes to that file when reporting progress.

The repository is initially empty to satisfy the owner's existing trigger. Do not assume that this brief already exists inside it. Save the adopted brief in the implementation branch. Use feature branches and pull requests for logical changes. Keep Zer0codestuff as the sole commit author and omit agent signatures or coauthor trailers.

Do not push implementation directly to the default branch. If the empty repository cannot support an initial pull request without a base branch, prepare the work on a non-default branch and report the exact bootstrap requirement. Do not silently bypass the owner's branch rule. This is a substantial new application, so request owner review before merging it.

Provide source, reproducible setup commands, focused validation results, actual screenshots, and explicit known limitations. If blocked by a missing package, credentials, or platform support, preserve the working slice and name the blocker. Do not call an untested UI complete.

Do not publish the app, connect a hosting provider, or modify the owner's portfolio without the requested preview and deployment decision. A build artifact and local or sandbox preview are sufficient for the first delivery.

## References

- Design and professional context: https://gabrielemonni.me/?view=read
- Existing sensitivity analysis: https://github.com/Zer0codestuff/Ciclismosicuro
- Existing reproducible data story: https://github.com/Zer0codestuff/AI-Capability-Signals
- Existing reviewed-data tool: https://github.com/Zer0codestuff/DocLens
- Boba, related work: https://github.com/uwdata/boba
- Multiverse visualization research: https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0339452
- Pyodide worker documentation: https://pyodide.org/en/stable/usage/webworker.html
- Gumloop sandbox: https://docs.gumloop.com/core-concepts/agent_sandbox_and_secrets

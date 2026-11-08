import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DataView } from './components/DataView';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ExportView } from './components/ExportView';
import { PlanView } from './components/PlanView';
import { ResultsView } from './components/ResultsView';
import { EXAMPLES } from './lib/examples';
import { acceptDataset, defaultRankingPlan, defaultRelationshipPlan, emptyProject, fingerprint, inspect, isCurrent, newId, readSource } from './lib/project';
import { DEFAULT_SETTINGS } from './lib/csv';
import { loadProject, saveProject, StorageError } from './lib/store';
import type { Plan, Project, RunRecord } from './lib/types';
import { Engine, type LoadState, type RunProgress } from './worker/client';

export type View = 'data' | 'plan' | 'results' | 'export';
const VIEWS: Array<{ id: View; label: string; key: string }> = [
  { id: 'data', label: 'Data', key: '1' },
  { id: 'plan', label: 'Decisions', key: '2' },
  { id: 'results', label: 'Results', key: '3' },
  { id: 'export', label: 'Export', key: '4' },
];

export interface EngineStatus {
  state: 'idle' | 'loading' | 'ready' | 'error';
  stage?: LoadState;
  runtime?: { python: string; numpy: string; scipy: string; engine: string };
  error?: string;
}

const params = new URLSearchParams(location.search);

export function App() {
  const engine = useMemo(() => new Engine(), []);
  const [project, setProject] = useState<Project | null>(null);
  const [view, setView] = useState<View>((params.get('view') as View) ?? 'data');
  const [engineStatus, setEngineStatus] = useState<EngineStatus>({ state: 'idle' });
  const [running, setRunning] = useState<{ reqId: number; planId: string; progress: RunProgress | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [storageProblem, setStorageProblem] = useState<string | null>(null);
  const saveTimer = useRef<number | null>(null);

  useEffect(() => {
    engine.onLoading = (s) => setEngineStatus((e) => ({ ...e, state: s.stage === 'ready' ? 'ready' : 'loading', stage: s }));
  }, [engine]);

  const update = useCallback((fn: (p: Project) => Project) => {
    setProject((p) => (p ? { ...fn(p), updatedAt: new Date().toISOString() } : p));
  }, []);

  // Persist locally (debounced). Failures are shown; export remains the reliable backup.
  useEffect(() => {
    if (!project) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveProject(project).then(() => setStorageProblem(null), (e) => setStorageProblem(e instanceof StorageError ? e.message : String(e)));
    }, 400);
  }, [project]);

  const openExample = useCallback(async (id: string) => {
    const ex = EXAMPLES.find((e) => e.id === id)!;
    setError(null);
    try {
      const res = await fetch(new URL(ex.file, new URL(import.meta.env.BASE_URL, location.href)));
      if (!res.ok) throw new Error(`Could not load ${ex.file} (HTTP ${res.status})`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const source = await readSource(ex.file.split('/').pop()!, bytes, ex.source);
      const settings = { ...DEFAULT_SETTINGS };
      const { table, profile } = inspect(bytes, settings);
      const dataset = await acceptDataset(table, profile, settings, { dropDuplicateRows: true }, ex.units);
      const p = emptyProject(ex.title);
      p.exampleId = ex.id;
      p.source = source;
      p.profile = profile;
      p.dataset = dataset;
      const plan: Plan = ex.workflow === 'ranking'
        ? (ex.rankingOverrides ?? ((x) => x))(defaultRankingPlan(dataset, { entity: ex.ranking!.entity, directions: ex.ranking!.directions, title: ex.title }))
        : defaultRelationshipPlan(dataset, ex.relationship);
      if (plan.workflow === 'ranking') plan.indicators = plan.indicators.map((i) => ({ ...i, unit: ex.units[i.column] ?? '' }));
      const entry = { id: newId('plan'), plan };
      p.plans = [entry];
      p.activePlan = entry.id;
      setProject(p);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    loadProject().then((p) => {
      if (p && params.get('example') === null) setProject(p);
      else void openExample(params.get('example') ?? 'ranking-synthetic');
    });
  }, [openExample]);

  const ensureEngine = useCallback(async () => {
    if (engineStatus.state === 'ready') return true;
    setEngineStatus({ state: 'loading' });
    try {
      const info = await engine.load();
      setEngineStatus({ state: 'ready', runtime: info.runtime });
      return true;
    } catch (e) {
      setEngineStatus({ state: 'error', error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  }, [engine, engineStatus.state]);

  const activeEntry = project?.plans.find((e) => e.id === project.activePlan) ?? null;

  const runPlan = useCallback(async (planId: string) => {
    if (!project?.dataset) return;
    const entry = project.plans.find((e) => e.id === planId);
    if (!entry) return;
    setError(null);
    const fp = fingerprint(entry.plan, project.dataset.hash);
    setRunning({ reqId: -1, planId, progress: null });
    setView('results');
    if (!(await ensureEngine())) { setRunning(null); return; }
    const { id, promise } = engine.run(project.dataset, entry.plan, (progress) => setRunning((r) => (r ? { ...r, progress } : r)), entry.plan.workflow === 'ranking' ? 16 : 4);
    setRunning({ reqId: id, planId, progress: null });
    try {
      const out = await promise;
      const rec: RunRecord = { id: newId('run'), planId, fingerprint: fp, plan: entry.plan, datasetHash: project.dataset.hash, elapsedMs: out.elapsedMs, cancelled: out.cancelled, result: out.record };
      update((p) => ({ ...p, runs: [...p.runs.filter((r) => !(r.planId === planId && r.fingerprint === fp)), rec] }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(null);
    }
  }, [project, ensureEngine, engine, update]);

  const cancelRun = () => { if (running && running.reqId >= 0) engine.cancel(running.reqId); };

  // Keyboard: 1-4 switch views (outside form fields).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(t.tagName) || e.metaKey || e.ctrlKey || e.altKey) return;
      const v = VIEWS.find((x) => x.key === e.key);
      if (v) setView(v.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const latestRun = project && activeEntry ? [...project.runs].reverse().find((r) => r.planId === activeEntry.id) ?? null : null;
  const stale = !!(project && latestRun && !isCurrent(project, latestRun));

  return (
    <div className="app">
      <header className="top">
        <h1 className="brand">FORKING PATHS</h1>
        <nav className="views" aria-label="Workspace">
          {VIEWS.map((v) => (
            <button key={v.id} className={`view-tab${view === v.id ? ' active' : ''}`} aria-current={view === v.id ? 'page' : undefined} onClick={() => setView(v.id)} title={`${v.label} (${v.key})`}>
              <span className="view-key" aria-hidden="true">{v.key}</span> {v.label}
              {v.id === 'results' && stale && <span className="badge warn" title="Results are stale">stale</span>}
            </button>
          ))}
        </nav>
        <div className="runtime small" role="status" aria-live="polite">
          {engineStatus.state === 'idle' && <span className="muted">Python engine loads when you run an analysis</span>}
          {engineStatus.state === 'loading' && <span>Loading engine: {engineStatus.stage?.stage ?? 'starting'} ({engineStatus.stage?.done ?? 0}/{engineStatus.stage?.total ?? 4})</span>}
          {engineStatus.state === 'ready' && <span className="ok-text">engine ready{engineStatus.runtime ? ` · Python ${engineStatus.runtime.python} · NumPy ${engineStatus.runtime.numpy} · SciPy ${engineStatus.runtime.scipy}` : ''}</span>}
          {engineStatus.state === 'error' && <span className="bad-text">engine unavailable</span>}
        </div>
      </header>
      {project && (
        <div className="project-line small">
          <label className="sr-only" htmlFor="project-title">Project title</label>
          <input id="project-title" className="title-input" value={project.title} onChange={(e) => update((p) => ({ ...p, title: e.target.value }))} />
          <span className="muted">{project.dataset ? `${project.dataset.rowIds.length} rows · dataset ${project.dataset.hash.slice(0, 12)}` : 'no dataset accepted'}{project.source?.synthetic ? ' · synthetic' : ''}</span>
        </div>
      )}
      {error && <div className="notice bad" role="alert">{error} <button className="btn ghost" onClick={() => setError(null)}>dismiss</button></div>}
      {engineStatus.state === 'error' && <div className="notice bad" role="alert">The Python engine could not load: {engineStatus.error} <button className="btn ghost" onClick={() => setEngineStatus({ state: 'idle' })}>retry</button></div>}
      {storageProblem && <div className="notice warn" role="alert">{storageProblem}</div>}
      <main className="main">
        <ErrorBoundary resetKey={view}>
        {!project && <p className="empty">Loading the example project…</p>}
        {project && view === 'data' && <DataView project={project} setProject={setProject} update={update} openExample={openExample} onContinue={() => setView('plan')} />}
        {project && view === 'plan' && <PlanView project={project} update={update} onRun={(id) => void runPlan(id)} running={!!running} />}
        {project && view === 'results' && (
          <ResultsView project={project} update={update} engine={engine} ensureEngine={ensureEngine} engineStatus={engineStatus} running={running} onRun={(id) => void runPlan(id)} onCancel={cancelRun} />
        )}
        {project && view === 'export' && <ExportView project={project} setProject={setProject} engine={engine} ensureEngine={ensureEngine} />}
        </ErrorBoundary>
      </main>
    </div>
  );
}

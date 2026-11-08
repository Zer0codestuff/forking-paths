import { useEffect, useMemo, useState } from 'react';
import type { EngineStatus } from '../App';
import { isCurrent } from '../lib/project';
import type { Project, RunRecord } from '../lib/types';
import type { Engine, RunProgress } from '../worker/client';
import { plannedCount } from './PlanView';
import { RankingResults } from './RankingResults';
import { RelationshipResults } from './RelationshipResults';

interface Props {
  project: Project;
  update: (fn: (p: Project) => Project) => void;
  engine: Engine;
  ensureEngine: () => Promise<boolean>;
  engineStatus: EngineStatus;
  running: { reqId: number; planId: string; progress: RunProgress | null } | null;
  onRun: (planId: string) => void;
  onCancel: () => void;
}

export function ResultsView({ project, update, engine, ensureEngine, engineStatus, running, onRun, onCancel }: Props) {
  const entry = project.plans.find((e) => e.id === project.activePlan) ?? project.plans[0];
  const runs = project.runs.filter((r) => r.planId === entry?.id);
  const [runId, setRunId] = useState<string | null>(null);
  const run: RunRecord | null = runs.find((r) => r.id === runId) ?? runs[runs.length - 1] ?? null;
  useEffect(() => setRunId(null), [entry?.id, runs.length]);
  const current = run ? isCurrent(project, run) : false;
  const reasons = useMemo(() => {
    if (!run) return [];
    const m = new Map<string, number>();
    for (const s of run.result.specs as Array<{ status: string; reason?: string | null }>) if (s.status === 'invalid') m.set(s.reason ?? 'unknown', (m.get(s.reason ?? 'unknown') ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]);
  }, [run]);
  if (!project.dataset || !entry) return <p className="empty">Accept a dataset and define a plan first.</p>;
  const counts = run ? (run.result.workflow === 'ranking' ? run.result.summary.counts : run.result.counts) : null;
  const p = running?.progress;
  const count = plannedCount(entry.plan);
  return (
    <div className="results-view">
      <div className="row wrap gap plan-tabs" role="tablist" aria-label="Analysis plans">
        {project.plans.map((e) => (
          <button key={e.id} role="tab" aria-selected={e.id === entry.id} className={`tab${e.id === entry.id ? ' active' : ''}`} onClick={() => update((pr) => ({ ...pr, activePlan: e.id }))}>{e.plan.title} <span className="muted small">{e.plan.workflow}</span></button>
        ))}
      </div>
      <div className="run-bar" aria-live="polite">
        {running ? (
          <>
            <div className="progress-wrap">
              {engineStatus.state === 'loading' ? (
                <span>Loading the Python engine: {engineStatus.stage?.stage ?? 'starting'} ({engineStatus.stage?.done ?? 0} of {engineStatus.stage?.total ?? 4} steps)</span>
              ) : p ? (
                <>
                  <span>{p.done.toLocaleString()} of {p.limit.toLocaleString()} specifications computed{p.planned > p.limit ? ` (${(p.planned - p.limit).toLocaleString()} beyond the limit)` : ''}</span>
                  <progress max={p.limit} value={p.done} aria-label="specifications computed" />
                </>
              ) : <span>Preparing specifications…</span>}
            </div>
            <button className="btn" onClick={onCancel} disabled={running.reqId < 0}>cancel</button>
          </>
        ) : (
          <>
            <span className="small">{count.planned.toLocaleString()} specifications planned{count.uncomputed ? `; a seeded subset of ${count.willRun.toLocaleString()} will be computed and ${count.uncomputed.toLocaleString()} left uncomputed` : ''}</span>
            <button className="btn primary" onClick={() => onRun(entry.id)}>{run && current ? 'run again' : 'run'}</button>
          </>
        )}
      </div>
      {!run && !running && <p className="empty">No results for this plan yet. Running loads the Python engine (about 16 MB, cached by the browser after the first load).</p>}
      {run && (
        <>
          {!current && (
            <div className="notice warn" role="alert">
              <strong>Stale.</strong> The dataset or the plan changed after this result was computed, so it no longer describes the current project. It is shown for reference only. Run again to update it.
            </div>
          )}
          <div className="result-meta small">
            {runs.length > 1 && (
              <label className="inline">result
                <select className="input" value={run.id} onChange={(e) => setRunId(e.target.value)}>
                  {runs.map((r) => <option key={r.id} value={r.id}>{r.result.createdAt.slice(0, 19).replace('T', ' ')}{isCurrent(project, r) ? ' (current)' : ' (stale)'}</option>)}
                </select>
              </label>
            )}
            <span>{current ? 'current' : 'stale'} · computed {run.result.createdAt.slice(0, 19).replace('T', ' ')} UTC in {(run.elapsedMs / 1000).toFixed(2)} s · engine {run.result.engine} ({run.result.algorithm}) · Python {run.result.runtime.python}, NumPy {run.result.runtime.numpy}, SciPy {run.result.runtime.scipy} · key <span className="mono">{run.result.key.slice(0, 12)}</span>{run.cancelled ? ' · cancelled by user' : ''}{run.result.selection && run.result.selection.computed < run.result.selection.planned ? ` · computed ${run.result.selection.computed} of ${run.result.selection.planned} planned specifications: ${run.result.selection.method}` : ''}</span>
          </div>
          {counts && (
            <ul className="counts plain" aria-label="Specification outcomes">
              <li className="ok">valid <strong>{counts.valid}</strong></li>
              <li className={counts.invalid ? 'bad' : ''}>invalid <strong>{counts.invalid}</strong></li>
              <li className={counts.cancelled ? 'warn' : ''}>cancelled <strong>{counts.cancelled}</strong></li>
              <li className={counts.uncomputed ? 'warn' : ''}>uncomputed <strong>{counts.uncomputed}</strong></li>
            </ul>
          )}
          {reasons.length > 0 && (
            <details className="reasons small">
              <summary>Why {counts?.invalid} specifications are invalid</summary>
              <ul className="plain">{reasons.map(([r, n]) => <li key={r}><strong>{n}</strong> {r}</li>)}</ul>
            </details>
          )}
          {run.result.workflow === 'ranking' && run.plan.workflow === 'ranking' && (
            <RankingResults key={run.id} project={project} plan={run.plan} inspectable={run.datasetHash === project.dataset.hash} result={run.result} engine={engine} ensureEngine={ensureEngine} />
          )}
          {run.result.workflow === 'relationship' && run.plan.workflow === 'relationship' && (
            <RelationshipResults key={run.id} project={project} plan={run.plan} inspectable={run.datasetHash === project.dataset.hash} result={run.result} engine={engine} ensureEngine={ensureEngine} />
          )}
        </>
      )}
    </div>
  );
}

import { useRef, useState } from 'react';
import { toCsv } from '../lib/csv';
import { buildBundle, downloadText, fingerprint, isCurrent, newId, parseBundle, projectFromBundle } from '../lib/project';
import { reportHtml } from '../lib/report';
import type { Bundle, Project, RunRecord } from '../lib/types';
import type { Engine } from '../worker/client';

interface Props {
  project: Project;
  setProject: (p: Project) => void;
  engine: Engine;
  ensureEngine: () => Promise<boolean>;
}

interface Check { name: string; ok: boolean; detail: string }

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';

export function ExportView({ project, setProject, engine, ensureEngine }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [imported, setImported] = useState<Bundle | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const current = project.runs.filter((r) => isCurrent(project, r));
  const stale = project.runs.length - current.length;

  const exportBundle = () => {
    try { downloadText(`${slug(project.title)}.fpbundle.json`, JSON.stringify(buildBundle(project))); } catch (e) { setErr((e as Error).message); }
  };
  const exportReport = () => downloadText(`${slug(project.title)}.report.html`, reportHtml(project), 'text/html');
  const exportCsv = () => {
    const lines: unknown[][] = [];
    for (const r of current) {
      if (r.result.workflow === 'ranking') for (const e of r.result.summary.entities) lines.push([r.plan.title, 'ranking', e.id, e.evaluated, e.median ?? '', e.p05 ?? '', e.p95 ?? '', e.topK ?? '']);
      else for (const s of r.result.specs) lines.push([r.plan.title, 'relationship', `spec ${s.index} ${s.estimand} ${s.filter} ${s.covariates} ${s.outliers} ${s.interval}`, s.n ?? '', s.estimate ?? '', s.low ?? '', s.high ?? '', s.status]);
    }
    downloadText(`${slug(project.title)}.summary.csv`, toCsv(['plan', 'workflow', 'item', 'n', 'median rank or estimate', 'p05 or low', 'p95 or high', 'top-k fraction or status'], lines), 'text/csv');
  };

  const onFile = async (f: File) => {
    setErr(null); setChecks(null); setImported(null);
    try {
      const { bundle, problems } = await parseBundle(await f.text());
      setImported(bundle);
      setProblems(problems);
    } catch (e) { setErr((e as Error).message); }
  };

  const reproduce = async () => {
    if (!imported) return;
    setBusy('loading the engine'); setErr(null);
    const out: Check[] = [...problems.map((p) => ({ name: 'bundle integrity', ok: false, detail: p }))];
    if (!problems.length) out.push({ name: 'bundle integrity', ok: true, detail: 'dataset hash and source bytes match their recorded values' });
    try {
      if (!(await ensureEngine())) throw new Error('The Python engine is unavailable.');
      const p = projectFromBundle(imported);
      const runs: RunRecord[] = [];
      for (const [i, plan] of imported.plans.entries()) {
        setBusy(`recomputing ${plan.title}`);
        const { promise } = engine.run(imported.dataset, plan, () => {});
        const fresh = (await promise).record;
        const match = imported.results.find((r) => r.planHash === fresh.planHash);
        if (match) {
          const cmp = await engine.call('compare', JSON.stringify(match), JSON.stringify(fresh));
          for (const c of cmp.checks as Check[]) out.push({ ...c, name: `${plan.title}: ${c.name}` });
        } else out.push({ name: `${plan.title}`, ok: true, detail: 'no stored result for this plan; computed fresh' });
        runs.push({ id: newId('run'), planId: p.plans[i].id, fingerprint: fingerprint(plan, imported.dataset.hash), plan, datasetHash: imported.dataset.hash, elapsedMs: 0, cancelled: false, result: fresh });
      }
      const unmatched = imported.results.filter((r) => !runs.some((x) => x.result.planHash === r.planHash));
      for (const u of unmatched) out.push({ name: 'stored result', ok: false, detail: `result ${u.key.slice(0, 12)} has no matching plan in the bundle` });
      p.runs = runs;
      setChecks(out);
      setProject(p);
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(null); }
  };

  return (
    <div className="export-view">
      <section className="panel">
        <h2 className="h">Export</h2>
        <p className="small">{current.length} current result(s){stale ? `, ${stale} stale result(s) not included` : ''}. The bundle contains the original source bytes, the accepted dataset, every plan, current results, runtime versions and reproduction instructions.</p>
        <div className="row wrap gap">
          <button className="btn primary" disabled={!project.dataset} onClick={exportBundle}>download project bundle (.json)</button>
          <button className="btn" disabled={!project.dataset} onClick={exportReport}>download report (.html)</button>
          <button className="btn" disabled={!current.length} onClick={exportCsv}>download summary (.csv)</button>
        </div>
        <p className="small muted">Reproduce outside the browser: <code>cd engine && python -m fpengine reproduce project.fpbundle.json</code> (needs NumPy and SciPy). Text cells in the CSV that start with =, +, - or @ are prefixed with an apostrophe so spreadsheets do not run them as formulas.</p>
      </section>
      <section className="panel">
        <h2 className="h">Import and reproduce</h2>
        <p className="small">Bundles are treated as data: their schema, sizes and hashes are checked, and nothing inside them is executed.</p>
        <button className="btn" onClick={() => fileRef.current?.click()}>choose bundle…</button>
        <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); e.target.value = ''; }} />
        {err && <p className="bad-text" role="alert">{err}</p>}
        {imported && (
          <div className="imported small">
            <p><strong>{imported.title}</strong>: {imported.dataset.columns.length} columns, {imported.plans.length} plan(s), {imported.results.length} stored result(s), exported {imported.createdAt.slice(0, 19)} by Forking Paths {imported.app.version}.</p>
            {problems.map((p) => <p key={p} className="notice bad">{p}</p>)}
            <button className="btn primary" disabled={!!busy} onClick={() => void reproduce()}>{busy ? `${busy}…` : 'open and reproduce'}</button>
            <p className="muted">This replaces the current project in this browser. Export it first if you need it.</p>
          </div>
        )}
        {checks && (
          <div className="checks" role="status">
            <p className={checks.every((c) => c.ok) ? 'ok-text' : 'bad-text'}><strong>{checks.every((c) => c.ok) ? 'Reproduced within tolerance.' : 'Not reproduced.'}</strong></p>
            <ul className="plain small">{checks.map((c, i) => <li key={i}>{c.ok ? '[ok]' : '[FAIL]'} {c.name}: {c.detail}</li>)}</ul>
          </div>
        )}
      </section>
    </div>
  );
}

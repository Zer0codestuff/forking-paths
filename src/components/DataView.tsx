import { useMemo, useRef, useState } from 'react';
import { DEFAULT_SETTINGS, LIMITS, type ParseSettings } from '../lib/csv';
import { EXAMPLES } from '../lib/examples';
import { base64ToBytes } from '../lib/hash';
import { acceptDataset, defaultRankingPlan, emptyProject, inspect, newId, readSource } from '../lib/project';
import type { Project } from '../lib/types';

interface Props {
  project: Project;
  setProject: (p: Project) => void;
  update: (fn: (p: Project) => Project) => void;
  openExample: (id: string) => Promise<void>;
  onContinue: () => void;
}

const fmt = (v: number | undefined) => (v === undefined ? '' : Math.abs(v) >= 1e5 || (Math.abs(v) < 1e-3 && v !== 0) ? v.toExponential(3) : Number(v.toFixed(4)).toString());

export function DataView({ project, setProject, update, openExample, onContinue }: Props) {
  const [settings, setSettings] = useState<ParseSettings>(project.dataset?.settings ?? DEFAULT_SETTINGS);
  const [dropDup, setDropDup] = useState(true);
  const [units, setUnits] = useState<Record<string, string>>(() => Object.fromEntries((project.dataset?.columns ?? []).map((c) => [c.name, c.unit ?? ''])));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const bytes = useMemo(() => (project.source ? base64ToBytes(project.source.bytesBase64) : null), [project.source]);
  const inspected = useMemo(() => (bytes ? inspect(bytes, settings) : null), [bytes, settings]);
  const prof = inspected?.profile;
  const accepted = project.dataset;
  const acceptedMatches = !!accepted && JSON.stringify(accepted.settings) === JSON.stringify(settings);

  const onFile = async (f: File) => {
    setErr(null);
    if (f.size > LIMITS.maxBytes) { setErr(`${f.name} is ${(f.size / 1048576).toFixed(1)} MB; the import limit is ${LIMITS.maxBytes / 1048576} MB.`); return; }
    const b = new Uint8Array(await f.arrayBuffer());
    const source = await readSource(f.name, b, { notes: '' });
    const p = emptyProject(f.name.replace(/\.[^.]+$/, ''));
    p.source = source;
    setSettings(DEFAULT_SETTINGS);
    setUnits({});
    setProject(p);
  };

  const doAccept = async () => {
    if (!inspected || !prof) return;
    setBusy(true);
    try {
      const ds = await acceptDataset(inspected.table, prof, settings, { dropDuplicateRows: dropDup }, units);
      update((p) => {
        const plans = p.plans.length ? p.plans : [{ id: newId('plan'), plan: defaultRankingPlan(ds) }];
        return { ...p, dataset: ds, profile: prof, plans, activePlan: p.activePlan ?? plans[0].id };
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const src = project.source;
  const setSrc = (k: string, v: unknown) => update((p) => (p.source ? { ...p, source: { ...p.source, [k]: v } } : p));
  const blocking = prof ? [...prof.problems.filter((x) => /exceed|empty|appears more than once|empty name/.test(x)), ...(prof.ragged.length ? [`${prof.ragged.length} row(s) have a different number of cells than the header (first: row ${prof.ragged[0].row} with ${prof.ragged[0].cells})`] : [])] : [];

  return (
    <div className="data-view">
      <section className="panel">
        <h2 className="h">Open data</h2>
        <div className="row wrap gap">
          {EXAMPLES.map((e) => (
            <button key={e.id} className={`btn${project.exampleId === e.id ? ' active' : ''}`} onClick={() => void openExample(e.id)}>{e.title}</button>
          ))}
          <button className="btn" onClick={() => fileRef.current?.click()}>import CSV…</button>
          <input ref={fileRef} type="file" accept=".csv,.tsv,.txt,text/csv" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); e.target.value = ''; }} />
        </div>
        {project.exampleId && <p className="small muted">{EXAMPLES.find((e) => e.id === project.exampleId)?.summary}</p>}
        <p className="small muted">Files stay in this browser. Nothing is uploaded. The original bytes are kept unchanged in the project.</p>
        {err && <p className="bad-text" role="alert">{err}</p>}
      </section>

      {src && (
        <section className="panel">
          <h2 className="h">Source and provenance</h2>
          <dl className="kv small">
            <dt>file</dt><dd>{src.name} · {src.bytes.toLocaleString()} bytes</dd>
            <dt>sha256</dt><dd className="mono wrap-anywhere">{src.sha256}</dd>
            <dt>note</dt><dd className="muted">The hash identifies these exact bytes. It does not prove where they came from.</dd>
          </dl>
          <div className="form-grid">
            <label>source URL<input className="input" placeholder="unknown" value={src.url ?? ''} onChange={(e) => setSrc('url', e.target.value || null)} /></label>
            <label>retrieved on<input className="input" type="date" value={src.retrievedAt ?? ''} onChange={(e) => setSrc('retrievedAt', e.target.value || null)} /></label>
            <label>license<input className="input" placeholder="unknown" value={src.license ?? ''} onChange={(e) => setSrc('license', e.target.value || null)} /></label>
            <label className="inline"><input type="checkbox" checked={src.licenseVerified} onChange={(e) => setSrc('licenseVerified', e.target.checked)} /> I checked the license terms at the source</label>
            <label className="span2">citation<input className="input" placeholder="unknown" value={src.citation ?? ''} onChange={(e) => setSrc('citation', e.target.value || null)} /></label>
            <label className="span2">notes<textarea className="input" rows={2} value={src.notes} onChange={(e) => setSrc('notes', e.target.value)} /></label>
          </div>
        </section>
      )}

      {prof && inspected && (
        <section className="panel">
          <h2 className="h">Inspect before accepting</h2>
          <div className="row wrap gap small">
            <label className="inline">delimiter
              <select className="input" value={settings.delimiter} onChange={(e) => setSettings({ ...settings, delimiter: e.target.value as ParseSettings['delimiter'] })}>
                <option value="auto">auto (found "{inspected.table.delimiter === '\t' ? 'tab' : inspected.table.delimiter}")</option><option value=",">comma</option><option value=";">semicolon</option><option value={'\t'}>tab</option>
              </select>
            </label>
            <label className="inline">decimal mark
              <select className="input" value={settings.decimal} onChange={(e) => setSettings({ ...settings, decimal: e.target.value as '.' | ',' })}><option value=".">point (1.5)</option><option value=",">comma (1,5)</option></select>
            </label>
            <label className="inline">missing tokens
              <input className="input" value={settings.missingTokens.map((t) => (t === '' ? '(empty)' : t)).join(' | ')} onChange={(e) => setSettings({ ...settings, missingTokens: e.target.value.split('|').map((t) => t.trim()).map((t) => (t === '(empty)' ? '' : t)) })} />
            </label>
          </div>
          <p className="small">{prof.rows.toLocaleString()} data rows, {prof.columns.length} columns.</p>
          {[...prof.problems, ...blocking.filter((b) => !prof.problems.includes(b))].map((p) => <p key={p} className="notice warn small">{p}</p>)}
          <div className="table-wrap">
            <table className="table">
              <caption className="sr-only">Column profile</caption>
              <thead><tr><th>column</th><th>type</th><th>unit</th><th className="num">missing</th><th>parse failures</th><th className="num">distinct</th><th>range</th><th>examples</th></tr></thead>
              <tbody>
                {prof.columns.map((c) => (
                  <tr key={c.name}>
                    <th scope="row">{c.name}{c.constant && <span className="badge warn">constant</span>}</th>
                    <td>
                      <select className="input" aria-label={`type of ${c.name}`} value={c.type} onChange={(e) => setSettings({ ...settings, types: { ...settings.types, [c.name]: e.target.value as 'number' | 'string' } })}>
                        <option value="number">number{c.inferred === 'number' ? ' (inferred)' : ''}</option>
                        <option value="string">text{c.inferred === 'string' ? ' (inferred)' : ''}</option>
                      </select>
                    </td>
                    <td><input className="input unit" aria-label={`unit of ${c.name}`} placeholder="unit" value={units[c.name] ?? ''} onChange={(e) => setUnits({ ...units, [c.name]: e.target.value })} /></td>
                    <td className="num">{c.missing}</td>
                    <td>{c.failures.length ? <span className="bad-text">{c.failures.length}: {c.failures.slice(0, 3).map((f) => `row ${f.row} "${f.raw}"`).join(', ')}{c.failures.length > 3 ? ' …' : ''}</span> : <span className="muted">none</span>}</td>
                    <td className="num">{c.distinct}</td>
                    <td className="mono">{c.min !== undefined ? `${fmt(c.min)} to ${fmt(c.max)}` : ''}</td>
                    <td className="muted">{c.examples.join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {prof.duplicateRows.length > 0 && (
            <p className="small"><span className="badge warn">duplicates</span> {prof.duplicateRows.length} group(s) of identical rows: {prof.duplicateRows.slice(0, 5).map((g) => `rows ${g.join(' and ')}`).join('; ')}.</p>
          )}
          <div className="row wrap gap">
            <label className="inline small"><input type="checkbox" checked={dropDup} onChange={(e) => setDropDup(e.target.checked)} disabled={!prof.duplicateRows.length} /> drop exact duplicate rows (keep the first)</label>
            <button className="btn primary" disabled={busy || blocking.length > 0} onClick={() => void doAccept()}>{accepted ? 'accept again with these settings' : 'accept dataset'}</button>
            {accepted && acceptedMatches && <button className="btn" onClick={onContinue}>continue to decisions →</button>}
          </div>
          {blocking.length > 0 && <p className="bad-text small">Fix the problems above before accepting.</p>}
        </section>
      )}

      {accepted && (
        <section className="panel">
          <h2 className="h">Accepted dataset</h2>
          <dl className="kv small">
            <dt>rows</dt><dd>{accepted.rowIds.length}</dd>
            <dt>dataset hash</dt><dd className="mono wrap-anywhere">{accepted.hash}</dd>
            <dt>accepted</dt><dd>{accepted.acceptedAt.replace('T', ' ').slice(0, 19)} UTC</dd>
            <dt>changes</dt><dd>{accepted.transforms.length ? <ul className="plain">{accepted.transforms.map((t) => <li key={t}>{t}</li>)}</ul> : 'none'}</dd>
          </dl>
          {!acceptedMatches && <p className="notice warn small">The settings above differ from the accepted dataset. Accept again to apply them; results computed on the old dataset will be marked stale.</p>}
        </section>
      )}
    </div>
  );
}

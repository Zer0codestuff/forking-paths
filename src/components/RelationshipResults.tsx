import { useEffect, useMemo, useState } from 'react';
import type { Project, RelationshipPlan, RelationshipResult, RelationshipSpec } from '../lib/types';
import type { Engine } from '../worker/client';
import { niceTicks, useWidth } from './useWidth';

interface Props {
  project: Project;
  plan: RelationshipPlan;
  result: RelationshipResult;
  engine: Engine;
  ensureEngine: () => Promise<boolean>;
  inspectable: boolean;
}

const f = (v: number | null | undefined, d = 3) => (v === null || v === undefined || !Number.isFinite(v) ? 'n/a' : Math.abs(v) >= 1e4 || (Math.abs(v) < 1e-3 && v !== 0) ? v.toExponential(2) : v.toFixed(d));
const DIMS: Array<keyof RelationshipSpec> = ['filter', 'covariates', 'outliers', 'interval'];

export function RelationshipResults({ project, plan, result, engine, ensureEngine, inspectable }: Props) {
  const estimands = result.summary.estimands;
  const [est, setEst] = useState(estimands[0]?.estimand ?? 'identity');
  const [sel, setSel] = useState<number | null>(null);
  const [detail, setDetail] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [mode, setMode] = useState<'chart' | 'table'>('chart');
  const specs = useMemo(() => result.specs.filter((s) => s.estimand === est), [result, est]);
  const validSorted = useMemo(() => specs.filter((s) => s.status === 'valid').sort((a, b) => a.estimate! - b.estimate! || a.index - b.index), [specs]);
  const others = specs.filter((s) => s.status !== 'valid');
  useEffect(() => { setSel(validSorted[Math.floor(validSorted.length / 2)]?.index ?? null); }, [validSorted]);
  useEffect(() => {
    let live = true;
    setDetail(null);
    if (sel === null || !inspectable) return;
    void ensureEngine().then((ok) => ok && engine.call('inspect', project.dataset, plan, sel)).then((d) => { if (live && d) setDetail(d); }, (e) => live && setErr(String(e.message ?? e)));
    return () => { live = false; };
  }, [sel, plan, project.dataset, engine, ensureEngine, inspectable]);
  const g = estimands.find((e) => e.estimand === est);

  return (
    <div className="relationship-results">
      {err && <p className="notice bad small" role="alert">{err}</p>}
      <div className="row wrap gap" role="tablist" aria-label="Estimands">
        {estimands.map((e) => <button key={e.estimand} role="tab" aria-selected={e.estimand === est} className={`tab${e.estimand === est ? ' active' : ''}`} onClick={() => setEst(e.estimand)}>{e.estimand === 'identity' ? 'outcome as measured' : 'log outcome'} <span className="muted small">{e.valid} valid</span></button>)}
      </div>
      {estimands.length > 1 && <p className="small notice">These are different estimands, shown separately and never pooled: a coefficient on log({plan.outcome}) is a proportional change, not a change in {plan.outcomeUnit || 'outcome units'}.</p>}
      {g && (
        <section className="panel">
          <div className="row wrap between">
            <h3 className="h">Specification curve</h3>
            <div className="seg" role="group" aria-label="Display">
              <button className={`btn small${mode === 'chart' ? ' active' : ''}`} aria-pressed={mode === 'chart'} onClick={() => setMode('chart')}>chart</button>
              <button className={`btn small${mode === 'table' ? ' active' : ''}`} aria-pressed={mode === 'table'} onClick={() => setMode('table')}>table</button>
            </div>
          </div>
          <p className="small"><strong>Estimand:</strong> {g.label}. <span className="muted">{g.valid} valid, {g.invalid} invalid specifications. Median estimate {f(g.median)}; range {f(g.min)} to {f(g.max)}; {g.positiveFraction !== undefined ? `${(g.positiveFraction * 100).toFixed(0)}% of valid specifications have a positive estimate.` : ''}</span></p>
          <p className="small note">{result.summary.note}</p>
          {mode === 'chart' ? <Curve specs={validSorted} plan={plan} sel={sel} onSel={setSel} /> : <SpecTable specs={specs} sel={sel} onSel={setSel} />}
          {others.length > 0 && (
            <details className="small"><summary>{others.length} specification(s) without an estimate</summary>
              <ul className="plain">{others.map((s) => <li key={s.index}>#{s.index} {s.filter} · {s.covariates} · {s.outliers} · {s.interval}: <span className={s.status === 'invalid' ? 'bad-text' : 'warn-text'}>{s.status}</span> {s.reason ?? ''}</li>)}</ul>
            </details>
          )}
        </section>
      )}
      <section className="panel" aria-live="polite">
        <h3 className="h">Selected specification {sel !== null ? `#${sel}` : ''}</h3>
        {!inspectable ? <p className="muted small">The dataset changed after this result, so its inputs cannot be shown faithfully.</p> : sel === null ? <p className="muted small">Select a point or row.</p> : !detail ? <p className="muted small">Recomputing with full detail…</p> : <Detail d={detail} plan={plan} />}
      </section>
    </div>
  );
}

function Curve({ specs, plan, sel, onSel }: { specs: RelationshipSpec[]; plan: RelationshipPlan; sel: number | null; onSel: (i: number) => void }) {
  const [ref, cw] = useWidth<HTMLDivElement>();
  const n = specs.length;
  if (!n) return <p className="muted small">No valid specification for this estimand.</p>;
  const W = Math.max(600, cw), l = 120, r = 16, top = 22, plotH = 230;
  const vals = specs.flatMap((s) => [s.estimate!, s.low ?? s.estimate!, s.high ?? s.estimate!]).concat([0]);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = (hi - lo) * 0.08 || 1;
  lo -= pad; hi += pad;
  const x = (i: number) => l + ((i + 0.5) / n) * (W - l - r);
  const y = (v: number) => top + ((hi - v) / (hi - lo)) * plotH;
  const opts = DIMS.map((d) => ({ dim: d, values: [...new Set(specs.map((s) => String(s[d])))] })).filter((o) => o.values.length > 1 || o.dim === 'covariates');
  const rowH = 16;
  const matTop = top + plotH + 26;
  const H = matTop + opts.reduce((a, o) => a + o.values.length * rowH + 8, 0) + 4;
  const ticks = niceTicks(lo, hi);
  let yy = matTop;
  return (
    <div className="chart-wrap" ref={ref}>
      <svg width={W} viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label={`Specification curve: ${n} estimates sorted from lowest to highest with intervals, and the decision matrix below. Use the table toggle for the same data.`}>
        {ticks.map((t, i) => <g key={i}><line x1={l} x2={W - r} y1={y(t)} y2={y(t)} className="grid" /><text x={l - 6} y={y(t) + 4} className="axis" textAnchor="end">{Number(t.toPrecision(6))}</text></g>)}
        <line x1={l} x2={W - r} y1={y(0)} y2={y(0)} className="zero" />
        <text x={l} y={12} className="axis">estimated effect ({plan.outcomeUnit || 'outcome units'} per {plan.predictorUnit || 'unit'})</text>
        {specs.map((s, i) => (
          <g key={s.index} className={`pt${sel === s.index ? ' sel' : ''}`} onClick={() => onSel(s.index)} role="button" tabIndex={0} aria-label={`specification ${s.index}: estimate ${f(s.estimate)}`} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSel(s.index); } }}>
            <rect x={x(i) - (W - l - r) / n / 2} y={top} width={(W - l - r) / n} height={H - top} className="hit" />
            {s.low !== null && s.low !== undefined && <line x1={x(i)} x2={x(i)} y1={y(s.low)} y2={y(s.high!)} className="ci" />}
            <circle cx={x(i)} cy={y(s.estimate!)} r={sel === s.index ? 4.5 : 3} className={s.low === null || s.low === undefined ? 'est no-ci' : s.low > 0 || s.high! < 0 ? 'est excl' : 'est'} />
          </g>
        ))}
        {opts.map((o) => {
          const start = yy;
          yy += o.values.length * rowH + 8;
          return (
            <g key={o.dim}>
              <text x={l - 6} y={start - 2} className="axis" textAnchor="end">{o.dim}</text>
              {o.values.map((v, k) => (
                <g key={v}>
                  <text x={l - 6} y={start + k * rowH + 12} className="axis mono-fill" textAnchor="end">{v}</text>
                  {specs.map((s, i) => <rect key={s.index} x={x(i) - 2.5} y={start + k * rowH + 4} width={5} height={9} className={String(s[o.dim]) === v ? 'cell on' : 'cell'} />)}
                </g>
              ))}
            </g>
          );
        })}
      </svg>
      <p className="small muted">Points are estimates sorted from lowest to highest; vertical lines are {Math.round(plan.confidence * 100)}% intervals where the method is valid. Filled squares in the matrix show which option each specification used. Green points: the interval excludes zero (not a test across specifications). Hollow points have no valid interval.</p>
    </div>
  );
}

function SpecTable({ specs, sel, onSel }: { specs: RelationshipSpec[]; sel: number | null; onSel: (i: number) => void }) {
  return (
    <div className="table-wrap tall">
      <table className="table compact">
        <caption className="sr-only">Specifications for this estimand</caption>
        <thead><tr><th className="num">#</th><th>filter</th><th>covariates</th><th>outliers</th><th>interval</th><th>status</th><th className="num">n</th><th className="num">estimate</th><th className="num">low</th><th className="num">high</th><th>interval note</th></tr></thead>
        <tbody>
          {specs.map((s) => (
            <tr key={s.index} className={sel === s.index ? 'focus' : ''} onClick={() => onSel(s.index)}>
              <td className="num"><button className="link" onClick={() => onSel(s.index)}>{s.index}</button></td>
              <td className="mono">{s.filter}</td><td className="mono">{s.covariates}</td><td className="mono">{s.outliers}</td><td className="mono">{s.interval}</td>
              <td>{s.status}</td><td className="num">{s.n ?? ''}</td><td className="num">{f(s.estimate)}</td><td className="num">{f(s.low)}</td><td className="num">{f(s.high)}</td><td className="small muted">{s.intervalNote ?? s.reason ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Detail({ d, plan }: { d: any; plan: RelationshipPlan }) {
  if (d.status !== 'valid') return <p className="bad-text">Invalid: {d.reason}</p>;
  return (
    <div className="spec-detail">
      <dl className="kv small">
        <dt>estimand</dt><dd>{d.estimandLabel}</dd>
        <dt>estimate</dt><dd><strong>{f(d.estimate, 4)}</strong>{d.low !== null ? ` [${f(d.low, 4)}, ${f(d.high, 4)}]` : ''} {plan.outcomeUnit && d.spec.transform === 'identity' ? `${plan.outcomeUnit} per ${plan.predictorUnit || 'unit'}` : ''}</dd>
        <dt>interval</dt><dd>{d.intervalNote}</dd>
        <dt>method</dt><dd>Ordinary least squares (numpy.linalg.lstsq); filter <span className="mono">{d.spec.filter}</span>, covariates <span className="mono">{d.spec.covariates}</span>, outliers <span className="mono">{d.spec.outliers}</span>, outcome <span className="mono">{d.spec.transform}</span></dd>
        <dt>rows used</dt><dd>{d.n} ({d.excludedCount} excluded)</dd>
        <dt>exclusions</dt><dd>{d.detail.excluded.length ? d.detail.excluded.map((x: any) => `${x.rule}: ${x.rows.length} row(s)`).join('; ') : 'none'}</dd>
        <dt>diagnostics</dt><dd>R² {f(d.diagnostics.r2)} · adjusted {f(d.diagnostics.adjR2)} · residual sd {f(d.diagnostics.residualSd)} · condition number {f(d.diagnostics.conditionNumber, 1)} · max leverage {f(d.diagnostics.maxLeverage)} · max Cook's distance {f(d.diagnostics.maxCooksDistance)}</dd>
      </dl>
      <div className="table-wrap">
        <table className="table compact">
          <caption className="small muted">All coefficients (classical standard errors shown for reference)</caption>
          <thead><tr><th>term</th><th className="num">coefficient</th><th className="num">classical se</th></tr></thead>
          <tbody>{d.detail.terms.map((t: string, i: number) => <tr key={t}><th scope="row" className="mono">{t}</th><td className="num">{f(d.detail.coefficients[i], 4)}</td><td className="num">{f(d.detail.classicalSe[i], 4)}</td></tr>)}</tbody>
        </table>
      </div>
    </div>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { rankMatrix, scoreMatrix } from '../lib/project';
import type { EntitySummary, Project, RankingPlan, RankingResult } from '../lib/types';
import type { Engine } from '../worker/client';
import { useWidth } from './useWidth';

interface Props {
  project: Project;
  plan: RankingPlan;
  result: RankingResult;
  engine: Engine;
  ensureEngine: () => Promise<boolean>;
  inspectable: boolean;
}

const pct = (v: number | undefined | null) => (v === undefined || v === null ? 'n/a' : `${(v * 100).toFixed(v === 0 || v === 1 ? 0 : 1)}%`);
const num = (v: number, d = 3) => (Number.isFinite(v) ? Number(v.toFixed(d)).toString() : 'n/a');

export function RankingResults({ project, plan, result, engine, ensureEngine, inspectable }: Props) {
  const E = result.entities.length;
  const [S] = result.arrays.shape;
  const ranks = useMemo(() => rankMatrix(result), [result]);
  const scores = useMemo(() => scoreMatrix(result), [result]);
  const cached = useMemo(() => ({ current: null as Promise<void> | null }), [result]);
  const withRanks = async () => {
    if (!(await ensureEngine())) return false;
    cached.current ??= engine.ensureRanks(result.key, ranks, result.arrays.shape);
    await cached.current;
    return true;
  };
  const byMedian = useMemo(() => [...result.summary.entities].map((e, i) => ({ ...e, idx: i })).sort((a, b) => (a.median ?? Infinity) - (b.median ?? Infinity) || a.id.localeCompare(b.id)), [result]);
  const [selected, setSelected] = useState<number[]>(() => byMedian.slice(0, 4).map((e) => e.idx));
  const [focus, setFocus] = useState<number>(() => mostSensitive(byMedian.slice(0, 4))?.idx ?? byMedian[0]?.idx ?? 0);
  const [mode, setMode] = useState<'chart' | 'table'>('chart');
  const [specIdx, setSpecIdx] = useState<number | null>(() => result.specs.find((s) => s.status === 'valid')?.index ?? null);
  const [pairState, setPair] = useState<{ idx: number[]; m: Array<Array<number | null>> } | null>(null);
  const pair = pairState && pairState.idx.join(',') === selected.join(',') ? pairState.m : null;
  const [infl, setInfl] = useState<any>(null);
  const [detail, setDetail] = useState<any>(null);
  const [qErr, setQErr] = useState<string | null>(null);
  const [indicator, setIndicator] = useState(result.indicators[0]);
  const [showAll, setShowAll] = useState(E <= 40);
  const valid = useMemo(() => result.specs.map((s) => s.status === 'valid'), [result]);
  const statuses = useMemo(() => result.specs.map((s) => s.status), [result]);

  useEffect(() => {
    let live = true;
    if (selected.length < 2) { setPair(null); return; }
    void withRanks().then((ok) => ok && engine.call('query_pairwise_cached', result.key, valid, selected)).then((m) => { if (live && m) setPair({ idx: selected, m: m as any }); }, (e) => live && setQErr(String(e.message ?? e)));
    return () => { live = false; };
  }, [selected, result, valid, engine, ensureEngine]);

  useEffect(() => {
    let live = true;
    if (!inspectable) return;
    void withRanks().then((ok) => ok && engine.call('query_influence_cached', project.dataset, plan, result.key, statuses, focus)).then((m) => { if (live && m) setInfl(m); }, (e) => live && setQErr(String(e.message ?? e)));
    return () => { live = false; };
  }, [focus, result, plan, project.dataset, statuses, engine, ensureEngine, inspectable]);

  useEffect(() => {
    let live = true;
    setDetail(null);
    if (specIdx === null || !inspectable) return;
    void ensureEngine().then((ok) => ok && engine.call('inspect', project.dataset, plan, specIdx)).then((m) => { if (live && m) setDetail(m); }, (e) => live && setQErr(String(e.message ?? e)));
    return () => { live = false; };
  }, [specIdx, plan, project.dataset, engine, ensureEngine, inspectable]);

  const toggle = (i: number) => setSelected((s) => (s.includes(i) ? s.filter((x) => x !== i) : s.length >= 8 ? [...s.slice(1), i] : [...s, i]));
  const shown = showAll ? byMedian : byMedian.slice(0, 40);
  const validCount = result.summary.counts.valid;
  const sampled = result.specs.filter((s) => s.status === 'valid' && s.weightsSource === 'sampled');

  return (
    <div className="ranking-results">
      {qErr && <p className="notice bad small" role="alert">{qErr}</p>}
      <SectionNav items={RANK_SECTIONS} />
      <RankingGlance rows={byMedian} validCount={validCount} topK={result.summary.topK} onFocus={(i) => { setFocus(i); setSelected((s) => (s.includes(i) ? s : s.length >= 8 ? [...s.slice(1), i] : [...s, i])); document.getElementById('fp-moves')?.scrollIntoView({ block: 'start' }); }} />
      <section className="panel" id="fp-dist">
        <div className="row wrap between">
          <h3 className="h">Rank distributions across {validCount} valid specifications</h3>
          <div className="seg" role="group" aria-label="Display">
            <button className={`btn small${mode === 'chart' ? ' active' : ''}`} aria-pressed={mode === 'chart'} onClick={() => setMode('chart')}>chart</button>
            <button className={`btn small${mode === 'table' ? ' active' : ''}`} aria-pressed={mode === 'table'} onClick={() => setMode('table')}>table</button>
          </div>
        </div>
        <p className="small muted">Rank 1 is best. Thin line: min to max; thick line: 5th to 95th percentile; box: 25th to 75th; tick: median. Each specification counts once. Select up to 8 entities to compare; the focused entity drives the decision views below.</p>
        {mode === 'chart' ? <RankChart rows={shown} E={E} selected={selected} focus={focus} onToggle={toggle} onFocus={setFocus} topK={result.summary.topK} /> : <RankTable rows={shown} selected={selected} focus={focus} onToggle={toggle} onFocus={setFocus} topK={result.summary.topK} />}
        {!showAll && <button className="btn ghost" onClick={() => setShowAll(true)}>show all {E} entities</button>}
        <p className="small note">{result.summary.topKNote}</p>
      </section>

      <div className="two-col">
        <section className="panel" id="fp-pairs">
          <h3 className="h">Pairwise ordering</h3>
          {selected.length < 2 ? <p className="muted small">Select at least two entities.</p> : !pair ? <p className="muted small">Computing…</p> : (
            <div className="table-wrap">
              <table className="table compact">
                <caption className="small muted">Share of valid specifications (where both are ranked) in which the row entity ranks above the column entity.</caption>
                <thead><tr><th /> {selected.map((i) => <th key={i} className="num">{result.entities[i]}</th>)}</tr></thead>
                <tbody>
                  {selected.map((a, r) => (
                    <tr key={a}><th scope="row">{result.entities[a]}</th>{selected.map((b, c) => <td key={b} className={`num heat${pair[r][c] === null ? '' : pair[r][c]! >= 0.95 ? ' hi' : pair[r][c]! <= 0.05 ? ' lo' : ''}`}>{pair[r][c] === null ? '·' : pct(pair[r][c])}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <section className="panel" id="fp-moves">
          <h3 className="h">What moves {result.entities[focus]}</h3>
          {!inspectable ? <p className="muted small">The dataset changed after this result; decision views need the original data.</p> : !infl ? <p className="muted small">Computing…</p> : (
            <>
              {Object.entries(infl.byOption as Record<string, any[]>).filter(([, v]) => v.length > 1).map(([dim, opts]) => (
                <div key={dim} className="opt-block">
                  <div className="small muted">{dim === 'weights_source' ? 'weights' : dim}</div>
                  {opts.map((o: any) => (
                    <div key={o.option} className="opt-bar small">
                      <span className="mono opt-label">{o.option}</span>
                      <span className="bar-track" aria-hidden="true"><span className="bar-range" style={{ left: `${((o.min - 1) / Math.max(1, E - 1)) * 100}%`, width: `${Math.max(0.8, ((o.max - o.min) / Math.max(1, E - 1)) * 100)}%` }} /><span className="bar-mid" style={{ left: `${((o.medianRank - 1) / Math.max(1, E - 1)) * 100}%` }} /></span>
                      <span>median {num(o.medianRank, 1)} · range {num(o.min, 0)} to {num(o.max, 0)} · n {o.n}</span>
                    </div>
                  ))}
                </div>
              ))}
              {infl.weightRankCorrelation.length > 0 && (
                <>
                  <div className="small muted">Spearman correlation between an indicator's sampled weight and this entity's rank ({sampled.length} sampled specifications)</div>
                  <ul className="plain small corr">
                    {infl.weightRankCorrelation.map((c: any) => <li key={c.indicator}><span className="mono">{c.indicator}</span> <strong className={c.rho !== null && c.rho < -0.3 ? 'ok-text' : c.rho !== null && c.rho > 0.3 ? 'bad-text' : ''}>{c.rho === null ? 'n/a' : (c.rho >= 0 ? '+' : '') + c.rho.toFixed(2)}</strong></li>)}
                    {infl.weightRankCorrelation.some((c: any) => c.rho === null) && <li className="muted">n/a: the rank or the weight does not vary across these specifications</li>}
                  </ul>
                  <WeightScatter result={result} ranks={ranks} entity={focus} indicator={indicator} setIndicator={setIndicator} />
                </>
              )}
              <p className="small note">{infl.note}</p>
            </>
          )}
        </section>
      </div>

      <section className="panel" id="fp-specs">
        <h3 className="h">Specifications</h3>
        <SpecTable result={result} ranks={ranks} scores={scores} entity={focus} S={S} E={E} selectedSpec={specIdx} onSelect={setSpecIdx} />
      </section>

      <section className="panel" id="fp-selected" aria-live="polite">
        <h3 className="h">Selected specification {specIdx !== null ? `#${specIdx}` : ''}</h3>
        {!inspectable ? <p className="muted small">The dataset changed after this result, so its inputs cannot be shown faithfully.</p> : specIdx === null ? <p className="muted small">Select a specification.</p> : !detail ? <p className="muted small">Recomputing with full detail…</p> : <SpecDetail d={detail} />}
      </section>
    </div>
  );
}

function RankChart({ rows, E, selected, focus, onToggle, onFocus, topK }: { rows: Array<EntitySummary & { idx: number }>; E: number; selected: number[]; focus: number; onToggle: (i: number) => void; onFocus: (i: number) => void; topK: number }) {
  const [ref, cw] = useWidth<HTMLDivElement>();
  const W = Math.max(600, cw), rowH = 24, left = 130, right = 90, top = 26;
  const x = (r: number) => left + ((r - 1) / Math.max(1, E - 1)) * (W - left - right);
  const ticks = [...new Set([1, Math.ceil(E / 4), Math.ceil(E / 2), Math.ceil((3 * E) / 4), E])];
  return (
    <div className="chart-wrap" ref={ref}>
      <svg width={W} viewBox={`0 0 ${W} ${top + rows.length * rowH + 22}`} role="img" aria-label="Rank distribution per entity; an equivalent table is available with the table toggle" className="chart">
        {ticks.map((t) => <g key={t}><line x1={x(t)} x2={x(t)} y1={top - 6} y2={top + rows.length * rowH} className="grid" /><text x={x(t)} y={14} className="axis" textAnchor="middle">rank {t}</text></g>)}
        <line x1={x(topK + 0.5)} x2={x(topK + 0.5)} y1={top - 6} y2={top + rows.length * rowH} className="grid strong" />
        <text x={x(topK + 0.5)} y={top + rows.length * rowH + 14} className="axis" textAnchor="middle">top {topK} cut</text>
        <text x={W - 6} y={14} className="axis" textAnchor="end">in top {topK}</text>
        {rows.map((e, i) => {
          const y = top + i * rowH + rowH / 2;
          const sel = selected.includes(e.idx);
          return (
            <g key={e.id} className={`rank-row${sel ? ' sel' : ''}${focus === e.idx ? ' focus' : ''}`} onClick={() => { onToggle(e.idx); onFocus(e.idx); }} role="button" tabIndex={0} aria-label={`${e.id}: median rank ${e.median ?? 'n/a'}`} onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onToggle(e.idx); onFocus(e.idx); } }}>
              <rect x={0} y={y - rowH / 2} width={W} height={rowH} className="row-bg" />
              <text x={left - 10} y={y + 4} textAnchor="end" className="label">{sel ? '■ ' : '□ '}{e.id}</text>
              {e.evaluated > 0 ? (
                <>
                  <line x1={x(e.min!)} x2={x(e.max!)} y1={y} y2={y} className="range-thin" />
                  <line x1={x(e.p05!)} x2={x(e.p95!)} y1={y} y2={y} className="range-mid" />
                  <rect x={x(e.p25!)} y={y - 5} width={Math.max(2, x(e.p75!) - x(e.p25!))} height={10} className="iqr" />
                  <line x1={x(e.median!)} x2={x(e.median!)} y1={y - 8} y2={y + 8} className="median" />
                  <text x={W - 6} y={y + 4} className="label" textAnchor="end">{pct(e.topK)}</text>
                </>
              ) : <text x={left + 4} y={y + 4} className="label muted-fill">not ranked in any valid specification</text>}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function RankTable({ rows, selected, focus, onToggle, onFocus, topK }: { rows: Array<EntitySummary & { idx: number }>; selected: number[]; focus: number; onToggle: (i: number) => void; onFocus: (i: number) => void; topK: number }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <caption className="sr-only">Rank distribution per entity</caption>
        <thead><tr><th>compare</th><th>entity</th><th className="num">evaluated</th><th className="num">median</th><th className="num">5th</th><th className="num">95th</th><th className="num">min</th><th className="num">max</th><th className="num">top {topK}</th><th className="num">rank 1</th></tr></thead>
        <tbody>
          {rows.map((e) => (
            <tr key={e.id} className={focus === e.idx ? 'focus' : ''}>
              <td><input type="checkbox" aria-label={`compare ${e.id}`} checked={selected.includes(e.idx)} onChange={() => { onToggle(e.idx); onFocus(e.idx); }} /></td>
              <th scope="row"><button className="link" onClick={() => onFocus(e.idx)}>{e.id}</button></th>
              <td className="num">{e.evaluated}</td>
              <td className="num">{e.median ?? 'n/a'}</td><td className="num">{e.p05 !== undefined ? num(e.p05, 1) : ''}</td><td className="num">{e.p95 !== undefined ? num(e.p95, 1) : ''}</td>
              <td className="num">{e.min ?? ''}</td><td className="num">{e.max ?? ''}</td>
              <td className="num">{pct(e.topK)}</td><td className="num">{pct(e.best)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WeightScatter({ result, ranks, entity, indicator, setIndicator }: { result: RankingResult; ranks: Float32Array; entity: number; indicator: string; setIndicator: (s: string) => void }) {
  const E = result.entities.length;
  const pts = result.specs.filter((s) => s.status === 'valid' && s.weightsSource === 'sampled').map((s) => ({ w: s.weights[indicator], r: ranks[s.index * E + entity], i: s.index })).filter((p) => Number.isFinite(p.r));
  const W = 420, H = 200, l = 44, b = 30, t = 10, r = 10;
  const constantRank = pts.length > 0 && pts.every((p) => p.r === pts[0].r);
  const maxR = Math.max(2, ...pts.map((p) => p.r));
  const x = (w: number) => l + w * (W - l - r);
  const y = (rk: number) => t + ((rk - 1) / Math.max(1, maxR - 1)) * (H - t - b);
  return (
    <div className="scatter">
      <label className="inline small">weight of
        <select className="input" value={indicator} onChange={(e) => setIndicator(e.target.value)}>{result.indicators.map((n) => <option key={n}>{n}</option>)}</select>
      </label>
      {constantRank ? <p className="small muted">{result.entities[entity]} has rank {pts[0].r} in all {pts.length} sampled specifications, so the weight of {indicator} cannot move it. Nothing to plot.</p> : pts.length === 0 ? <p className="small muted">{result.entities[entity]} is not ranked in any sampled specification.</p> : (
      <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label={`Rank of ${result.entities[entity]} against the sampled weight of ${indicator}, one point per sampled specification`}>
        <line x1={l} x2={W - r} y1={H - b} y2={H - b} className="axis-line" /><line x1={l} x2={l} y1={t} y2={H - b} className="axis-line" />
        {[0, 0.25, 0.5, 0.75, 1].map((v) => <text key={v} x={x(v)} y={H - b + 14} className="axis" textAnchor="middle">{v}</text>)}
        <text x={(l + W - r) / 2} y={H - 2} className="axis" textAnchor="middle">sampled weight of {indicator} (normalized to sum 1)</text>
        {[1, Math.round((1 + maxR) / 2), maxR].map((v) => <text key={v} x={l - 6} y={y(v) + 4} className="axis" textAnchor="end">{v}</text>)}
        <text x={10} y={t + 8} className="axis">rank</text>
        {pts.map((p) => <circle key={p.i} cx={x(p.w)} cy={y(p.r)} r={2.6} className="dot" />)}
      </svg>
      )}
    </div>
  );
}

function SpecTable({ result, ranks, scores, entity, S, E, selectedSpec, onSelect }: { result: RankingResult; ranks: Float32Array; scores: Float64Array; entity: number; S: number; E: number; selectedSpec: number | null; onSelect: (i: number) => void }) {
  const [filter, setFilter] = useState<'all' | 'valid' | 'invalid' | 'other'>('all');
  const [limit, setLimit] = useState(100);
  const rows = result.specs.filter((s) => filter === 'all' || (filter === 'other' ? s.status === 'cancelled' || s.status === 'uncomputed' : s.status === filter));
  void S;
  return (
    <>
      <div className="row wrap gap small">
        <label className="inline">show<select className="input" value={filter} onChange={(e) => setFilter(e.target.value as any)}><option value="all">all</option><option value="valid">valid</option><option value="invalid">invalid</option><option value="other">cancelled or uncomputed</option></select></label>
        <span className="muted">{rows.length} specifications · rank and score of {result.entities[entity]}</span>
      </div>
      <div className="table-wrap tall">
        <table className="table compact">
          <thead><tr><th className="num">#</th><th>normalization</th><th>missing</th><th>aggregation</th><th>weights</th><th>status</th><th className="num">entities</th><th className="num">rank</th><th className="num">score</th></tr></thead>
          <tbody>
            {rows.slice(0, limit).map((s) => {
              const rk = ranks[s.index * E + entity];
              return (
                <tr key={s.index} className={`${selectedSpec === s.index ? 'focus ' : ''}st-${s.status}`} onClick={() => onSelect(s.index)}>
                  <td className="num"><button className="link" onClick={() => onSelect(s.index)} aria-label={`inspect specification ${s.index}`}>{s.index}</button></td>
                  <td className="mono">{s.normalization}</td><td className="mono">{s.missing}</td><td className="mono">{s.aggregation}</td>
                  <td className="mono" title={Object.entries(s.weights).map(([k, v]) => `${k} ${v.toFixed(3)}`).join(', ')}>{s.weightsId}</td>
                  <td>{s.status === 'valid' ? '✓ valid' : s.status === 'invalid' ? <span className="bad-text" title={s.reason ?? ''}>✗ invalid</span> : <span className="warn-text">{s.status}</span>}</td>
                  <td className="num">{s.remaining ?? ''}</td>
                  <td className="num">{Number.isFinite(rk) ? rk : ''}</td>
                  <td className="num">{Number.isFinite(scores[s.index * E + entity]) ? scores[s.index * E + entity].toFixed(4) : ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.length > limit && <button className="btn ghost" onClick={() => setLimit(limit + 200)}>show more ({rows.length - limit} hidden)</button>}
    </>
  );
}

function SpecDetail({ d }: { d: any }) {
  if (d.status !== 'valid') return <p className="bad-text">Invalid: {d.reason}</p>;
  const w: number[] = d.weights;
  return (
    <div className="spec-detail">
      <dl className="kv small">
        <dt>normalization</dt><dd><span className="mono">{d.spec.normalization}</span>: {d.methods.normalization}</dd>
        <dt>missing values</dt><dd><span className="mono">{d.spec.missing}</span>: {d.methods.missing}</dd>
        <dt>aggregation</dt><dd><span className="mono">{d.spec.aggregation}</span>: {d.methods.aggregation}</dd>
        <dt>ties</dt><dd>{d.methods.ties}</dd>
        <dt>weights</dt><dd>{d.spec.weightsId} ({d.spec.weightsSource}): {d.indicators.map((n: string, i: number) => `${n} ${w[i].toFixed(3)}`).join(', ')}</dd>
        <dt>contributions</dt><dd>{d.contributionScale}</dd>
        <dt>exclusions</dt><dd>{d.excluded.length ? d.excluded.map((x: any) => `${x.entity} (${x.reason})`).join('; ') : 'none'}</dd>
        {d.notes.length > 0 && (<><dt>notes</dt><dd>{d.notes.join('; ')}</dd></>)}
      </dl>
      <div className="table-wrap tall">
        <table className="table compact">
          <caption className="small muted">Per indicator: raw value → normalized value → contribution. * marks an imputed value.</caption>
          <thead><tr><th className="num">rank</th><th>entity</th><th className="num">score</th>{d.indicators.map((n: string) => <th key={n} className="num mono">{n}</th>)}</tr></thead>
          <tbody>
            {d.rows.map((r: any) => (
              <tr key={r.entity}>
                <td className="num">{r.rank}</td><th scope="row">{r.entity}</th><td className="num">{r.score.toFixed(4)}</td>
                {d.indicators.map((n: string, j: number) => <td key={n} className="num cell3"><span className="muted">{num(r.raw[j], 2)}{r.imputed[j] ? '*' : ''}</span> → {num(r.normalized[j], 3)} → <strong>{num(r.contributions[j], 3)}</strong></td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

type Row = EntitySummary & { idx: number };

const RANK_SECTIONS: Array<[string, string]> = [['fp-glance', 'at a glance'], ['fp-dist', 'distributions'], ['fp-pairs', 'pairwise'], ['fp-moves', 'what moves it'], ['fp-specs', 'specifications'], ['fp-selected', 'selected']];

const spread = (e: EntitySummary) => (e.evaluated > 0 && e.p05 !== undefined && e.p95 !== undefined ? e.p95 - e.p05 : -1);

/** The entity whose rank moves most between the 5th and 95th percentile (ties: better median first). */
export function mostSensitive(rows: Row[]): Row | undefined {
  return rows.reduce<Row | undefined>((best, e) => (spread(e) > (best ? spread(best) : -1) ? e : best), undefined);
}

export function SectionNav({ items }: { items: Array<[string, string]> }) {
  const [active, setActive] = useState(items[0]?.[0]);
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const seen = new Map<string, boolean>();
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) seen.set(e.target.id, e.isIntersecting);
      const first = items.find(([id]) => seen.get(id));
      if (first) setActive(first[0]);
    }, { rootMargin: '-120px 0px -55% 0px' });
    for (const [id] of items) { const el = document.getElementById(id); if (el) io.observe(el); }
    return () => io.disconnect();
  }, [items]);
  return (
    <nav className="section-nav" aria-label="Sections of this result">
      <p className="section-nav-title">on this result</p>
      {items.map(([id, label], i) => (
        <a key={id} href={`#${id}`} className={active === id ? 'active' : ''} aria-current={active === id ? 'location' : undefined} onClick={(e) => { e.preventDefault(); setActive(id); document.getElementById(id)?.scrollIntoView({ block: 'start' }); }}>
          <span className="sn-dot" aria-hidden="true" /><span className="sn-num" aria-hidden="true">{String(i + 1).padStart(2, '0')}</span>{label}
        </a>
      ))}
    </nav>
  );
}

/**
 * Plain-language reading of the rank distributions. Every sentence is computed from the
 * summary shown below it and describes the declared specification space only.
 */
function RankingGlance({ rows, validCount, topK, onFocus }: { rows: Row[]; validCount: number; topK: number; onFocus: (i: number) => void }) {
  const ranked = rows.filter((e) => e.evaluated > 0);
  if (!validCount || !ranked.length) return null;
  const leaders = ranked.filter((e) => (e.best ?? 0) >= 0.95);
  const mostFirst = [...ranked].sort((a, b) => (b.best ?? 0) - (a.best ?? 0))[0];
  const stableTop = ranked.filter((e) => (e.topK ?? 0) >= 0.95);
  const contested = ranked.filter((e) => (e.topK ?? 0) > 0.05 && (e.topK ?? 0) < 0.95);
  const never = ranked.filter((e) => (e.topK ?? 0) === 0);
  const sensitive = mostSensitive(ranked)!;
  const steady = [...ranked].sort((a, b) => spread(a) - spread(b) || (a.median ?? 0) - (b.median ?? 0))[0];
  const names = (xs: Row[], max = 4) => (
    <>
      {xs.slice(0, max).map((e, i) => <span key={e.id}>{i > 0 ? ', ' : ''}<button className="link" onClick={() => onFocus(e.idx)}>{e.id}</button></span>)}
      {xs.length > max ? ` and ${xs.length - max} more` : ''}
    </>
  );
  return (
    <section className="panel glance" id="fp-glance" aria-label="At a glance">
      <h3 className="h">At a glance</h3>
      <ul className="plain glance-list">
        <li className={leaders.length ? 'g-ok' : 'g-warn'}>
          <span className="g-sym" aria-hidden="true">{leaders.length ? 'o' : '~'}</span>
          {leaders.length
            ? <span>{leaders.length === 1 ? <>{names(leaders)} ranks first in {leaders[0].best === 1 ? `all ${validCount}` : `${pct(leaders[0].best)} of the ${validCount}`} valid specifications.</> : <>{names(leaders)} each rank first in at least 95% of the {validCount} valid specifications (ties share a rank).</>}</span>
            : <span>No entity ranks first everywhere. {names([mostFirst])} ranks first most often, in {pct(mostFirst.best)} of valid specifications.</span>}
        </li>
        <li className={contested.length ? 'g-warn' : 'g-ok'}>
          <span className="g-sym" aria-hidden="true">{contested.length ? '~' : 'o'}</span>
          <span>
            {stableTop.length ? <>{stableTop.length} {stableTop.length === 1 ? 'entity is' : 'entities are'} in the top {topK} in at least 95% of them ({names(stableTop)}). </> : <>No entity is in the top {topK} in at least 95% of them. </>}
            {contested.length ? <>{contested.length} more move in and out of the top {topK} depending on the decisions.</> : <>Membership of the top {topK} does not depend on the decisions.</>}
          </span>
        </li>
        <li className="g-warn">
          <span className="g-sym" aria-hidden="true">{'<>'}</span>
          <span>Most sensitive: {names([sensitive])}, between rank {num(sensitive.p05!, 0)} and {num(sensitive.p95!, 0)} (5th to 95th percentile). Steadiest: {names([steady])}, {spread(steady) === 0 ? `always rank ${num(steady.median!, 0)}` : `between rank ${num(steady.p05!, 0)} and ${num(steady.p95!, 0)}`}.</span>
        </li>
        {never.length > 0 && (
          <li className="g-muted">
            <span className="g-sym" aria-hidden="true">-</span>
            <span>{never.length} {never.length === 1 ? 'entity never reaches' : 'entities never reach'} the top {topK} in any valid specification.</span>
          </li>
        )}
      </ul>
      <p className="small muted">Shares describe the declared specification space, not the probability that a ranking is true. Select a name to see what moves it.</p>
    </section>
  );
}

import { defaultRankingPlan, defaultRelationshipPlan, newId } from '../lib/project';
import type { Option, Plan, Project, RankingPlan, RelationshipPlan } from '../lib/types';

interface Props {
  project: Project;
  update: (fn: (p: Project) => Project) => void;
  onRun: (planId: string) => void;
  running: boolean;
}

const NORMS: Array<[string, string]> = [['minmax', 'min-max to [0, 1]'], ['zscore', 'z-score (sample sd)'], ['rank', 'percentile rank'], ['target', 'ratio to best (x > 0)']];
const MISSING: Array<[string, string]> = [['exclude', 'exclude incomplete entities'], ['median', 'impute the indicator median'], ['worst', 'impute the worst observed value']];
const AGGS: Array<[string, string]> = [['arithmetic', 'weighted arithmetic mean'], ['geometric', 'weighted geometric mean']];
const OUTLIERS: Array<[string, string]> = [['keep', 'keep all rows'], ['drop-z3', 'drop outcome |z| > 3']];
const TRANSFORMS: Array<[string, string]> = [['identity', 'outcome as measured'], ['log', 'log outcome (different estimand)']];
const INTERVALS: Array<[string, string]> = [['classical', 'classical OLS t interval'], ['hc3', 'HC3 robust t interval'], ['cluster', 'cluster-robust (CR1)'], ['bootstrap', 'percentile bootstrap'], ['none', 'no interval']];

export function plannedCount(plan: Plan): { planned: number; willRun: number; uncomputed: number } {
  let planned: number;
  if (plan.workflow === 'ranking') {
    const d = plan.decisions;
    const w = d.weights.fixed.length + (d.weights.sampling.enabled ? d.weights.sampling.count : 0);
    planned = d.normalization.options.length * d.missing.options.length * d.aggregation.options.length * w;
  } else {
    const d = plan.decisions;
    planned = d.filters.options.length * d.covariates.options.length * d.outliers.options.length * d.outcomeTransform.options.length * d.interval.options.length;
  }
  return { planned, willRun: Math.min(planned, plan.maxSpecs), uncomputed: Math.max(0, planned - plan.maxSpecs) };
}

/** Mirrors the engine's interval rules for display; the engine enforces them when running. */
export function intervalProblem(plan: RelationshipPlan, method: string): string | null {
  const u = plan.sampling.unit;
  if (method === 'none') return null;
  if (u === 'ordered') return 'blocked: rows are time-ordered or repeated, so no interval assuming independence is valid';
  if (u === 'independent' && method === 'cluster') return 'blocked: needs a cluster column';
  if (u === 'cluster' && (method === 'classical' || method === 'hc3')) return 'blocked: assumes independent rows';
  return null;
}

function OptionGroup({ title, all, chosen, onChange }: { title: string; all: Array<[string, string]>; chosen: Option[]; onChange: (o: Option[]) => void }) {
  return (
    <fieldset className="decision">
      <legend>{title}</legend>
      {all.map(([id, label]) => {
        const cur = chosen.find((o) => o.id === id);
        return (
          <div key={id} className="option-row">
            <label className="inline"><input type="checkbox" checked={!!cur} onChange={(e) => onChange(e.target.checked ? [...chosen, { id, rationale: '' }].sort((a, b) => all.findIndex((x) => x[0] === a.id) - all.findIndex((x) => x[0] === b.id)) : chosen.filter((o) => o.id !== id))} /> <span className="mono">{id}</span> <span className="muted small">{label}</span></label>
            {cur && <input className="input rationale" aria-label={`rationale for ${id}`} placeholder="why this alternative is reasonable" value={cur.rationale} onChange={(e) => onChange(chosen.map((o) => (o.id === id ? { ...o, rationale: e.target.value } : o)))} />}
          </div>
        );
      })}
      {chosen.length === 0 && <p className="bad-text small">Choose at least one option.</p>}
    </fieldset>
  );
}

export function PlanView({ project, update, onRun, running }: Props) {
  const ds = project.dataset;
  if (!ds) return <p className="empty">Accept a dataset in Data first.</p>;
  const entry = project.plans.find((e) => e.id === project.activePlan) ?? project.plans[0];
  const setPlan = (plan: Plan) => update((p) => ({ ...p, plans: p.plans.map((e) => (e.id === entry.id ? { ...e, plan } : e)) }));
  const add = (kind: 'ranking' | 'relationship') => {
    const plan = kind === 'ranking' ? defaultRankingPlan(ds) : defaultRelationshipPlan(ds);
    const id = newId('plan');
    update((p) => ({ ...p, plans: [...p.plans, { id, plan }], activePlan: id }));
  };
  const count = entry ? plannedCount(entry.plan) : null;
  return (
    <div className="plan-view">
      <div className="row wrap gap plan-tabs" role="tablist" aria-label="Analysis plans">
        {project.plans.map((e) => (
          <button key={e.id} role="tab" aria-selected={e.id === entry?.id} className={`tab${e.id === entry?.id ? ' active' : ''}`} onClick={() => update((p) => ({ ...p, activePlan: e.id }))}>{e.plan.title} <span className="muted small">{e.plan.workflow}</span></button>
        ))}
        <button className="btn ghost" onClick={() => add('ranking')}>+ ranking plan</button>
        <button className="btn ghost" onClick={() => add('relationship')}>+ relationship plan</button>
      </div>
      {entry && count && (
        <>
          <div className="run-bar">
            <span><strong>{count.planned.toLocaleString()}</strong> planned specifications · limit <input className="input num-input" type="number" min={1} max={100000} aria-label="maximum specifications" value={entry.plan.maxSpecs} onChange={(e) => setPlan({ ...entry.plan, maxSpecs: Math.max(1, Number(e.target.value) || 1) })} />{count.uncomputed > 0 && <span className="warn-text"> · {count.uncomputed.toLocaleString()} will stay uncomputed (a seeded uniform random subset is computed, so no decision option is dropped wholesale)</span>}</span>
            <button className="btn primary" disabled={running || count.planned === 0} onClick={() => onRun(entry.id)}>{running ? 'running…' : `run ${count.willRun.toLocaleString()} specifications`}</button>
          </div>
          <label className="title-field">plan title<input className="input" value={entry.plan.title} onChange={(e) => setPlan({ ...entry.plan, title: e.target.value })} /></label>
          {entry.plan.workflow === 'ranking' ? <RankingEditor plan={entry.plan} setPlan={setPlan} project={project} /> : <RelationshipEditor plan={entry.plan} setPlan={setPlan} project={project} />}
        </>
      )}
    </div>
  );
}

function RankingEditor({ plan, setPlan, project }: { plan: RankingPlan; setPlan: (p: Plan) => void; project: Project }) {
  const ds = project.dataset!;
  const d = plan.decisions;
  const setD = (k: keyof RankingPlan['decisions'], v: any) => setPlan({ ...plan, decisions: { ...d, [k]: v } });
  const included = plan.indicators.filter((i) => i.include);
  const entityCol = ds.columns.find((c) => c.name === plan.entity);
  const dupIds = entityCol ? entityCol.values.length - new Set(entityCol.values.map(String)).size : 0;
  return (
    <div className="editor">
      <section className="panel">
        <h3 className="h">Entities and indicators</h3>
        <label className="inline">entity identifier
          <select className="input" value={plan.entity} onChange={(e) => setPlan({ ...plan, entity: e.target.value, indicators: ds.columns.filter((c) => c.kind === 'number' && c.name !== e.target.value).map((c) => plan.indicators.find((i) => i.column === c.name) ?? { column: c.name, direction: 'higher', unit: c.unit ?? '', include: true }) })}>
            {ds.columns.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
          </select>
        </label>
        {dupIds > 0 && <p className="bad-text small">{dupIds} duplicate identifier(s) in {plan.entity}. Identifiers must be unique; resolve them in Data.</p>}
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>include</th><th>indicator</th><th>direction</th><th>unit</th></tr></thead>
            <tbody>
              {plan.indicators.map((ind, i) => (
                <tr key={ind.column}>
                  <td><input type="checkbox" aria-label={`include ${ind.column}`} checked={ind.include} onChange={(e) => setPlan({ ...plan, indicators: plan.indicators.map((x, j) => (j === i ? { ...x, include: e.target.checked } : x)) })} /></td>
                  <th scope="row" className="mono">{ind.column}</th>
                  <td><select className="input" aria-label={`direction of ${ind.column}`} value={ind.direction} onChange={(e) => setPlan({ ...plan, indicators: plan.indicators.map((x, j) => (j === i ? { ...x, direction: e.target.value as 'higher' | 'lower' } : x)) })}><option value="higher">higher is better</option><option value="lower">lower is better</option></select></td>
                  <td><input className="input unit" aria-label={`unit of ${ind.column}`} value={ind.unit} onChange={(e) => setPlan({ ...plan, indicators: plan.indicators.map((x, j) => (j === i ? { ...x, unit: e.target.value } : x)) })} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {included.length < 2 && <p className="bad-text small">Include at least two indicators.</p>}
      </section>
      <section className="panel decisions">
        <h3 className="h">Decisions and alternatives</h3>
        <div className="decision-grid">
          <OptionGroup title="normalization" all={NORMS} chosen={d.normalization.options} onChange={(o) => setD('normalization', { options: o })} />
          <OptionGroup title="missing values" all={MISSING} chosen={d.missing.options} onChange={(o) => setD('missing', { options: o })} />
          <OptionGroup title="aggregation" all={AGGS} chosen={d.aggregation.options} onChange={(o) => setD('aggregation', { options: o })} />
        </div>
        <div className="row wrap gap small">
          <label className="inline">ties<select className="input" value={plan.ties} onChange={(e) => setPlan({ ...plan, ties: e.target.value as 'min' | 'average' })}><option value="min">share best rank (1, 2, 2, 4)</option><option value="average">share average rank (1, 2.5, 2.5, 4)</option></select></label>
          <label className="inline">constant indicator<select className="input" value={plan.constantRule} onChange={(e) => setPlan({ ...plan, constantRule: e.target.value as 'invalid' | 'drop' })}><option value="invalid">specification is invalid</option><option value="drop">drop it and renormalize weights</option></select></label>
          <label className="inline">top-k<input className="input num-input" type="number" min={1} value={plan.topK} onChange={(e) => setPlan({ ...plan, topK: Math.max(1, Number(e.target.value) || 1) })} /></label>
        </div>
        <p className="small muted">Scores are rounded to 12 significant digits before ranking, so floating-point noise never breaks a tie.</p>
      </section>
      <section className="panel">
        <h3 className="h">Weights</h3>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>configuration</th>{included.map((i) => <th key={i.column} className="num mono">{i.column}</th>)}<th>rationale</th><th /></tr></thead>
            <tbody>
              {d.weights.fixed.map((fw, k) => (
                <tr key={k}>
                  <td><input className="input" aria-label="configuration id" value={fw.id} onChange={(e) => setD('weights', { ...d.weights, fixed: d.weights.fixed.map((x, j) => (j === k ? { ...x, id: e.target.value } : x)) })} /></td>
                  {included.map((i) => <td key={i.column}><input className="input num-input" type="number" min={0} step="any" aria-label={`weight ${i.column} in ${fw.id}`} value={fw.weights[i.column] ?? 0} onChange={(e) => setD('weights', { ...d.weights, fixed: d.weights.fixed.map((x, j) => (j === k ? { ...x, weights: { ...x.weights, [i.column]: Number(e.target.value) } } : x)) })} /></td>)}
                  <td><input className="input" aria-label={`rationale for ${fw.id}`} value={fw.rationale} onChange={(e) => setD('weights', { ...d.weights, fixed: d.weights.fixed.map((x, j) => (j === k ? { ...x, rationale: e.target.value } : x)) })} /></td>
                  <td><button className="btn ghost" aria-label={`remove ${fw.id}`} onClick={() => setD('weights', { ...d.weights, fixed: d.weights.fixed.filter((_, j) => j !== k) })}>remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button className="btn ghost" onClick={() => setD('weights', { ...d.weights, fixed: [...d.weights.fixed, { id: `fixed-${d.weights.fixed.length + 1}`, rationale: '', weights: Object.fromEntries(included.map((i) => [i.column, 1])) }] })}>+ fixed configuration</button>
        <p className="small muted">Weights are relative; each configuration is divided by its sum.</p>
        <fieldset className="decision">
          <legend><label className="inline"><input type="checkbox" checked={d.weights.sampling.enabled} onChange={(e) => setD('weights', { ...d.weights, sampling: { ...d.weights.sampling, enabled: e.target.checked } })} /> sampled weights</label></legend>
          <div className="row wrap gap small">
            <label className="inline">draws<input className="input num-input" type="number" min={0} max={20000} value={d.weights.sampling.count} onChange={(e) => setD('weights', { ...d.weights, sampling: { ...d.weights.sampling, count: Math.max(0, Number(e.target.value) || 0) } })} /></label>
            <label className="inline">seed<input className="input num-input" type="number" value={d.weights.sampling.seed} onChange={(e) => setD('weights', { ...d.weights, sampling: { ...d.weights.sampling, seed: Number(e.target.value) || 0 } })} /></label>
            <label className="inline">Dirichlet alpha<input className="input num-input" type="number" min={0.01} step="any" value={d.weights.sampling.alpha} onChange={(e) => setD('weights', { ...d.weights, sampling: { ...d.weights.sampling, alpha: Number(e.target.value) } })} /></label>
            <label className="inline">min weight<input className="input num-input" type="number" min={0} max={1} step="any" value={d.weights.sampling.minWeight} onChange={(e) => setD('weights', { ...d.weights, sampling: { ...d.weights.sampling, minWeight: Number(e.target.value) } })} /></label>
            <label className="inline">max weight<input className="input num-input" type="number" min={0} max={1} step="any" value={d.weights.sampling.maxWeight} onChange={(e) => setD('weights', { ...d.weights, sampling: { ...d.weights.sampling, maxWeight: Number(e.target.value) } })} /></label>
          </div>
          <input className="input rationale" aria-label="rationale for sampled weights" value={d.weights.sampling.rationale} onChange={(e) => setD('weights', { ...d.weights, sampling: { ...d.weights.sampling, rationale: e.target.value } })} />
          <p className="small muted">Generator: NumPy PCG64 with the seed above; draws from a symmetric Dirichlet(alpha) over the {included.length} included indicators, rejected and redrawn (up to 1000 times) when a weight falls outside the bounds. Draws that never satisfy the bounds are reported as invalid specifications. The sampled set is a declared scheme, not a probability distribution over true weights.</p>
        </fieldset>
      </section>
    </div>
  );
}

function RelationshipEditor({ plan, setPlan, project }: { plan: RelationshipPlan; setPlan: (p: Plan) => void; project: Project }) {
  const ds = project.dataset!;
  const nums = ds.columns.filter((c) => c.kind === 'number').map((c) => c.name);
  const all = ds.columns.map((c) => c.name);
  const d = plan.decisions;
  const setD = (k: keyof RelationshipPlan['decisions'], v: any) => setPlan({ ...plan, decisions: { ...d, [k]: v } });
  return (
    <div className="editor">
      <section className="panel">
        <h3 className="h">Effect definition</h3>
        <div className="form-grid">
          <label>outcome<select className="input" value={plan.outcome} onChange={(e) => setPlan({ ...plan, outcome: e.target.value })}>{nums.map((n) => <option key={n}>{n}</option>)}</select></label>
          <label>outcome unit<input className="input" value={plan.outcomeUnit} onChange={(e) => setPlan({ ...plan, outcomeUnit: e.target.value })} /></label>
          <label>predictor<select className="input" value={plan.predictor} onChange={(e) => setPlan({ ...plan, predictor: e.target.value })}>{nums.map((n) => <option key={n}>{n}</option>)}</select></label>
          <label>predictor unit<input className="input" value={plan.predictorUnit} onChange={(e) => setPlan({ ...plan, predictorUnit: e.target.value })} /></label>
        </div>
        <p className="small">Effect: change in <span className="mono">{plan.outcome}</span> ({plan.outcomeUnit || 'outcome units'}) per one {plan.predictorUnit || 'unit'} increase in <span className="mono">{plan.predictor}</span>, from an ordinary least squares fit, holding the chosen covariates fixed. An association, not a causal effect.</p>
        {plan.outcome === plan.predictor && <p className="bad-text small">Outcome and predictor must differ.</p>}
      </section>
      <section className="panel">
        <h3 className="h">Sampling unit</h3>
        <div className="row wrap gap">
          <label className="inline">rows are
            <select className="input" value={plan.sampling.unit} onChange={(e) => setPlan({ ...plan, sampling: { ...plan.sampling, unit: e.target.value as RelationshipPlan['sampling']['unit'] } })}>
              <option value="independent">independent units</option>
              <option value="cluster">clustered (grouped units)</option>
              <option value="ordered">time-ordered or repeated measures</option>
            </select>
          </label>
          {plan.sampling.unit === 'cluster' && (
            <label className="inline">cluster column<select className="input" value={plan.sampling.clusterColumn ?? ''} onChange={(e) => setPlan({ ...plan, sampling: { ...plan.sampling, clusterColumn: e.target.value } })}><option value="">choose…</option>{all.map((n) => <option key={n}>{n}</option>)}</select></label>
          )}
        </div>
        <input className="input rationale" aria-label="rationale for the sampling unit" value={plan.sampling.rationale} onChange={(e) => setPlan({ ...plan, sampling: { ...plan.sampling, rationale: e.target.value } })} />
        <p className="small muted">The sampling unit decides which intervals are valid. Independent-row bootstrap and HC3 are not valid for clustered or time-ordered rows. Time-series resampling is not supported, so ordered data get estimates without intervals.</p>
      </section>
      <section className="panel decisions">
        <h3 className="h">Decisions and alternatives</h3>
        <fieldset className="decision">
          <legend>row filters</legend>
          {d.filters.options.map((f, k) => (
            <div key={k} className="filter-row">
              <input className="input id-input" aria-label="filter id" value={f.id} onChange={(e) => setD('filters', { options: d.filters.options.map((x, j) => (j === k ? { ...x, id: e.target.value } : x)) })} />
              {f.rules.map((r, ri) => (
                <span key={ri} className="rule">
                  <select className="input" aria-label="filter column" value={r.column} onChange={(e) => setD('filters', { options: d.filters.options.map((x, j) => (j === k ? { ...x, rules: x.rules.map((y, q) => (q === ri ? { ...y, column: e.target.value } : y)) } : x)) })}>{all.map((n) => <option key={n}>{n}</option>)}</select>
                  <select className="input" aria-label="filter operator" value={r.op} onChange={(e) => setD('filters', { options: d.filters.options.map((x, j) => (j === k ? { ...x, rules: x.rules.map((y, q) => (q === ri ? { ...y, op: e.target.value } : y)) } : x)) })}>{['>=', '>', '<=', '<', '==', '!='].map((o) => <option key={o}>{o}</option>)}</select>
                  <input className="input num-input" aria-label="filter value" value={String(r.value)} onChange={(e) => { const v = e.target.value; const num = Number(v); setD('filters', { options: d.filters.options.map((x, j) => (j === k ? { ...x, rules: x.rules.map((y, q) => (q === ri ? { ...y, value: v !== '' && Number.isFinite(num) && nums.includes(y.column) ? num : v } : y)) } : x)) }); }} />
                  <button className="btn ghost" aria-label="remove rule" onClick={() => setD('filters', { options: d.filters.options.map((x, j) => (j === k ? { ...x, rules: x.rules.filter((_, q) => q !== ri) } : x)) })}>×</button>
                </span>
              ))}
              <button className="btn ghost" onClick={() => setD('filters', { options: d.filters.options.map((x, j) => (j === k ? { ...x, rules: [...x.rules, { column: nums[0], op: '>=', value: 0 }] } : x)) })}>+ rule</button>
              <input className="input rationale" aria-label={`rationale for ${f.id}`} placeholder="why" value={f.rationale} onChange={(e) => setD('filters', { options: d.filters.options.map((x, j) => (j === k ? { ...x, rationale: e.target.value } : x)) })} />
              {d.filters.options.length > 1 && <button className="btn ghost" onClick={() => setD('filters', { options: d.filters.options.filter((_, j) => j !== k) })}>remove</button>}
            </div>
          ))}
          <button className="btn ghost" onClick={() => setD('filters', { options: [...d.filters.options, { id: `filter-${d.filters.options.length + 1}`, rationale: '', rules: [] }] })}>+ filter alternative</button>
          <p className="small muted">Every alternative uses complete cases on the outcome, predictor, covariates and cluster column. Rows removed by each rule are listed per specification.</p>
        </fieldset>
        <fieldset className="decision">
          <legend>covariate sets</legend>
          {d.covariates.options.map((c, k) => (
            <div key={k} className="filter-row">
              <input className="input id-input" aria-label="covariate set id" value={c.id} onChange={(e) => setD('covariates', { options: d.covariates.options.map((x, j) => (j === k ? { ...x, id: e.target.value } : x)) })} />
              {all.filter((n) => n !== plan.outcome && n !== plan.predictor).map((n) => (
                <label key={n} className="inline small"><input type="checkbox" checked={c.columns.includes(n)} onChange={(e) => setD('covariates', { options: d.covariates.options.map((x, j) => (j === k ? { ...x, columns: e.target.checked ? [...x.columns, n] : x.columns.filter((y) => y !== n) } : x)) })} /> {n}</label>
              ))}
              <input className="input rationale" aria-label={`rationale for ${c.id}`} placeholder="why" value={c.rationale} onChange={(e) => setD('covariates', { options: d.covariates.options.map((x, j) => (j === k ? { ...x, rationale: e.target.value } : x)) })} />
              {d.covariates.options.length > 1 && <button className="btn ghost" onClick={() => setD('covariates', { options: d.covariates.options.filter((_, j) => j !== k) })}>remove</button>}
            </div>
          ))}
          <button className="btn ghost" onClick={() => setD('covariates', { options: [...d.covariates.options, { id: `covariates-${d.covariates.options.length + 1}`, rationale: '', columns: [] }] })}>+ covariate set</button>
          <p className="small muted">Text columns enter as indicator variables with the first level (alphabetical) as reference.</p>
        </fieldset>
        <div className="decision-grid">
          <OptionGroup title="outliers" all={OUTLIERS} chosen={d.outliers.options} onChange={(o) => setD('outliers', { options: o })} />
          <OptionGroup title="outcome transformation" all={TRANSFORMS} chosen={d.outcomeTransform.options} onChange={(o) => setD('outcomeTransform', { options: o })} />
          <OptionGroup title="interval" all={INTERVALS.map(([id, l]) => [id, `${l}${intervalProblem(plan, id) ? ` · ${intervalProblem(plan, id)}` : ''}`] as [string, string])} chosen={d.interval.options} onChange={(o) => setD('interval', { options: o })} />
        </div>
        <div className="row wrap gap small">
          <label className="inline">confidence level<select className="input" value={plan.confidence} onChange={(e) => setPlan({ ...plan, confidence: Number(e.target.value) })}><option value={0.9}>90%</option><option value={0.95}>95%</option><option value={0.99}>99%</option></select></label>
          <label className="inline">bootstrap replicates<input className="input num-input" type="number" min={99} max={9999} value={plan.bootstrap.replicates} onChange={(e) => setPlan({ ...plan, bootstrap: { ...plan.bootstrap, replicates: Number(e.target.value) || 999 } })} /></label>
          <label className="inline">bootstrap seed<input className="input num-input" type="number" value={plan.bootstrap.seed} onChange={(e) => setPlan({ ...plan, bootstrap: { ...plan.bootstrap, seed: Number(e.target.value) || 0 } })} /></label>
        </div>
      </section>
    </div>
  );
}

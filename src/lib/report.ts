// Static, self-contained HTML report. Every value from data or plans is escaped.
import { isCurrent } from './project';
import type { Plan, Project, RankingResult, RelationshipResult, RunRecord } from './types';

export function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const pct = (v: number | undefined) => (v === undefined ? 'n/a' : `${(v * 100).toFixed(1)}%`);
const n3 = (v: number | null | undefined) => (v === null || v === undefined ? 'n/a' : Number(v.toPrecision(4)).toString());

function decisions(plan: Plan): string {
  const groups = Object.entries(plan.decisions).map(([k, v]: [string, any]) => {
    if (k === 'weights') {
      const fixed = v.fixed.map((w: any) => `<li><code>${esc(w.id)}</code> ${esc(Object.entries(w.weights).map(([a, b]) => `${a} ${b}`).join(', '))}${w.rationale ? `: ${esc(w.rationale)}` : ''}</li>`).join('');
      const s = v.sampling;
      const samp = s.enabled ? `<li>${esc(s.count)} sampled configurations: symmetric Dirichlet(alpha = ${esc(s.alpha)}), NumPy PCG64 seed ${esc(s.seed)}, bounds ${esc(s.minWeight)} to ${esc(s.maxWeight)}${s.rationale ? `: ${esc(s.rationale)}` : ''}</li>` : '';
      return `<li><strong>weights</strong><ul>${fixed}${samp}</ul></li>`;
    }
    return `<li><strong>${esc(k)}</strong><ul>${v.options.map((o: any) => `<li><code>${esc(o.id)}</code>${o.columns ? ` [${esc(o.columns.join(', ') || 'none')}]` : ''}${o.rules ? ` [${esc(o.rules.map((r: any) => `${r.column} ${r.op} ${r.value}`).join(' and ') || 'no rules')}]` : ''}${o.rationale ? `: ${esc(o.rationale)}` : ''}</li>`).join('')}</ul></li>`;
  });
  return `<ul>${groups.join('')}</ul>`;
}

function rankingSection(r: RankingResult): string {
  const rows = [...r.summary.entities].sort((a, b) => (a.median ?? 1e9) - (b.median ?? 1e9)).slice(0, 30);
  return `<table><thead><tr><th>entity</th><th>evaluated</th><th>median rank</th><th>5th to 95th percentile</th><th>min to max</th><th>top ${r.summary.topK}</th></tr></thead><tbody>${rows.map((e) => `<tr><td>${esc(e.id)}</td><td>${e.evaluated}</td><td>${e.median ?? 'n/a'}</td><td>${e.p05 !== undefined ? `${n3(e.p05)} to ${n3(e.p95)}` : ''}</td><td>${e.min ?? ''} to ${e.max ?? ''}</td><td>${pct(e.topK)}</td></tr>`).join('')}</tbody></table><p class="note">${esc(r.summary.topKNote)}</p>`;
}

function relationshipSection(r: RelationshipResult): string {
  const est = r.summary.estimands.map((e) => `<li><strong>${esc(e.label)}</strong>: ${e.valid} valid, ${e.invalid} invalid; median ${n3(e.median)}, range ${n3(e.min)} to ${n3(e.max)}${e.positiveFraction !== undefined ? `, ${pct(e.positiveFraction)} positive` : ''}</li>`).join('');
  const rows = r.specs.map((s) => `<tr><td>${s.index}</td><td>${esc(s.estimand)}</td><td>${esc(s.filter)}</td><td>${esc(s.covariates)}</td><td>${esc(s.outliers)}</td><td>${esc(s.interval)}</td><td>${esc(s.status)}</td><td>${s.n ?? ''}</td><td>${n3(s.estimate)}</td><td>${s.low !== undefined && s.low !== null ? `${n3(s.low)} to ${n3(s.high)}` : esc(s.intervalNote ?? s.reason ?? '')}</td></tr>`).join('');
  return `<ul>${est}</ul><p class="note">${esc(r.summary.note)}</p><table><thead><tr><th>#</th><th>estimand</th><th>filter</th><th>covariates</th><th>outliers</th><th>interval method</th><th>status</th><th>n</th><th>estimate</th><th>interval</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function runSection(p: Project, run: RunRecord): string {
  const r = run.result;
  const counts = r.workflow === 'ranking' ? r.summary.counts : r.counts;
  const reasons = new Map<string, number>();
  for (const s of r.specs as Array<{ status: string; reason?: string | null }>) if (s.status === 'invalid') reasons.set(s.reason ?? '', (reasons.get(s.reason ?? '') ?? 0) + 1);
  return `<section><h2>${esc(run.plan.title)} <small>(${esc(r.workflow)})</small></h2>
<p>${isCurrent(p, run) ? 'Current result.' : '<strong>Stale result</strong>: the plan or data changed afterwards.'} Computed ${esc(r.createdAt)} with engine ${esc(r.engine)} (${esc(r.algorithm)}), Python ${esc(r.runtime.python)}, NumPy ${esc(r.runtime.numpy)}, SciPy ${esc(r.runtime.scipy)}. Cache key <code>${esc(r.key)}</code>.</p>
<h3>Tested specification space</h3>
<p>${counts.valid + counts.invalid + counts.cancelled + counts.uncomputed} specifications: ${counts.valid} valid, ${counts.invalid} invalid, ${counts.cancelled} cancelled, ${counts.uncomputed} uncomputed (limit ${run.plan.maxSpecs}).</p>
${decisions(run.plan)}
${reasons.size ? `<h3>Invalid specifications</h3><ul>${[...reasons].map(([k, v]) => `<li>${v} x ${esc(k)}</li>`).join('')}</ul>` : ''}
<h3>Results</h3>
${r.workflow === 'ranking' ? rankingSection(r) : relationshipSection(r)}
</section>`;
}

export function reportHtml(p: Project): string {
  const s = p.source;
  const d = p.dataset!;
  const runs = p.plans.map((e) => [...p.runs].reverse().find((r) => r.planId === e.id)).filter((r): r is RunRecord => !!r);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(p.title)}: Forking Paths report</title>
<style>body{background:#000;color:#fff;font:14px/1.55 ui-monospace,Menlo,monospace;max-width:1100px;margin:0 auto;padding:24px}h1,h2,h3{font-weight:600}h1{font-size:20px}h2{font-size:16px;border-top:1px solid rgba(255,255,255,.15);padding-top:16px}h3{font-size:14px}small,.note{color:rgba(255,255,255,.74)}table{border-collapse:collapse;width:100%;margin:8px 0}th,td{border-bottom:1px solid rgba(255,255,255,.12);padding:3px 6px;text-align:left;vertical-align:top}code{color:#3cdc78}a{color:#fff}</style></head><body>
<h1>${esc(p.title)}</h1>
<p><small>Forking Paths report generated ${esc(new Date().toISOString())}. Exploratory analysis of the declared specification space.</small></p>
<h2>Data and provenance</h2>
<ul><li>Source file: ${esc(s?.name ?? 'unknown')} (${s?.bytes ?? '?'} bytes), SHA-256 <code>${esc(s?.sha256 ?? 'unknown')}</code></li>
<li>Source URL: ${esc(s?.url ?? 'unknown')}; retrieved: ${esc(s?.retrievedAt ?? 'unknown')}</li>
<li>License: ${esc(s?.license ?? 'unknown')} (${s?.licenseVerified ? 'checked at the source' : 'not verified'})</li>
<li>Citation: ${esc(s?.citation ?? 'unknown')}</li>
${s?.synthetic ? '<li><strong>Synthetic data.</strong> Built to verify mechanisms; not a finding about the real world.</li>' : ''}
${s?.notes ? `<li>Notes: ${esc(s.notes)}</li>` : ''}
<li>Accepted dataset: ${d.rowIds.length} rows, ${d.columns.length} columns, dataset hash <code>${esc(d.hash)}</code></li>
${d.transforms.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
<p class="note">A hash identifies bytes; it does not prove where the data came from.</p>
${runs.map((r) => runSection(p, r)).join('\n')}
<h2>Limitations</h2>
<ul><li>Results describe only the declared specification space; other reasonable choices were not tested.</li>
<li>Top-k fractions and positive-estimate fractions are shares of evaluated specifications under the declared scheme. They are not probabilities that a ranking or an effect is true, and sampled weights do not define a confidence interval.</li>
<li>Running many specifications does not correct for multiple testing and does not establish causation.</li>
<li>Intervals are reported only where the declared sampling unit supports the method.</li></ul>
<h2>Reproduction</h2>
<p>Export the project bundle and run <code>python -m fpengine reproduce bundle.json</code> from the <code>engine</code> directory (NumPy and SciPy required), or import the bundle in Forking Paths and choose Reproduce. Statuses and ranks must match exactly; scores within 1e-9; regression estimates and intervals within 1e-8 relative.</p>
</body></html>`;
}

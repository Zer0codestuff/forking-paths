import { accept, profile, tokenize, type AcceptOptions, type ParseSettings, type ParsedTable, type Profile } from './csv';
import { base64ToBytes, bytesToBase64, datasetHash, decodeFloat32, decodeFloat64, sha256Hex } from './hash';
import { APP_VERSION, SCHEMAS, type Bundle, type Dataset, type Plan, type Project, type RankingPlan, type RankingResult, type RelationshipPlan, type Result, type RunRecord, type Source } from './types';

export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
}

const DESCRIPTIVE = new Set(['rationale', 'title']);
/** The plan without descriptive fields; mirrors fpengine.canonical.computational. */
export function computational(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(computational);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !DESCRIPTIVE.has(k)).map(([k, x]) => [k, computational(x)]));
  return v;
}

/** Results are current only while the dataset and every computational plan field are unchanged. */
export function fingerprint(plan: Plan, dsHash: string): string {
  return `${dsHash}:${stableStringify(computational(plan))}`;
}

export function newId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export function emptyProject(title = 'Untitled project'): Project {
  const now = new Date().toISOString();
  return { schema: SCHEMAS.project, id: newId('project'), title, createdAt: now, updatedAt: now, source: null, profile: null, dataset: null, plans: [], activePlan: null, runs: [], exampleId: null };
}

export async function readSource(name: string, bytes: Uint8Array, meta: Partial<Source> = {}): Promise<Source> {
  return {
    schema: SCHEMAS.source,
    name,
    bytes: bytes.length,
    sha256: await sha256Hex(bytes),
    bytesBase64: bytesToBase64(bytes),
    url: meta.url ?? null,
    retrievedAt: meta.retrievedAt ?? null,
    license: meta.license ?? null,
    licenseVerified: meta.licenseVerified ?? false,
    citation: meta.citation ?? null,
    notes: meta.notes ?? '',
    synthetic: meta.synthetic ?? false,
  };
}

export function decodeText(bytes: Uint8Array): { text: string; problem: string | null } {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), problem: null };
  } catch {
    return { text: new TextDecoder('windows-1252').decode(bytes), problem: 'The file is not valid UTF-8; it was decoded as Windows-1252. Check accented characters.' };
  }
}

export function inspect(bytes: Uint8Array, settings: ParseSettings): { table: ParsedTable; profile: Profile } {
  const { text, problem } = decodeText(bytes);
  const table = tokenize(text, settings);
  if (problem) table.problems.unshift(problem);
  return { table, profile: profile(table, settings) };
}

export async function acceptDataset(table: ParsedTable, prof: Profile, settings: ParseSettings, opts: AcceptOptions, units: Record<string, string> = {}): Promise<Dataset> {
  const a = accept(table, prof, settings, opts);
  const columns = a.columns.map((c) => ({ ...c, unit: units[c.name] ?? '' }));
  return { schema: SCHEMAS.dataset, hash: await datasetHash(columns), columns, rowIds: a.rowIds, settings, transforms: a.transforms, acceptedAt: new Date().toISOString() };
}

const NORM_RATIONALE: Record<string, string> = {
  minmax: 'Common default; preserves relative distances but is driven by the extremes.',
  zscore: 'Uses the spread of each indicator; sensitive to skew and outliers.',
  rank: 'Robust to outliers; discards the size of differences.',
  target: 'Distance to the best observed value; needs strictly positive values.',
};
const MISSING_RATIONALE: Record<string, string> = {
  exclude: 'Ranks only entities with complete data; changes the set being compared.',
  median: 'Keeps every entity; assumes a missing value is typical.',
  worst: 'Keeps every entity; penalizes missing reporting.',
};
const AGG_RATIONALE: Record<string, string> = {
  arithmetic: 'Full compensation between indicators.',
  geometric: 'Partial compensation; rewards balanced profiles.',
};

export function defaultRankingPlan(ds: Dataset, hints: { entity?: string; directions?: Record<string, 'higher' | 'lower'>; title?: string } = {}): RankingPlan {
  const entity = hints.entity ?? ds.columns.find((c) => c.kind === 'string')?.name ?? ds.columns[0].name;
  const nums = ds.columns.filter((c) => c.kind === 'number' && c.name !== entity);
  return {
    schema: SCHEMAS.plan,
    workflow: 'ranking',
    title: hints.title ?? 'Ranking robustness',
    entity,
    indicators: nums.map((c) => ({ column: c.name, direction: hints.directions?.[c.name] ?? 'higher', unit: c.unit ?? '', include: true })),
    decisions: {
      normalization: { options: ['minmax', 'zscore', 'rank'].map((id) => ({ id, rationale: NORM_RATIONALE[id] })) },
      missing: { options: ['exclude', 'median'].map((id) => ({ id, rationale: MISSING_RATIONALE[id] })) },
      aggregation: { options: ['arithmetic'].map((id) => ({ id, rationale: AGG_RATIONALE[id] })) },
      weights: {
        fixed: [{ id: 'equal', rationale: 'No indicator is privileged.', weights: Object.fromEntries(nums.map((c) => [c.name, 1])) }],
        sampling: { enabled: true, count: 64, seed: 20261028, alpha: 1, minWeight: 0, maxWeight: 1, maxAttempts: 1000, rationale: 'Uniform over the weight simplex (Dirichlet alpha = 1) to see how far the order depends on the weights.' },
      },
    },
    ties: 'min',
    constantRule: 'invalid',
    topK: 5,
    maxSpecs: 512,
  };
}

export function defaultRelationshipPlan(ds: Dataset, hints: Partial<RelationshipPlan> = {}): RelationshipPlan {
  const nums = ds.columns.filter((c) => c.kind === 'number');
  return {
    schema: SCHEMAS.plan,
    workflow: 'relationship',
    title: 'Relationship robustness',
    outcome: nums[1]?.name ?? nums[0]?.name ?? '',
    outcomeUnit: '',
    predictor: nums[0]?.name ?? '',
    predictorUnit: '',
    sampling: { unit: 'independent', rationale: 'Each row is a separate unit sampled independently.' },
    decisions: {
      filters: { options: [{ id: 'all', rationale: 'All rows with complete data.', rules: [] }] },
      covariates: { options: [{ id: 'none', rationale: 'Unadjusted association.', columns: [] }] },
      outliers: { options: [{ id: 'keep', rationale: 'No rows removed for extreme values.' }, { id: 'drop-z3', rationale: 'Removes outcome values more than 3 sd from the mean.' }] },
      outcomeTransform: { options: [{ id: 'identity', rationale: 'Effect in outcome units.' }] },
      interval: { options: [{ id: 'hc3', rationale: 'Robust to unequal variance; assumes independent rows.' }] },
    },
    confidence: 0.95,
    bootstrap: { replicates: 999, seed: 1 },
    maxSpecs: 256,
    ...hints,
  };
}

const LIMITATIONS = [
  'Results describe the declared specification space only. Other reasonable choices were not tested.',
  'Top-k fractions and positive-estimate fractions are shares of evaluated specifications under the declared sampling scheme, not probabilities that a ranking or effect is true.',
  'Running many specifications does not correct for multiple testing and does not establish causation.',
  'A hash identifies bytes; it does not prove where the data came from.',
];

export function buildBundle(p: Project): Bundle {
  if (!p.dataset) throw new Error('Accept a dataset before exporting.');
  const current = p.runs.filter((r) => isCurrent(p, r));
  return {
    schema: SCHEMAS.bundle,
    createdAt: new Date().toISOString(),
    app: { name: 'forking-paths', version: APP_VERSION },
    title: p.title,
    source: p.source,
    dataset: p.dataset,
    plans: p.plans.map((e) => e.plan),
    results: current.map((r) => portableResult(r.result)),
    reproduction: {
      cli: 'pip install numpy scipy && cd engine && python -m fpengine reproduce <bundle.json>',
      browser: 'Open Forking Paths, choose Import project, select the bundle, then Reproduce.',
      tolerance: 'Statuses and ranks must match exactly; scores within 1e-9 absolute; regression estimates and intervals within 1e-8 relative.',
    },
    limitations: LIMITATIONS,
  };
}

/** Result as stored in bundles: matrices as base64 text, never typed arrays. */
export function portableResult(r: Result): Result {
  if (r.workflow !== 'ranking' || !r.arrays.ranksData) return r;
  const { ranksData, scoresData, external: _e, ...rest } = r.arrays;
  void _e;
  const u8 = (a: ArrayBufferView) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  return { ...r, arrays: { ...rest, ranks: bytesToBase64(u8(ranksData)), scores: bytesToBase64(u8(scoresData!)) } };
}

export function rankMatrix(r: RankingResult): Float32Array {
  return r.arrays.ranksData ?? decodeFloat32(r.arrays.ranks!);
}

export function scoreMatrix(r: RankingResult): Float64Array {
  return r.arrays.scoresData ?? decodeFloat64(r.arrays.scores!);
}

export function isCurrent(p: Project, r: RunRecord): boolean {
  const entry = p.plans.find((e) => e.id === r.planId);
  return !!(entry && p.dataset && fingerprint(entry.plan, p.dataset.hash) === r.fingerprint);
}

export const BUNDLE_LIMITS = { maxBytes: 200 * 1024 * 1024, maxPlans: 50, maxResults: 50 };

/** Validate an imported bundle. Bundles are data: nothing in them is executed. */
export async function parseBundle(text: string): Promise<{ bundle: Bundle; problems: string[] }> {
  if (text.length > BUNDLE_LIMITS.maxBytes) throw new Error(`The bundle is larger than ${BUNDLE_LIMITS.maxBytes / 1048576} MB.`);
  let b: any;
  try { b = JSON.parse(text); } catch { throw new Error('The file is not valid JSON.'); }
  if (!b || typeof b !== 'object' || b.schema !== SCHEMAS.bundle) throw new Error(`Not a Forking Paths bundle: expected schema "${SCHEMAS.bundle}", found ${JSON.stringify(b?.schema)}.`);
  const problems: string[] = [];
  const need = (c: boolean, m: string) => { if (!c) problems.push(m); };
  need(b.dataset && Array.isArray(b.dataset.columns), 'dataset.columns is missing');
  need(Array.isArray(b.plans) && b.plans.length <= BUNDLE_LIMITS.maxPlans, 'plans must be a list of at most 50 plans');
  need(Array.isArray(b.results) && b.results.length <= BUNDLE_LIMITS.maxResults, 'results must be a list of at most 50 results');
  if (problems.length) throw new Error(`Invalid bundle: ${problems.join('; ')}`);
  for (const c of b.dataset.columns) {
    need(typeof c.name === 'string' && (c.kind === 'number' || c.kind === 'string') && Array.isArray(c.values), `column ${String(c?.name)} is malformed`);
    if (c.kind === 'number') need(c.values.every((v: unknown) => v === null || typeof v === 'number'), `column ${c.name} has non-numeric values`);
    if (c.kind === 'string') need(c.values.every((v: unknown) => v === null || typeof v === 'string'), `column ${c.name} has non-text values`);
  }
  for (const pl of b.plans) need(pl?.schema === SCHEMAS.plan && (pl.workflow === 'ranking' || pl.workflow === 'relationship'), 'a plan has an unknown schema or workflow');
  if (problems.length) throw new Error(`Invalid bundle: ${problems.slice(0, 5).join('; ')}`);
  const computed = await datasetHash(b.dataset.columns);
  if (computed !== b.dataset.hash) problems.push(`Dataset hash mismatch: recorded ${String(b.dataset.hash).slice(0, 12)}, computed ${computed.slice(0, 12)}. The data was changed after export.`);
  if (b.source?.bytesBase64) {
    const got = await sha256Hex(base64ToBytes(b.source.bytesBase64));
    if (got !== b.source.sha256) problems.push(`Source bytes do not match their recorded SHA-256 (${String(b.source.sha256).slice(0, 12)}).`);
  }
  return { bundle: b as Bundle, problems };
}

export function projectFromBundle(b: Bundle): Project {
  const p = emptyProject(b.title);
  p.source = b.source;
  p.dataset = b.dataset;
  p.plans = b.plans.map((plan) => ({ id: newId('plan'), plan }));
  p.activePlan = p.plans[0]?.id ?? null;
  return p;
}

export function resultPlanIndex(b: Bundle, r: Result, planHashes: string[]): number {
  return planHashes.indexOf(r.planHash);
}

export function downloadText(name: string, text: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

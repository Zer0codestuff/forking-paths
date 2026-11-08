import type { DatasetColumn, ParseSettings, Profile } from './csv';

export const SCHEMAS = {
  source: 'fp.source/1',
  dataset: 'fp.dataset/1',
  plan: 'fp.plan/1',
  result: 'fp.result/1',
  bundle: 'fp.bundle/1',
  project: 'fp.project/1',
} as const;

export const APP_VERSION = '0.1.0';

export interface Source {
  schema: typeof SCHEMAS.source;
  name: string;
  bytes: number;
  sha256: string;
  /** Original imported bytes, preserved unchanged (base64). */
  bytesBase64: string;
  url: string | null;
  retrievedAt: string | null;
  license: string | null;
  licenseVerified: boolean;
  citation: string | null;
  notes: string;
  synthetic: boolean;
}

export interface Dataset {
  schema: typeof SCHEMAS.dataset;
  hash: string;
  columns: DatasetColumn[];
  rowIds: number[];
  settings: ParseSettings;
  transforms: string[];
  acceptedAt: string;
}

export interface Option {
  id: string;
  rationale: string;
}

export interface RankingPlan {
  schema: typeof SCHEMAS.plan;
  workflow: 'ranking';
  title: string;
  entity: string;
  indicators: Array<{ column: string; direction: 'higher' | 'lower'; unit: string; include: boolean }>;
  decisions: {
    normalization: { options: Option[] };
    missing: { options: Option[] };
    aggregation: { options: Option[] };
    weights: {
      fixed: Array<{ id: string; rationale: string; weights: Record<string, number> }>;
      sampling: { enabled: boolean; count: number; seed: number; alpha: number; minWeight: number; maxWeight: number; maxAttempts: number; rationale: string };
    };
  };
  ties: 'min' | 'average';
  constantRule: 'invalid' | 'drop';
  topK: number;
  maxSpecs: number;
  limitSeed?: number;
}

export interface RelationshipPlan {
  schema: typeof SCHEMAS.plan;
  workflow: 'relationship';
  title: string;
  outcome: string;
  outcomeUnit: string;
  predictor: string;
  predictorUnit: string;
  sampling: { unit: 'independent' | 'cluster' | 'ordered'; clusterColumn?: string; rationale: string };
  decisions: {
    filters: { options: Array<Option & { rules: Array<{ column: string; op: string; value: number | string | Array<string | number> }> }> };
    covariates: { options: Array<Option & { columns: string[] }> };
    outliers: { options: Option[] };
    outcomeTransform: { options: Option[] };
    interval: { options: Option[] };
  };
  confidence: number;
  bootstrap: { replicates: number; seed: number };
  maxSpecs: number;
}

export type Plan = RankingPlan | RelationshipPlan;

export interface RankingSpec {
  index: number;
  normalization: string;
  missing: string;
  aggregation: string;
  weightsId: string;
  weightsSource: 'fixed' | 'sampled';
  weights: Record<string, number>;
  status: SpecStatus;
  reason: string | null;
  notes: string[];
  remaining: number | null;
  excludedCount: number | null;
}

export type SpecStatus = 'valid' | 'invalid' | 'cancelled' | 'uncomputed';

export interface EntitySummary {
  id: string;
  evaluated: number;
  min?: number; p05?: number; p25?: number; median?: number; p75?: number; p95?: number; max?: number; mean?: number;
  topK?: number;
  best?: number;
}

export interface Runtime { engine: string; python: string; implementation: string; numpy: string; scipy: string }

interface ResultBase {
  selection: { planned: number; computed: number; method: string };
  schema: typeof SCHEMAS.result;
  key: string;
  datasetHash: string;
  planHash: string;
  runtime: Runtime;
  createdAt: string;
  engine: string;
  algorithm: string;
}

export interface RankingResult extends ResultBase {
  workflow: 'ranking';
  entities: string[];
  indicators: string[];
  specs: RankingSpec[];
  summary: { entities: EntitySummary[]; counts: Record<SpecStatus, number>; topK: number; topKNote: string };
  digest: Record<string, string>;
  arrays: { shape: [number, number]; ranks: string; scores: string };
}

export interface RelationshipSpec {
  index: number;
  filter: string;
  covariates: string;
  outliers: string;
  transform: string;
  interval: string;
  estimand: string;
  status: SpecStatus;
  reason?: string;
  estimate?: number;
  se?: number | null;
  low?: number | null;
  high?: number | null;
  intervalNote?: string;
  n?: number;
  excludedCount?: number;
  diagnostics?: Record<string, number | null>;
}

export interface RelationshipResult extends ResultBase {
  workflow: 'relationship';
  specs: RelationshipSpec[];
  counts: Record<SpecStatus, number>;
  summary: { estimands: Array<{ estimand: string; label: string; valid: number; invalid: number; median?: number; min?: number; max?: number; positiveFraction?: number }>; note: string };
  digest: Record<string, string>;
}

export type Result = RankingResult | RelationshipResult;

export interface RunRecord {
  id: string;
  planId: string;
  /** Stable fingerprint of the plan and dataset used; results are stale when it no longer matches. */
  fingerprint: string;
  /** The exact plan and dataset hash this result was computed from. */
  plan: Plan;
  datasetHash: string;
  elapsedMs: number;
  cancelled: boolean;
  result: Result;
}

export interface PlanEntry {
  id: string;
  plan: Plan;
}

export interface Project {
  schema: typeof SCHEMAS.project;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  source: Source | null;
  profile: Profile | null;
  dataset: Dataset | null;
  plans: PlanEntry[];
  activePlan: string | null;
  runs: RunRecord[];
  exampleId: string | null;
}

export interface Bundle {
  schema: typeof SCHEMAS.bundle;
  createdAt: string;
  app: { name: 'forking-paths'; version: string };
  title: string;
  source: Source | null;
  dataset: Dataset;
  plans: Plan[];
  results: Result[];
  reproduction: { cli: string; browser: string; tolerance: string };
  limitations: string[];
}

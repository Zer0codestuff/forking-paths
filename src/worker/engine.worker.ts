/// <reference lib="webworker" />
// Hosts the Python engine (engine/fpengine) in Pyodide. Loaded only when computation is requested.
// The same Python files run under CPython in the CLI, so there is one implementation of every method.
import type { WorkerRequest, WorkerResponse } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

const engineFiles = import.meta.glob('../../engine/fpengine/*.py', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

type Py = { runPython: (code: string) => any; loadPackage: (names: string[], opts?: any) => Promise<void>; FS: any; globals: any; version: string };
let py: Py | null = null;
let api: any = null;
let loading: Promise<void> | null = null;
const cancelled = new Set<number>();

const post = (m: WorkerResponse) => self.postMessage(m);

async function load(base: string, reqId: number): Promise<void> {
  if (api) return;
  if (loading) return loading;
  loading = (async () => {
    const stages = ['Python runtime', 'NumPy', 'SciPy', 'Forking Paths engine'];
    const stage = (i: number, detail?: string) => post({ type: 'loading', id: reqId, stage: stages[i], done: i, total: stages.length, detail });
    const t0 = performance.now();
    stage(0);
    const url = new URL('pyodide/', base).href;
    const mod = await import(/* @vite-ignore */ `${url}pyodide.mjs`);
    py = (await mod.loadPyodide({ indexURL: url, stdout: () => {}, stderr: () => {} })) as Py;
    stage(1, `Pyodide ${py.version}`);
    await py.loadPackage(['numpy'], { messageCallback: () => {} });
    stage(2);
    await py.loadPackage(['scipy'], { messageCallback: () => {} });
    stage(3);
    py.FS.mkdirTree('/home/pyodide/fpengine');
    for (const [path, text] of Object.entries(engineFiles)) py.FS.writeFile(`/home/pyodide/fpengine/${path.split('/').pop()}`, text);
    py.runPython('import sys, json\nsys.path.insert(0, "/home/pyodide")\nimport fpengine.api');
    api = (py as any).pyimport('fpengine.api');
    post({ type: 'loading', id: reqId, stage: 'ready', done: stages.length, total: stages.length, detail: `${(performance.now() - t0).toFixed(0)} ms` });
  })();
  try {
    await loading;
  } catch (e) {
    loading = null;
    py = null;
    throw e;
  }
}

const yieldToEvents = () => new Promise<void>((r) => setTimeout(r, 0));

async function handle(m: WorkerRequest): Promise<void> {
  switch (m.type) {
    case 'cancel':
      cancelled.add(m.target);
      return;
    case 'load':
      await load(m.base, m.id);
      post({ type: 'result', id: m.id, value: JSON.parse(api.info()) });
      return;
    case 'call': {
      await load(m.base, m.id);
      if (!/^[a-z_]+$/.test(m.fn) || typeof api[m.fn] !== 'function') throw new Error(`Unknown engine function ${m.fn}`);
      // Arguments cross as one JSON string so Python receives plain lists and dicts, not proxies.
      py!.globals.set('_fp_args', JSON.stringify(m.args));
      const out = py!.runPython(`fpengine.api.${m.fn}(*json.loads(_fp_args))`);
      post({ type: 'result', id: m.id, value: typeof out === 'string' ? JSON.parse(out) : out });
      return;
    }
    case 'run': {
      await load(m.base, m.id);
      const t0 = performance.now();
      const started = JSON.parse(api.start(m.dataset, m.plan));
      post({ type: 'progress', id: m.id, done: 0, limit: started.limit, planned: started.planned, key: started.key });
      let finished = false;
      let wasCancelled = false;
      while (!finished) {
        await yieldToEvents(); // lets a cancel message arrive between batches
        if (cancelled.has(m.id)) {
          wasCancelled = true;
          break;
        }
        const p = JSON.parse(api.run_batch(started.key, m.batch));
        finished = p.finished;
        post({ type: 'progress', id: m.id, done: p.done, limit: p.limit, planned: started.planned, key: started.key });
      }
      cancelled.delete(m.id);
      const record = JSON.parse(api.finish(started.key, wasCancelled, new Date().toISOString()));
      post({ type: 'result', id: m.id, value: { record, cancelled: wasCancelled, elapsedMs: performance.now() - t0 } });
      return;
    }
  }
}

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const m = ev.data;
  handle(m).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    post({ type: 'error', id: 'id' in m ? m.id : -1, message: message.includes('PythonError') || message.includes('Traceback') ? message.split('\n').filter(Boolean).slice(-1)[0] : message });
  });
};

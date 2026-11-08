import type { WorkerRequest, WorkerResponse } from './protocol';

export interface LoadState {
  stage: string;
  done: number;
  total: number;
  detail?: string;
}

export interface RunProgress {
  done: number;
  limit: number;
  planned: number;
  key: string;
}

export class EngineError extends Error {}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; onProgress?: (p: RunProgress) => void };

/** Main-thread client for the Pyodide worker. The worker is created on first use. */
export class Engine {
  private worker: Worker | null = null;
  private next = 1;
  private pending = new Map<number, Pending>();
  private base = new URL(import.meta.env.BASE_URL, location.href).href;
  onLoading: (s: LoadState) => void = () => {};
  ready = false;

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const m = ev.data;
      if (m.type === 'loading') {
        if (m.stage === 'ready') this.ready = true;
        this.onLoading({ stage: m.stage, done: m.done, total: m.total, detail: m.detail });
        return;
      }
      const p = this.pending.get(m.id);
      if (!p) return;
      if (m.type === 'progress') p.onProgress?.(m);
      else if (m.type === 'result') { this.pending.delete(m.id); p.resolve(m.value); }
      else if (m.type === 'error') { this.pending.delete(m.id); p.reject(new EngineError(m.message)); }
    };
    w.onerror = (ev) => {
      const err = new EngineError(`The computation worker failed to start: ${ev.message || 'unknown error'}. Check that the Python runtime was prepared with "npm run setup:runtime".`);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this.worker = null;
    };
    this.worker = w;
    return w;
  }

  private send<T>(req: Omit<WorkerRequest, 'id' | 'base'> & Record<string, unknown>, onProgress?: (p: RunProgress) => void): { id: number; promise: Promise<T> } {
    const id = this.next++;
    const promise = new Promise<T>((resolve, reject) => this.pending.set(id, { resolve, reject, onProgress }));
    this.ensure().postMessage({ ...req, id, base: this.base } as WorkerRequest);
    return { id, promise };
  }

  load() {
    return this.send<any>({ type: 'load' }).promise;
  }

  call<T = any>(fn: string, ...args: unknown[]): Promise<T> {
    return this.send<T>({ type: 'call', fn, args }).promise;
  }

  run(dataset: unknown, plan: unknown, onProgress: (p: RunProgress) => void, batch = 16) {
    return this.send<{ record: any; cancelled: boolean; elapsedMs: number }>({ type: 'run', dataset: JSON.stringify(dataset), plan: JSON.stringify(plan), batch }, onProgress);
  }

  cancel(id: number) {
    this.worker?.postMessage({ type: 'cancel', target: id } satisfies WorkerRequest);
  }
}

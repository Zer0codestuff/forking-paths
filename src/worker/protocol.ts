export type WorkerRequest =
  | { type: 'load'; id: number; base: string }
  | { type: 'call'; id: number; base: string; fn: string; args: unknown[] }
  | { type: 'run'; id: number; base: string; dataset: string; plan: string; batch: number }
  | { type: 'cancel'; target: number };

export type WorkerResponse =
  | { type: 'loading'; id: number; stage: string; done: number; total: number; detail?: string }
  | { type: 'progress'; id: number; done: number; limit: number; planned: number; key: string }
  | { type: 'result'; id: number; value: any }
  | { type: 'error'; id: number; message: string };

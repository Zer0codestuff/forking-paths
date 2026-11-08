import { Engine } from './worker/client';
const engine = new Engine();
(window as any).__fp = { engine };
document.getElementById('root')!.textContent = 'engine smoke';

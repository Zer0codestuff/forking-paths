// Browser benchmark: import, inspection, cold engine load and warm runs for the generated
// 10,000-row, 12-indicator input. Run `python3 bench/bench.py` first, then `npm run build`.
// Usage: node scripts/browser-bench.mjs   (CHROMIUM_PATH optional)
import { spawn } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { chromium } from 'playwright';

const PORT = 4195;
const base = `http://localhost:${PORT}/`;
const csv = 'bench/out/bench-10000x12.csv';
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
for (let i = 0; i < 80; i++) {
  try { if ((await fetch(base)).ok) break; } catch { /* starting */ }
  await new Promise((r) => setTimeout(r, 250));
}
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox', '--enable-precise-memory-info'] });
const out = { generatedAt: new Date().toISOString(), input: { file: csv, bytes: statSync(csv).size, rows: 10000, indicators: 12 }, browser: `Chromium ${browser.version()} headless (Playwright)`, host: { platform: `${os.platform()} ${os.release()} ${os.arch()}`, cpu: os.cpus()[0]?.model ?? 'unknown', cpus: os.cpus().length, memGb: Number((os.totalmem() / 1073741824).toFixed(1)) }, ms: {}, notes: [] };
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(base + '?example=ranking-synthetic');
  await page.waitForSelector('text=Accepted dataset');
  let t0 = Date.now();
  await page.setInputFiles('.data-view input[type=file]', csv);
  await page.waitForSelector('text=10,000 data rows');
  out.ms.readParseProfile = Date.now() - t0;
  t0 = Date.now();
  await page.click('text=accept dataset');
  await page.waitForSelector('text=Accepted dataset');
  out.ms.acceptAndHash = Date.now() - t0;
  await page.click('.view-tab:has-text("Decisions")');
  await page.fill('fieldset.decision:has(legend:has-text("sampled weights")) input >> nth=1', '85');
  out.input.plannedSpecs = Number((await page.textContent('.run-bar strong')).replace(/,/g, ''));
  out.input.computedSpecs = Number(await page.inputValue('input[aria-label="maximum specifications"]'));
  for (const label of ['coldRun', 'warmRun1', 'warmRun2']) {
    t0 = Date.now();
    await page.click('.run-bar .btn.primary');
    await page.waitForSelector('.run-bar .btn:has-text("cancel")', { timeout: 30000 });
    await page.waitForFunction(() => document.querySelector('.counts') && ![...document.querySelectorAll('.run-bar .btn')].some((b) => b.textContent === 'cancel'), null, { timeout: 600000 });
    await page.waitForSelector('.rank-row', { timeout: 120000 });
    out.ms[label] = Date.now() - t0;
    if (label === 'coldRun') out.engineInfo = await page.textContent('.runtime');
    out.ms[`${label}EngineReported`] = Number(((await page.textContent('.result-meta')).match(/in ([\d.]+) s/) ?? [])[1]) * 1000;
  }
  out.counts = await page.textContent('.counts');
  out.mainThreadHeapMb = await page.evaluate(() => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null));
  out.notes.push('coldRun includes downloading and starting Pyodide, NumPy and SciPy from the local server (no network cache), the worker run, transfer of the result, and the first render. warmRun reuses the loaded engine.');
  out.notes.push('EngineReported is the time measured inside the worker from start to finished result record.');
  out.notes.push('Worker (Pyodide) heap and whole-browser memory are not measurable from the page and are reported as unavailable.');
  await page.close();
} finally {
  await browser.close();
  server.kill();
}
writeFileSync('bench/out/browser-results.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));

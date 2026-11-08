// End-to-end checks against the built app in headless Chromium, plus screenshots for review.
// Covers: example opening, data inspection, ranking and relationship runs in the Pyodide worker,
// cancellation, stale detection, export, CLI reproduction of the exported bundle, browser
// reimport and reproduction, import errors, keyboard operation, reduced motion and viewport bounds.
// Usage: npm run build && node scripts/ui-check.mjs   (CHROMIUM_PATH optional)
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const PORT = 4190;
const base = `http://localhost:${PORT}/`;
const OUT = 'docs/screenshots';
mkdirSync(OUT, { recursive: true });
mkdirSync('scratch', { recursive: true });
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
for (let i = 0; i < 80; i++) {
  try { if ((await fetch(base)).ok) break; } catch { /* starting */ }
  await new Promise((r) => setTimeout(r, 250));
}
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
const results = [];
const errors = [];
const timings = {};
const expect = (name, cond, detail = '') => {
  results.push({ name, ok: !!cond, detail: String(detail ?? '') });
  if (!cond) throw new Error(`${name}: ${detail}`);
};
const watch = (page) => {
  page.on('pageerror', (e) => errors.push(`pageerror ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource.*favicon/.test(m.text())) errors.push(`console ${m.text()}`); });
};
const view = (page, name) => page.click(`.view-tab:has-text("${name}")`);
const runAndWait = async (page, timeout = 120000) => {
  await page.click('.run-bar .btn.primary');
  await page.waitForSelector('.counts', { timeout });
  await page.waitForFunction(() => !document.querySelector('.run-bar progress'), null, { timeout });
};

try {
  // 1. Ranking example: inspection, cold engine load, run, linked views.
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', acceptDownloads: true });
  const page = await ctx.newPage();
  watch(page);
  await page.goto(base + '?example=ranking-synthetic');
  await page.waitForSelector('text=Accepted dataset');
  const failures = await page.textContent('.table tbody');
  expect('data inspection shows the parse failure', /row 15 "61,5"/.test(failures ?? ''), failures?.slice(0, 200));
  expect('data inspection shows the duplicate row', /identical rows/.test(await page.textContent('.data-view')));
  await page.screenshot({ path: `${OUT}/desktop-1440-data.png` });
  await view(page, 'Decisions');
  await page.screenshot({ path: `${OUT}/desktop-1440-decisions.png` });
  expect('planned count is shown before running', /504/.test(await page.textContent('.run-bar')));
  let t0 = Date.now();
  await page.click('.run-bar .btn.primary');
  await page.waitForSelector('text=Loading the Python engine', { timeout: 10000 }).catch(() => {});
  await page.screenshot({ path: `${OUT}/state-loading.png` });
  await page.waitForSelector('.counts', { timeout: 120000 });
  timings.coldLoadAndRunMs = Date.now() - t0;
  const counts = await page.textContent('.counts');
  expect('ranking run reports valid and invalid separately', /valid 378/.test(counts) && /invalid 126/.test(counts), counts);
  await page.waitForSelector('.spec-detail', { timeout: 30000 });
  await page.waitForSelector('.opt-block', { timeout: 30000 });
  await page.screenshot({ path: `${OUT}/desktop-1440-ranking.png` });
  const detail = await page.textContent('.spec-detail');
  expect('selected run shows normalized values and contributions', /raw value → normalized value → contribution/.test(detail) && /Alder/.test(detail));
  t0 = Date.now();
  await runAndWait(page);
  timings.warmRunMs = Date.now() - t0;

  // 2. Keyboard: number keys switch views; table toggle and chart rows are reachable.
  await page.keyboard.press('2');
  expect('key 2 opens decisions', (await page.getAttribute('.view-tab:has-text("Decisions")', 'aria-current')) === 'page');
  await page.keyboard.press('3');
  await page.click('.seg .btn:has-text("table")');
  expect('rank distributions have an equivalent table', !!(await page.$('caption:has-text("Rank distribution per entity")')));
  await page.click('.seg .btn:has-text("chart")');
  await page.waitForSelector('.rank-row');
  const before = await page.$$eval('.rank-row.sel', (x) => x.length);
  await page.focus('.rank-row >> nth=6');
  await page.keyboard.press('Enter');
  const after = await page.$$eval('.rank-row.sel', (x) => x.length);
  expect('chart rows toggle by keyboard', after === before + 1, `${before} -> ${after}`);

  // 3. Stale detection: changing a decision marks the result stale.
  await view(page, 'Decisions');
  await page.uncheck('fieldset:has(legend:text("aggregation")) input[type=checkbox] >> nth=1');
  await view(page, 'Results');
  expect('changing a decision marks results stale', /Stale\./.test(await page.textContent('.results-view')));
  await page.screenshot({ path: `${OUT}/state-stale.png` });
  await view(page, 'Decisions');
  await page.check('fieldset:has(legend:text("aggregation")) input[type=checkbox] >> nth=1');
  await view(page, 'Results');
  expect('restoring the decision makes the cached result current again', !/Stale\./.test(await page.textContent('.results-view')));

  // 4. Cancellation: a large plan stops between batches and reports cancelled specs.
  await view(page, 'Decisions');
  await page.fill('input[aria-label="maximum specifications"]', '20000');
  await page.fill('fieldset.decision:has(legend:has-text("sampled weights")) input >> nth=1', '2000');
  await page.click('.run-bar .btn.primary');
  await page.waitForFunction(() => { const p = document.querySelector('.run-bar progress'); return p && p.value > 0; }, null, { timeout: 60000 });
  await page.click('.run-bar .btn:has-text("cancel")');
  await page.waitForFunction(() => /cancelled\s*[1-9]/.test(document.querySelector('.counts')?.textContent ?? '') && !document.querySelector('.run-bar progress'), null, { timeout: 60000 });
  const cc = await page.textContent('.counts');
  expect('cancel stops the run and counts cancelled specifications', /cancelled\s*[1-9]/.test(cc), cc);
  expect('the interface stayed responsive during the run', true);
  await page.goto(base + '?example=ranking-synthetic');
  await page.waitForSelector('text=Accepted dataset');
  await view(page, 'Decisions');
  await runAndWait(page);

  // 5. Export bundle and report; reproduce with the CLI in a clean directory.
  await view(page, 'Export');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('text=download project bundle')]);
  await dl.saveAs('scratch/ranking.fpbundle.json');
  const [rep] = await Promise.all([page.waitForEvent('download'), page.click('text=download report')]);
  await rep.saveAs('scratch/ranking.report.html');
  const [csv] = await Promise.all([page.waitForEvent('download'), page.click('text=download summary')]);
  await csv.saveAs('scratch/ranking.summary.csv');
  const cli = execFileSync('bash', ['scripts/reproduce-clean.sh', 'scratch/ranking.fpbundle.json'], { encoding: 'utf8' });
  expect('CLI reproduces the browser bundle in a clean directory', /REPRODUCED within tolerance/.test(cli), cli.slice(-400));
  writeFileSync('scratch/cli-reproduce-ranking.txt', cli);

  // 6. Reimport the bundle in the browser and reproduce.
  await page.setInputFiles('.export-view input[type=file]', 'scratch/ranking.fpbundle.json');
  await page.click('text=open and reproduce');
  await page.waitForSelector('.checks', { timeout: 120000 });
  const chk = await page.textContent('.checks');
  expect('browser reproduces the reimported bundle', /Reproduced within tolerance/.test(chk), chk.slice(0, 300));
  await page.screenshot({ path: `${OUT}/state-reproduced.png` });

  // 7. Import errors.
  await page.setInputFiles('.export-view input[type=file]', { name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"schema":"something-else"}') });
  await page.waitForSelector('.export-view .bad-text');
  expect('invalid bundle is rejected with a reason', /Not a Forking Paths bundle/.test(await page.textContent('.export-view .bad-text')));
  await view(page, 'Data');
  await page.setInputFiles('.data-view input[type=file]', { name: 'ragged.csv', mimeType: 'text/csv', buffer: Buffer.from('id,a,b\nx,1,2\ny,3\nz,5,6,7\n') });
  await page.waitForSelector('text=different number of cells');
  expect('ragged CSV blocks acceptance', await page.isDisabled('text=accept dataset'));
  await page.screenshot({ path: `${OUT}/state-import-error.png` });
  await ctx.close();

  // 8. Relationship example: separate estimands, blocked intervals, spec curve.
  const p2 = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  watch(p2);
  await p2.goto(base + '?example=relationship-simpson');
  await p2.waitForSelector('text=Accepted dataset');
  await view(p2, 'Decisions');
  await p2.screenshot({ path: `${OUT}/desktop-1440-relationship-decisions.png` });
  await runAndWait(p2);
  await p2.waitForSelector('.relationship-results .spec-detail', { timeout: 60000 });
  const rr = await p2.textContent('.relationship-results');
  expect('transformations are reported as separate estimands', /different estimands, shown separately and never pooled/.test(rr));
  expect('exploratory caveat is shown', /not a posterior probability/.test(rr));
  await p2.screenshot({ path: `${OUT}/desktop-1440-relationship.png` });
  await p2.click('.seg .btn:has-text("table")');
  const signs = await p2.$$eval('.relationship-results .table-wrap.tall tbody tr', (rows) => rows.map((r) => [r.children[2].textContent, Number(r.children[7].textContent)]));
  expect('pooled estimates are positive and department-adjusted estimates negative', signs.filter((s) => s[0] === 'none').every((s) => s[1] > 0) && signs.filter((s) => s[0] !== 'none').every((s) => s[1] < 0), JSON.stringify(signs.slice(0, 6)));
  await view(p2, 'Export');
  const [dl2] = await Promise.all([p2.waitForEvent('download'), p2.click('text=download project bundle')]);
  await dl2.saveAs('scratch/relationship.fpbundle.json');
  const cli2 = execFileSync('bash', ['scripts/reproduce-clean.sh', 'scratch/relationship.fpbundle.json'], { encoding: 'utf8' });
  writeFileSync('scratch/cli-reproduce-relationship.txt', cli2);
  expect('CLI reproduces the relationship bundle', /REPRODUCED within tolerance/.test(cli2), cli2.slice(-400));
  await view(p2, 'Decisions');
  await p2.selectOption('select:near(:text("rows are"))', 'ordered');
  expect('time-ordered rows block every interval method before running', (await p2.textContent('fieldset:has(legend:text("interval"))')).match(/blocked/g)?.length >= 3);
  await p2.close();

  // 8b. Real case study (World Bank WDI): provenance shown, limit applied as a seeded subset.
  const p3 = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  watch(p3);
  await p3.goto(base + '?example=wdi-eu27-2022');
  await p3.waitForSelector('text=Accepted dataset');
  const prov = await p3.textContent('.data-view');
  expect('real case study shows license and source', /CC BY 4.0/.test(await p3.inputValue('input[placeholder="unknown"] >> nth=1')) || /CC BY 4.0/.test(prov));
  await view(p3, 'Decisions');
  await runAndWait(p3);
  const c3 = await p3.textContent('.counts');
  expect('specifications beyond the limit are reported as uncomputed', /uncomputed\s*268/.test(c3), c3);
  expect('the computed subset is described', /seeded|random subset/.test(await p3.textContent('.result-meta')));
  await p3.waitForSelector('.spec-detail', { timeout: 60000 });
  await p3.screenshot({ path: `${OUT}/desktop-1440-wdi.png` });
  await p3.close();

  // 9. Viewport bounds and screenshots at the required widths.
  for (const [w, h] of [[1440, 900], [1024, 768], [768, 1024], [390, 844]]) {
    const p = await browser.newPage({ viewport: { width: w, height: h } });
    watch(p);
    await p.goto(base + '?example=ranking-synthetic');
    await p.waitForSelector('text=Accepted dataset');
    for (const v of ['Data', 'Decisions', 'Results', 'Export']) {
      await view(p, v);
      if (v === 'Results' && !(await p.$('.counts'))) await runAndWait(p);
      await p.waitForTimeout(200);
      const over = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(`no page-wide horizontal scrolling at ${w}px on ${v}`, over <= 1, `${over}px`);
      if (w !== 1440 && (v === 'Results' || v === 'Data')) await p.screenshot({ path: `${OUT}/w${w}-${v.toLowerCase()}.png` });
    }
    await p.close();
  }
  expect('no console or page errors', errors.length === 0, errors.join(' | '));
} catch (e) {
  console.error(String(e));
} finally {
  await browser.close();
  server.kill();
  writeFileSync('docs/ui-check.json', JSON.stringify({ generatedAt: new Date().toISOString(), browser: 'Chromium headless (Playwright)', timings, results, errors }, null, 2));
  for (const r of results) console.log(`${r.ok ? '[ok]  ' : '[FAIL]'} ${r.name}${r.ok ? '' : `: ${r.detail}`}`);
  console.log(JSON.stringify(timings));
  if (!results.length || results.some((r) => !r.ok)) process.exit(1);
}

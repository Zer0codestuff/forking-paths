// Prepare the local Python runtime used by the browser worker.
// Copies the Pyodide core from node_modules and downloads the pinned NumPy and SciPy wheels
// listed in the core's pyodide-lock.json, verifying each file's SHA-256 against that lock file.
// Output: public/pyodide/ (git-ignored). Run once after `npm install`; the app then works offline.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PACKAGES = ['numpy', 'scipy'];
const src = 'node_modules/pyodide';
const out = 'public/pyodide';
const pkg = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(join(src, 'pyodide-lock.json'), 'utf8'));
const cdn = process.env.PYODIDE_PACKAGE_BASE_URL ?? `https://cdn.jsdelivr.net/pyodide/v${pkg.version}/full/`;

mkdirSync(out, { recursive: true });
for (const f of ['pyodide.mjs', 'pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json']) copyFileSync(join(src, f), join(out, f));

const need = new Set();
const visit = (name) => {
  if (need.has(name)) return;
  const p = lock.packages[name];
  if (!p) throw new Error(`Package ${name} is not in pyodide-lock.json`);
  need.add(name);
  for (const d of p.depends ?? []) visit(d);
};
PACKAGES.forEach(visit);

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
let bytes = 0;
for (const name of need) {
  const p = lock.packages[name];
  const target = join(out, p.file_name);
  if (existsSync(target) && sha256(readFileSync(target)) === p.sha256) {
    bytes += readFileSync(target).length;
    console.log(`ok      ${p.file_name}`);
    continue;
  }
  const res = await fetch(cdn + p.file_name);
  if (!res.ok) throw new Error(`Download failed for ${p.file_name}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (got !== p.sha256) throw new Error(`SHA-256 mismatch for ${p.file_name}: expected ${p.sha256}, got ${got}`);
  writeFileSync(target, buf);
  bytes += buf.length;
  console.log(`fetched ${p.file_name} (${(buf.length / 1048576).toFixed(1)} MB)`);
}
const manifest = { pyodide: pkg.version, python: lock.info.python, packages: Object.fromEntries([...need].map((n) => [n, lock.packages[n].version])), source: cdn, preparedAt: new Date().toISOString() };
writeFileSync(join(out, 'runtime-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`runtime ready in ${out}: Pyodide ${pkg.version}, Python ${lock.info.python}, ${[...need].map((n) => `${n} ${lock.packages[n].version}`).join(', ')}; ${(bytes / 1048576).toFixed(1)} MB of packages`);

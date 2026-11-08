// CSV import and inspection. Parsing happens once, here; the accepted table is stored in the
// project as typed columns and the numerical engine only ever sees that table.

export interface ParseSettings {
  delimiter: ',' | ';' | '\t' | 'auto';
  decimal: '.' | ',';
  header: true;
  missingTokens: string[];
  /** Column type overrides chosen during inspection. */
  types: Record<string, 'number' | 'string'>;
}

export const DEFAULT_SETTINGS: ParseSettings = { delimiter: 'auto', decimal: '.', header: true, missingTokens: ['', 'NA', 'N/A', 'n/a', 'NaN', 'null', '-'], types: {} };

export interface ParseFailure {
  row: number; // 1-based data row (header excluded)
  raw: string;
}

export interface ColumnProfile {
  name: string;
  inferred: 'number' | 'string';
  type: 'number' | 'string';
  missing: number;
  failures: ParseFailure[];
  distinct: number;
  min?: number;
  max?: number;
  mean?: number;
  examples: string[];
  constant: boolean;
}

export interface ParsedTable {
  delimiter: string;
  header: string[];
  rows: string[][];
  problems: string[];
}

export interface Profile {
  rows: number;
  columns: ColumnProfile[];
  duplicateRows: number[][]; // groups of 1-based row numbers that are exact duplicates
  ragged: Array<{ row: number; cells: number }>;
  problems: string[];
}

export const LIMITS = { maxBytes: 50 * 1024 * 1024, maxRows: 500_000, maxColumns: 500 };

function detectDelimiter(text: string): ',' | ';' | '\t' {
  const firstLines = text.split(/\r?\n/, 5).join('\n');
  const counts = { ',': 0, ';': 0, '\t': 0 } as Record<string, number>;
  let q = false;
  for (const ch of firstLines) {
    if (ch === '"') q = !q;
    else if (!q && ch in counts) counts[ch]++;
  }
  return (Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] as ',' | ';' | '\t') ?? ',';
}

/** RFC 4180 tokenizer: quoted fields, doubled quotes, CRLF or LF line endings. */
export function tokenize(text: string, settings: Pick<ParseSettings, 'delimiter'>): ParsedTable {
  const problems: string[] = [];
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const delimiter = settings.delimiter === 'auto' ? detectDelimiter(text) : settings.delimiter;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"' && field === '') { quoted = true; i++; continue; }
    if (ch === delimiter) { row.push(field); field = ''; i++; continue; }
    if (ch === '\n' || ch === '\r') {
      row.push(field); field = '';
      rows.push(row); row = [];
      if (ch === '\r' && text[i + 1] === '\n') i++;
      i++;
      continue;
    }
    field += ch; i++;
  }
  if (quoted) problems.push('The file ends inside a quoted field; the last row may be incomplete.');
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  while (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') rows.pop();
  if (!rows.length) return { delimiter, header: [], rows: [], problems: ['The file is empty.'] };
  const header = rows[0].map((h) => h.trim());
  return { delimiter, header, rows: rows.slice(1), problems };
}

export function parseNumber(raw: string, decimal: '.' | ','): number | null {
  let s = raw.trim();
  if (decimal === ',') {
    if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '');
    s = s.replace(',', '.');
  }
  if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

export function profile(table: ParsedTable, settings: ParseSettings): Profile {
  const problems = [...table.problems];
  const ncol = table.header.length;
  if (ncol > LIMITS.maxColumns) problems.push(`${ncol} columns exceed the limit of ${LIMITS.maxColumns}.`);
  if (table.rows.length > LIMITS.maxRows) problems.push(`${table.rows.length} rows exceed the limit of ${LIMITS.maxRows}.`);
  const seen = new Map<string, number>();
  table.header.forEach((h, j) => {
    if (!h) problems.push(`Column ${j + 1} has an empty name.`);
    if (seen.has(h)) problems.push(`Column name "${h}" appears more than once.`);
    seen.set(h, j);
  });
  const ragged: Profile['ragged'] = [];
  table.rows.forEach((r, i) => { if (r.length !== ncol) ragged.push({ row: i + 1, cells: r.length }); });
  const missingSet = new Set(settings.missingTokens);
  const columns: ColumnProfile[] = table.header.map((name, j) => {
    let missing = 0;
    const failures: ParseFailure[] = [];
    const distinct = new Set<string>();
    let parsed = 0, nonMissing = 0, sum = 0, min = Infinity, max = -Infinity;
    const examples: string[] = [];
    table.rows.forEach((r, i) => {
      const raw = r[j] ?? '';
      if (missingSet.has(raw.trim())) { missing++; return; }
      nonMissing++;
      distinct.add(raw);
      if (examples.length < 3 && !examples.includes(raw)) examples.push(raw);
      const v = parseNumber(raw, settings.decimal);
      if (v === null) failures.push({ row: i + 1, raw });
      else { parsed++; sum += v; if (v < min) min = v; if (v > max) max = v; }
    });
    const inferred: 'number' | 'string' = parsed > 0 && parsed / nonMissing >= 0.5 ? 'number' : 'string';
    const type = settings.types[name] ?? inferred;
    return {
      name, inferred, type, missing,
      failures: type === 'number' ? failures : [],
      distinct: distinct.size,
      ...(type === 'number' && parsed ? { min, max, mean: sum / parsed } : {}),
      examples,
      constant: distinct.size <= 1,
    };
  });
  const groups = new Map<string, number[]>();
  table.rows.forEach((r, i) => {
    const k = JSON.stringify(r);
    groups.set(k, [...(groups.get(k) ?? []), i + 1]);
  });
  const duplicateRows = [...groups.values()].filter((g) => g.length > 1);
  return { rows: table.rows.length, columns, duplicateRows, ragged, problems };
}

export interface DatasetColumn {
  name: string;
  kind: 'number' | 'string';
  unit?: string;
  values: Array<number | string | null>;
}

export interface AcceptOptions {
  dropDuplicateRows: boolean;
}

export interface AcceptedTable {
  columns: DatasetColumn[];
  rowIds: number[]; // 1-based source data row of each accepted row
  transforms: string[];
}

/** Apply the inspected settings. Parse failures in numeric columns become missing values and are listed. */
export function accept(table: ParsedTable, prof: Profile, settings: ParseSettings, opts: AcceptOptions): AcceptedTable {
  const transforms: string[] = [];
  let rowIdx = table.rows.map((_, i) => i);
  if (opts.dropDuplicateRows && prof.duplicateRows.length) {
    const drop = new Set(prof.duplicateRows.flatMap((g) => g.slice(1).map((r) => r - 1)));
    rowIdx = rowIdx.filter((i) => !drop.has(i));
    transforms.push(`Dropped ${drop.size} exact duplicate row(s): ${[...drop].map((i) => i + 1).join(', ')} (first occurrence kept)`);
  }
  const missingSet = new Set(settings.missingTokens);
  const columns = prof.columns.map((c, j): DatasetColumn => {
    const values = rowIdx.map((i) => {
      const raw = table.rows[i][j] ?? '';
      if (missingSet.has(raw.trim())) return null;
      if (c.type === 'number') return parseNumber(raw, settings.decimal);
      return raw;
    });
    const fails = c.type === 'number' ? c.failures.filter((f) => rowIdx.includes(f.row - 1)) : [];
    if (fails.length) transforms.push(`${c.name}: ${fails.length} value(s) could not be parsed as numbers and are treated as missing (rows ${fails.map((f) => `${f.row} "${f.raw}"`).join(', ')})`);
    return { name: c.name, kind: c.type, values };
  });
  return { columns, rowIds: rowIdx.map((i) => i + 1), transforms };
}

/** Prevent spreadsheet formula injection when exporting text to CSV. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s)) s = `'${s}`;
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return [header.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\n') + '\n';
}

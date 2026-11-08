import { describe, expect, it } from 'vitest';
import { accept, csvCell, parseNumber, profile, tokenize, DEFAULT_SETTINGS } from './csv';
import { datasetHash, sha256Hex } from './hash';

describe('dataset hash', () => {
  it('matches the golden value asserted by the Python engine tests', async () => {
    const cols = [
      { name: 'id', kind: 'string' as const, values: ['a', 'b', null, 'é'] },
      { name: 'v', kind: 'number' as const, values: [1.5, null, -0, 1e21] },
    ];
    expect(await datasetHash(cols)).toBe('e2f14ab9901e440291bd360e5e9040da31c2a9eeb39f48ce3c3d0d15049ae86f');
  });
  it('hashes bytes', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('csv import', () => {
  const text = 'id;value;note\r\n"a; quoted";1,5;x\nb;2.000,25;"say ""hi"""\nc;n/a;\nb;2.000,25;"say ""hi"""\nd;oops;=cmd()\n';
  it('tokenizes quotes, delimiters and line endings', () => {
    const t = tokenize(text, { delimiter: 'auto' });
    expect(t.delimiter).toBe(';');
    expect(t.header).toEqual(['id', 'value', 'note']);
    expect(t.rows[0]).toEqual(['a; quoted', '1,5', 'x']);
    expect(t.rows[1][2]).toBe('say "hi"');
  });
  it('profiles types, missing values, parse failures and duplicates', () => {
    const t = tokenize(text, { delimiter: 'auto' });
    const p = profile(t, { ...DEFAULT_SETTINGS, decimal: ',' });
    const v = p.columns[1];
    expect(v.type).toBe('number');
    expect(v.missing).toBe(1);
    expect(v.failures).toEqual([{ row: 5, raw: 'oops' }]);
    expect(p.duplicateRows).toEqual([[2, 4]]);
    const a = accept(t, p, { ...DEFAULT_SETTINGS, decimal: ',' }, { dropDuplicateRows: true });
    expect(a.columns[1].values).toEqual([1.5, 2000.25, null, null]);
    expect(a.rowIds).toEqual([1, 2, 3, 5]);
    expect(a.transforms.join(' ')).toMatch(/Dropped 1 exact duplicate/);
  });
  it('parses numbers strictly', () => {
    expect(parseNumber('61,5', '.')).toBeNull();
    expect(parseNumber('1e3', '.')).toBe(1000);
    expect(parseNumber('Infinity', '.')).toBeNull();
  });
  it('neutralizes spreadsheet formulas in CSV exports', () => {
    expect(csvCell('=cmd()')).toBe("'=cmd()");
    expect(csvCell('-3.5')).toBe('-3.5');
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
  });
});

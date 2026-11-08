// SHA-256 over bytes (WebCrypto) and the binary dataset encoding defined in
// engine/fpengine/canonical.py. Both implementations are tested against the same golden value.
import type { DatasetColumn } from './csv';

const enc = new TextEncoder();

export async function sha256Hex(data: Uint8Array | ArrayBuffer): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', data instanceof Uint8Array ? data : new Uint8Array(data));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

class Bytes {
  private chunks: Uint8Array[] = [];
  private size = 0;
  push(b: Uint8Array) { this.chunks.push(b); this.size += b.length; }
  u32(n: number) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); this.push(b); }
  u8(n: number) { this.push(new Uint8Array([n])); }
  concat(): Uint8Array {
    const out = new Uint8Array(this.size);
    let o = 0;
    for (const c of this.chunks) { out.set(c, o); o += c.length; }
    return out;
  }
}

export function datasetHashBytes(columns: Pick<DatasetColumn, 'name' | 'kind' | 'values'>[]): Uint8Array {
  const b = new Bytes();
  b.push(enc.encode('fp.dataset-hash/1\n'));
  for (const col of columns) {
    const name = enc.encode(col.name);
    b.u32(name.length);
    b.push(name);
    const n = col.values.length;
    if (col.kind === 'number') {
      b.u8(1);
      b.u32(n);
      const f = new Uint8Array(n * 8);
      const dv = new DataView(f.buffer);
      const mask = new Uint8Array(n);
      col.values.forEach((v, i) => {
        if (v === null || (typeof v === 'number' && Number.isNaN(v))) {
          dv.setUint32(i * 8, 0, true);
          dv.setUint32(i * 8 + 4, 0x7ff80000, true);
          mask[i] = 1;
        } else {
          const x = Number(v);
          dv.setFloat64(i * 8, x === 0 ? 0 : x, true);
        }
      });
      b.push(f);
      b.push(mask);
    } else {
      b.u8(2);
      b.u32(n);
      for (const v of col.values) {
        if (v === null) { b.u8(1); b.u32(0); }
        else { const s = enc.encode(String(v)); b.u8(0); b.u32(s.length); b.push(s); }
      }
    }
  }
  return b.concat();
}

export function datasetHash(columns: Pick<DatasetColumn, 'name' | 'kind' | 'values'>[]): Promise<string> {
  return sha256Hex(datasetHashBytes(columns));
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function decodeFloat32(b64: string): Float32Array {
  const b = base64ToBytes(b64);
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
}

export function decodeFloat64(b64: string): Float64Array {
  const b = base64ToBytes(b64);
  return new Float64Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

import { useEffect, useRef, useState } from 'react';

/** Width of a container in CSS pixels, so SVG charts draw text at its real size. */
export function useWidth<T extends HTMLElement>(fallback = 1000): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.round(el.clientWidth) || fallback));
    ro.observe(el);
    setW(Math.round(el.clientWidth) || fallback);
    return () => ro.disconnect();
  }, [fallback]);
  return [ref, w];
}

/** Round tick values covering [lo, hi], always including zero when it is in range. */
export function niceTicks(lo: number, hi: number, count = 5): number[] {
  const span = hi - lo || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-12; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : Number(v.toPrecision(12)));
  return out;
}

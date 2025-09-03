// Pixel <-> real world helpers, MOA and formatting
export function buildCalib({ pxPerInch }) {
  return {
    pxToIn(px) { return px / pxPerInch; },
    inToPx(inches) { return inches * pxPerInch; }
  };
}
export function pxPerInchFromRing({ ringPxDiameter, ringInches }) {
  return ringPxDiameter > 0 ? (ringPxDiameter / ringInches) : 0;
}
// 1 MOA ≈ 1.047" at 100 yards (exact enough for this UI)
export function moaFromInchesAtDistance(inches, distance, units='yards') {
  const yards = units === 'meters' ? (distance * 1.09361) : distance;
  const moa = (inches / (1.047 * (yards / 100)));
  return moa;
}
export const fmt = (n, d=2) => isFinite(n) ? n.toFixed(d) : '—';
// Minimum Enclosing Circle (two/three point support)
export function circleFrom2(a, b) {
  const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2;
  const r = Math.hypot(a[0] - b[0], a[1] - b[1]) / 2;
  return { cx, cy, r };
}
export function circleFrom3(a, b, c) {
  const d = 2 * (a[0]*(b[1]-c[1]) + b[0]*(c[1]-a[1]) + c[0]*(a[1]-b[1]));
  if (Math.abs(d) < 1e-9) return null;
  const ux = ((a[0]**2 + a[1]**2)*(b[1]-c[1]) + (b[0]**2 + b[1]**2)*(c[1]-a[1]) + (c[0]**2 + c[1]**2)*(a[1]-b[1])) / d;
  const uy = ((a[0]**2 + a[1]**2)*(c[0]-b[0]) + (b[0]**2 + b[1]**2)*(a[0]-c[0]) + (c[0]**2 + c[1]**2)*(b[0]-a[0])) / d;
  const r = Math.hypot(ux - a[0], uy - a[1]);
  return { cx: ux, cy: uy, r };
}
export function containsAll(points, c) {
  return points.every(p => Math.hypot(p[0]-c.cx, p[1]-c.cy) <= c.r + 1e-6);
}
export function minimumEnclosingCircle(points) {
  if (points.length === 0) return { cx: 0, cy: 0, r: 0 };
  let best = null;
  for (let i = 0; i < points.length; i++)
    for (let j = i+1; j < points.length; j++) {
      const c = circleFrom2(points[i], points[j]);
      if (containsAll(points, c) && (!best || c.r < best.r)) best = c;
    }
  for (let i = 0; i < points.length; i++)
    for (let j = i+1; j < points.length; j++)
      for (let k = j+1; k < points.length; k++) {
        const c = circleFrom3(points[i], points[j], points[k]);
        if (c && containsAll(points, c) && (!best || c.r < best.r)) best = c;
      }
  if (!best) best = { cx: points[0][0], cy: points[0][1], r: 0 };
  return best;
}
// convenience
export const groupDiameterPx = (pts) => minimumEnclosingCircle(pts).r * 2;
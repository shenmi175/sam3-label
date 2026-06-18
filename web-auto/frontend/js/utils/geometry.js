export function bboxFromPolygon(points = []) {
  const pairs = Array.isArray(points)
    ? points.map((point) => (Array.isArray(point) ? [Number(point[0] || 0), Number(point[1] || 0)] : null)).filter(Boolean)
    : [];
  if (pairs.length === 0) return null;
  const xs = pairs.map((point) => point[0]);
  const ys = pairs.map((point) => point[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** Bounding box from polygon points, 1:1 port of legacy js/utils/geometry.js. */
export function bboxFromPolygon(
  points: unknown = [],
): [number, number, number, number] | null {
  const pairs = Array.isArray(points)
    ? (points
        .map((point) =>
          Array.isArray(point) ? [Number(point[0] || 0), Number(point[1] || 0)] : null,
        )
        .filter(Boolean) as [number, number][])
    : [];
  if (pairs.length === 0) return null;
  const xs = pairs.map((point) => point[0]);
  const ys = pairs.map((point) => point[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** Deterministic class color, 1:1 port of ImageWorkspace.getClassColor. */
export function getClassColor(className: string): string {
  let hash = 0;
  const str = String(className || 'unknown');
  for (let i = 0; i < str.length; i += 1) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 70%, 50%)`;
}

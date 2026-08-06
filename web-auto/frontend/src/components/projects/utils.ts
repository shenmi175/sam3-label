/** Format a byte count the same way as the old projects.js. */
export function formatBytes(bytes: unknown): string {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

/** Join two server-side path segments. */
export function joinServerPath(root: string, child: string): string {
  const cleanRoot = String(root || '').replace(/\/+$/, '');
  const cleanChild = String(child || '').replace(/^\/+/, '');
  return cleanRoot ? `${cleanRoot}/${cleanChild}` : cleanChild;
}

/** Tolerant date formatting for created_at (epoch seconds/ms or ISO-like strings). */
export function safeFormatDate(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '--';
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) {
    const ts = numeric > 1e12 ? numeric : numeric * 1000;
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? '--' : d.toLocaleString();
  }
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? raw : d.toLocaleString();
}

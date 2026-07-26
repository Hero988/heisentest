/** Small display formatters. */

export function fmtTime(ms: number | null): string {
  if (ms === null) return "—";
  return new Date(ms).toISOString().slice(11, 23);
}

export function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function fmtDateTime(ms: number): string {
  const d = new Date(ms);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 19)}`;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function fmtCount(n: number): string {
  return n.toLocaleString("en-GB");
}

export function fmtBucket(ms: number): string {
  if (ms < 60_000) return `${ms / 1000}s`;
  if (ms < 3_600_000) return `${ms / 60_000}m`;
  if (ms < 86_400_000) return `${ms / 3_600_000}h`;
  return `${ms / 86_400_000}d`;
}

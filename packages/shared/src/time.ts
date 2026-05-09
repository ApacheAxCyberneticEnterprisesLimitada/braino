/**
 * Time helpers. Always UTC, always ISO 8601.
 */

/** Current time as ISO 8601 UTC (e.g., "2026-05-08T15:42:00.000Z"). */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Validate a string parses to a real ISO 8601 date. */
export function isIsoDateTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return false;
  // Basic shape check: must contain 'T' separator and 'Z' or offset
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.test(value);
}

/** Compare two ISO 8601 timestamps; returns negative, zero, or positive. */
export function compareIso(a: string, b: string): number {
  return Date.parse(a) - Date.parse(b);
}

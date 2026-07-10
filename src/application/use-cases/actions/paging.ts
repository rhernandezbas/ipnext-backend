/**
 * M5 — paging clamp shared by the actions list use cases. The route already
 * parses query strings defensively, but the use case is the LAST line: a
 * hostile/buggy caller can pass NaN, negatives or a huge pageSize directly.
 */

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

/** page: >=1 integer; anything else (undefined/NaN/0/negative) → 1. */
export function clampPage(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw) || raw < 1) return 1;
  return Math.floor(raw);
}

/** pageSize: 1..MAX integer; undefined/NaN/negative/0 → DEFAULT; >MAX → MAX. */
export function clampPageSize(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw) || raw < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.floor(raw));
}

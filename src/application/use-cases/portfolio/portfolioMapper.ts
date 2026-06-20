/**
 * Portfolio mapping helpers (Mis clientes — Fase 3).
 *
 * Pure functions shared by GetMyPortfolio / GetPortfolioByVendedor /
 * GetAllPortfolios so the row→item mapping, age-bucket math and summary tally
 * live in ONE place (no duplication across the three use cases).
 *
 * Hexagonal: pure application logic. No Prisma, no Express, no ports.
 */
import type {
  PortfolioClientRow,
} from '@domain/ports/PortfolioReadRepository';
import type {
  PortfolioDto,
  PortfolioItemDto,
  PortfolioSummaryDto,
  AgeBucket,
} from '@application/dto/portfolio/portfolio.dto';

/** A zeroed summary — the canonical empty shape. */
export function emptySummary(): PortfolioSummaryDto {
  return {
    total: 0,
    byBucket: { '0-3': 0, '3-6': 0, '6-12': 0, '12+': 0 },
    active: 0,
    withDebt: 0,
    withClaims: 0,
  };
}

/**
 * Whole months elapsed between `start` and `now`.
 * months = (now.year - start.year)*12 + (now.month - start.month), then
 * subtract 1 if now.day < start.day (so partial last month doesn't count).
 * Negative (future start) is clamped to 0.
 */
export function monthsElapsed(start: Date, now: Date): number {
  let months =
    (now.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    (now.getUTCMonth() - start.getUTCMonth());
  if (now.getUTCDate() < start.getUTCDate()) months -= 1;
  return months < 0 ? 0 : months;
}

/**
 * Bucket boundaries: lower bound inclusive, upper exclusive.
 * <3 → '0-3'; 3..<6 → '3-6'; 6..<12 → '6-12'; >=12 → '12+'.
 */
export function bucketFor(months: number): AgeBucket {
  if (months < 3) return '0-3';
  if (months < 6) return '3-6';
  if (months < 12) return '6-12';
  return '12+';
}

/**
 * Map a single client row + its open-claims count into a PortfolioItemDto.
 * The open-claims count is looked up in `openMap` (defaults to 0 when absent).
 */
export function mapRowToItem(
  row: PortfolioClientRow,
  openMap: Map<string, number>,
  now: Date,
): PortfolioItemDto {
  const months = monthsElapsed(new Date(row.oldestStartDate), now);
  const hasDebt =
    (row.balanceDue != null && row.balanceDue > 0) || row.status === 'late';
  return {
    clientId: row.clientId,
    clientName: row.clientName,
    status: row.status,
    ageBucket: bucketFor(months),
    oldestStartDate: row.oldestStartDate,
    contractsCount: row.contractsCount,
    hasDebt,
    debtAmount: row.balanceDue,
    debtCurrency: row.balanceCurrency,
    openClaims: openMap.get(row.clientId) ?? 0,
  };
}

/** Tally a summary over a list of already-mapped items. */
export function summarize(items: PortfolioItemDto[]): PortfolioSummaryDto {
  const summary = emptySummary();
  summary.total = items.length;
  for (const it of items) {
    summary.byBucket[it.ageBucket] += 1;
    if (it.status === 'active') summary.active += 1;
    if (it.hasDebt) summary.withDebt += 1;
    if (it.openClaims > 0) summary.withClaims += 1;
  }
  return summary;
}

/**
 * Build a full PortfolioDto from a set of client rows + the open-claims map.
 * Shared by the vendedor-scoped use cases (mine + by-vendedor). `unmapped`
 * defaults to false (an actual vendedor was resolved).
 */
export function buildPortfolioDto(
  rows: PortfolioClientRow[],
  openMap: Map<string, number>,
  now: Date,
): PortfolioDto {
  const items = rows.map((row) => mapRowToItem(row, openMap, now));
  return { items, summary: summarize(items), unmapped: false };
}

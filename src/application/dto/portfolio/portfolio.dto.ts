/**
 * Portfolio DTOs (Mis clientes — Fase 3).
 *
 * Output contract for GET /api/portfolio/mine. Use cases and routes map to
 * these — never return raw Prisma/domain entities.
 */

export type AgeBucket = '0-3' | '3-6' | '6-12' | '12+';

export interface PortfolioItemDto {
  clientId: string;
  clientName: string;
  status: string;
  ageBucket: AgeBucket;
  oldestStartDate: string; // ISO
  contractsCount: number;
  hasDebt: boolean;
  debtAmount: number | null;
  debtCurrency: string | null;
  openClaims: number;
}

export interface PortfolioSummaryDto {
  total: number;
  byBucket: Record<AgeBucket, number>; // keys '0-3','3-6','6-12','12+'
  active: number;
  withDebt: number;
  withClaims: number;
}

export interface PortfolioDto {
  items: PortfolioItemDto[];
  summary: PortfolioSummaryDto;
  unmapped: boolean;
}

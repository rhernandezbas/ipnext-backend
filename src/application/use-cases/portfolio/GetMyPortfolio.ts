/**
 * GetMyPortfolio (Mis clientes — Fase 3).
 *
 * Returns the logged-in agent's portfolio: their CLIENTS (deduplicated) — those
 * who have >=1 Contract whose vendedor equals the agent's grVendedorName — with
 * status, debt, open claims and an age bucket.
 *
 * Hexagonal: depends only on domain ports. No Prisma, no Express.
 */
import type { RbacUserRepository } from '@domain/ports/RbacUserRepository';
import type {
  PortfolioReadRepository,
  PortfolioClientRow,
} from '@domain/ports/PortfolioReadRepository';
import type { TicketRepository } from '@domain/ports/TicketRepository';
import type {
  PortfolioDto,
  PortfolioItemDto,
  AgeBucket,
} from '@application/dto/portfolio/portfolio.dto';

function emptySummary(): PortfolioDto['summary'] {
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
function monthsElapsed(start: Date, now: Date): number {
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
function bucketFor(months: number): AgeBucket {
  if (months < 3) return '0-3';
  if (months < 6) return '3-6';
  if (months < 12) return '6-12';
  return '12+';
}

export class GetMyPortfolio {
  constructor(
    private readonly rbacUserRepo: RbacUserRepository,
    private readonly portfolioRepo: PortfolioReadRepository,
    private readonly ticketRepo: TicketRepository,
  ) {}

  async execute(userId: string, now: Date = new Date()): Promise<PortfolioDto> {
    const user = await this.rbacUserRepo.findById(userId);
    const vendedor = user?.grVendedorName?.trim();
    // Unmapped agent: no vendedor name → no portfolio (FE shows a mapping hint).
    if (!user || !vendedor) {
      return { unmapped: true, items: [], summary: emptySummary() };
    }

    const rows = await this.portfolioRepo.listClientsByVendedor(vendedor);

    // Single aggregated call for open claims — NO N+1. "Open" = resolvedAt null
    // AND archivedAt null (the casing-safe terminal signal; see TicketRepository).
    const clientIds = rows.map((r) => r.clientId);
    const openMap = await this.ticketRepo.countOpenByClientIds(clientIds);

    const items: PortfolioItemDto[] = rows.map((row: PortfolioClientRow) => {
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
    });

    const summary = emptySummary();
    summary.total = items.length;
    for (const it of items) {
      summary.byBucket[it.ageBucket] += 1;
      if (it.status === 'active') summary.active += 1;
      if (it.hasDebt) summary.withDebt += 1;
      if (it.openClaims > 0) summary.withClaims += 1;
    }

    return { items, summary, unmapped: false };
  }
}

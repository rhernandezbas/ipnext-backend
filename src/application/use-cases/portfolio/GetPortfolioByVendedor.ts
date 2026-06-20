/**
 * GetPortfolioByVendedor (admin view — Fase 3 super admin).
 *
 * The reusable CORE of the portfolio feature: given a vendedor name directly,
 * return that vendedor's clients (deduplicated) with status, debt, open claims
 * and age bucket — the same PortfolioDto shape as /mine.
 *
 * `unmapped` is always false (a concrete vendedor was provided). A vendedor with
 * no clients yields empty items + a zeroed summary.
 *
 * GetMyPortfolio resolves the agent's vendedor and delegates here.
 *
 * Hexagonal: depends only on domain ports. No Prisma, no Express.
 */
import type { PortfolioReadRepository } from '@domain/ports/PortfolioReadRepository';
import type { TicketRepository } from '@domain/ports/TicketRepository';
import type { PortfolioDto } from '@application/dto/portfolio/portfolio.dto';
import { buildPortfolioDto } from './portfolioMapper';

export class GetPortfolioByVendedor {
  constructor(
    private readonly portfolioRepo: PortfolioReadRepository,
    private readonly ticketRepo: TicketRepository,
  ) {}

  async execute(vendedor: string, now: Date = new Date()): Promise<PortfolioDto> {
    const rows = await this.portfolioRepo.listClientsByVendedor(vendedor);

    // Single aggregated call for open claims — NO N+1. "Open" = resolvedAt null
    // AND archivedAt null (the casing-safe terminal signal; see TicketRepository).
    const clientIds = rows.map((r) => r.clientId);
    const openMap = await this.ticketRepo.countOpenByClientIds(clientIds);

    return buildPortfolioDto(rows, openMap, now);
  }
}

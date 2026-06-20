/**
 * GetAllPortfolios (admin view — ALL agents — Fase 3 super admin).
 *
 * Returns every client that has >=1 contract with a non-null vendedor, grouped
 * by (client, vendedor): one item per combination, each tagged with its
 * `vendedor`, plus a GLOBAL summary (across all vendedores).
 *
 * A single client with contracts under two vendedores yields TWO items.
 *
 * Hexagonal: depends only on domain ports. No Prisma, no Express.
 */
import type { PortfolioReadRepository } from '@domain/ports/PortfolioReadRepository';
import type { TicketRepository } from '@domain/ports/TicketRepository';
import type {
  AllPortfoliosDto,
  PortfolioItemWithVendedorDto,
} from '@application/dto/portfolio/portfolio.dto';
import { mapRowToItem, summarize } from './portfolioMapper';

export class GetAllPortfolios {
  constructor(
    private readonly portfolioRepo: PortfolioReadRepository,
    private readonly ticketRepo: TicketRepository,
  ) {}

  async execute(now: Date = new Date()): Promise<AllPortfoliosDto> {
    const rows = await this.portfolioRepo.listAllClientsWithVendedor();

    // Single aggregated claims call over the DISTINCT clientIds — NO N+1.
    // (A client shared by two vendedores appears twice in rows but once here.)
    const distinctClientIds = Array.from(new Set(rows.map((r) => r.clientId)));
    const openMap = await this.ticketRepo.countOpenByClientIds(distinctClientIds);

    const items: PortfolioItemWithVendedorDto[] = rows.map((row) => ({
      ...mapRowToItem(row, openMap, now),
      vendedor: row.vendedor,
    }));

    return { items, summary: summarize(items) };
  }
}

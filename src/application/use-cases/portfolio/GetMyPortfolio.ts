/**
 * GetMyPortfolio (Mis clientes — Fase 3).
 *
 * Returns the logged-in agent's portfolio: their CLIENTS (deduplicated) — those
 * who have >=1 Contract whose vendedor equals the agent's grVendedorName — with
 * status, debt, open claims and an age bucket.
 *
 * Resolves the agent's vendedor name from the user, then delegates the heavy
 * lifting to GetPortfolioByVendedor (shared core). Unmapped agents (no vendedor)
 * short-circuit to the empty/unmapped shape.
 *
 * Hexagonal: depends only on domain ports. No Prisma, no Express.
 */
import type { RbacUserRepository } from '@domain/ports/RbacUserRepository';
import type { PortfolioReadRepository } from '@domain/ports/PortfolioReadRepository';
import type { TicketRepository } from '@domain/ports/TicketRepository';
import type { PortfolioDto } from '@application/dto/portfolio/portfolio.dto';
import { emptySummary } from './portfolioMapper';
import { GetPortfolioByVendedor } from './GetPortfolioByVendedor';

export class GetMyPortfolio {
  private readonly byVendedor: GetPortfolioByVendedor;

  constructor(
    private readonly rbacUserRepo: RbacUserRepository,
    portfolioRepo: PortfolioReadRepository,
    ticketRepo: TicketRepository,
  ) {
    this.byVendedor = new GetPortfolioByVendedor(portfolioRepo, ticketRepo);
  }

  async execute(userId: string, now: Date = new Date()): Promise<PortfolioDto> {
    const user = await this.rbacUserRepo.findById(userId);
    const vendedor = user?.grVendedorName?.trim();
    // Unmapped agent: no vendedor name → no portfolio (FE shows a mapping hint).
    if (!user || !vendedor) {
      return { unmapped: true, items: [], summary: emptySummary() };
    }

    return this.byVendedor.execute(vendedor, now);
  }
}

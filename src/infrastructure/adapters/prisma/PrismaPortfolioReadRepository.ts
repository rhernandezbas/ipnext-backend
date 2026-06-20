/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * NOTE: This file uses `as any` casts on the Prisma client calls, mirroring
 * PrismaTicketRepository — `prisma generate` provides the typed delegate at
 * build time; the casts keep the file compiling regardless of generation order.
 *
 * Portfolio (Mis clientes — Fase 3): clients (deduplicated) who have >=1
 * contract with a given vendedor, joined with client status/balance.
 */
import type {
  PortfolioReadRepository,
  PortfolioClientRow,
  PortfolioClientRowWithVendedor,
} from '@domain/ports/PortfolioReadRepository';
import { prisma } from '../../database/prisma';

/**
 * Decimal → number. Prisma returns a Decimal object with toNumber(); fixtures
 * may pass a plain number/string. null/undefined stay null.
 * (Same pattern documented in PrismaCustomerRepository.)
 */
function toNumberOrNull(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'object' && v !== null && 'toNumber' in v) {
    return (v as { toNumber(): number }).toNumber();
  }
  return Number(v);
}

export class PrismaPortfolioReadRepository implements PortfolioReadRepository {
  async listClientsByVendedor(vendedor: string): Promise<PortfolioClientRow[]> {
    // Single query: all contracts for this vendedor + the client fields we need.
    // Grouping by client is done in JS (one pass) — cleaner than a groupBy + a
    // second client.findMany merge, and there is no N+1 (one round trip).
    const contracts: any[] = await (prisma as any).contract.findMany({
      where: { vendedor },
      select: {
        clientId: true,
        startDate: true,
        client: {
          select: {
            id: true,
            name: true,
            status: true,
            balanceDue: true,
            balanceCurrency: true,
          },
        },
      },
    });

    const byClient = new Map<string, PortfolioClientRow>();
    for (const c of contracts) {
      const startIso =
        c.startDate instanceof Date ? c.startDate.toISOString() : String(c.startDate);
      const existing = byClient.get(c.clientId);
      if (!existing) {
        byClient.set(c.clientId, {
          clientId: c.clientId,
          clientName: c.client?.name ?? '',
          status: c.client?.status ?? 'active',
          balanceDue: toNumberOrNull(c.client?.balanceDue),
          balanceCurrency: c.client?.balanceCurrency ?? null,
          oldestStartDate: startIso,
          contractsCount: 1,
        });
      } else {
        existing.contractsCount += 1;
        if (startIso < existing.oldestStartDate) {
          existing.oldestStartDate = startIso; // MIN(startDate)
        }
      }
    }

    // Deterministic order — sort by clientName asc (mirrors the in-memory adapter).
    return Array.from(byClient.values()).sort((a, b) =>
      a.clientName.localeCompare(b.clientName),
    );
  }

  async listAllClientsWithVendedor(): Promise<PortfolioClientRowWithVendedor[]> {
    // SINGLE query: every contract that HAS a vendedor + the client fields we
    // need. Grouping by (clientId, vendedor) is done in JS (one pass) — one round
    // trip, NO N+1. Empty-string vendedores are dropped in the loop (the DB-side
    // `not: null` filter doesn't catch '').
    const contracts: any[] = await (prisma as any).contract.findMany({
      where: { vendedor: { not: null } },
      select: {
        clientId: true,
        vendedor: true,
        startDate: true,
        client: {
          select: {
            id: true,
            name: true,
            status: true,
            balanceDue: true,
            balanceCurrency: true,
          },
        },
      },
    });

    const byKey = new Map<string, PortfolioClientRowWithVendedor>();
    for (const c of contracts) {
      const vendedor: string = c.vendedor ?? '';
      if (vendedor.trim() === '') continue; // guard against '' / whitespace
      const startIso =
        c.startDate instanceof Date ? c.startDate.toISOString() : String(c.startDate);
      const key = `${c.clientId} ${vendedor}`;
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, {
          clientId: c.clientId,
          clientName: c.client?.name ?? '',
          status: c.client?.status ?? 'active',
          balanceDue: toNumberOrNull(c.client?.balanceDue),
          balanceCurrency: c.client?.balanceCurrency ?? null,
          oldestStartDate: startIso,
          contractsCount: 1,
          vendedor,
        });
      } else {
        existing.contractsCount += 1;
        if (startIso < existing.oldestStartDate) {
          existing.oldestStartDate = startIso; // MIN(startDate)
        }
      }
    }

    // Deterministic order — by clientName, then vendedor (mirrors in-memory).
    return Array.from(byKey.values()).sort(
      (a, b) =>
        a.clientName.localeCompare(b.clientName) ||
        a.vendedor.localeCompare(b.vendedor),
    );
  }
}

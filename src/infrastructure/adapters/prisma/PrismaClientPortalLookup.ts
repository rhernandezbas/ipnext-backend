/* eslint-disable @typescript-eslint/no-explicit-any */
import { prisma } from '@infrastructure/database/prisma';
import type { ClientPortalLookup, ClientPortalLookupResult, ClientPortalNameResult } from '@domain/ports/ClientPortalLookup';
import { extractPortalDni } from '@domain/services/extractPortalDni';

/**
 * PrismaClientPortalLookup — production adapter (Fase 3, task 3.1).
 *
 * Reads ONLY `id`/`name`/`customAttributes` off `Client` — never the full
 * row — so this stays a genuinely narrow lookup, not `CustomerRepository` in
 * disguise.
 */
export class PrismaClientPortalLookup implements ClientPortalLookup {
  constructor(private readonly db = prisma) {}

  async findById(clientId: string): Promise<ClientPortalLookupResult | null> {
    const row = await (this.db as any).client.findUnique({
      where: { id: clientId },
      select: { id: true, name: true, customAttributes: true },
    });
    if (!row) return null;
    return { id: row.id, name: row.name, documento: extractPortalDni(row.customAttributes) };
  }

  async findNamesByIds(clientIds: string[]): Promise<ClientPortalNameResult[]> {
    if (clientIds.length === 0) return [];
    const rows = (await (this.db as any).client.findMany({
      where: { id: { in: clientIds } },
      select: { id: true, name: true },
    })) as Array<{ id: string; name: string }>;
    return rows.map((r) => ({ id: r.id, name: r.name }));
  }
}

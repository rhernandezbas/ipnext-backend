import { ClientMirrorRepository, UpsertResult } from '@domain/ports/ClientMirrorRepository';
import { GrClient, GrContract } from '@domain/entities/gestionReal';
import { prisma } from '../../database/prisma';

type ClientStatus = 'active' | 'late' | 'blocked' | 'inactive' | 'baja';

/** GR estado.codigo → local ClientStatus enum. */
export function mapStatus(code: string | null): ClientStatus {
  switch (code) {
    case '1': return 'active';     // Activo
    case '2': return 'late';       // Deudor
    case '4': return 'blocked';    // Incobrable
    case '6': return 'baja';       // Baja
    case '3':                      // Inactivo
    default:  return 'inactive';   // fallback (null / '5' / unknown)
  }
}

/** "DD-MM-YYYY" (optionally with time) → Date, or null when unparseable. */
function parseGrDate(s: string | null): Date | null {
  if (!s) return null;
  const [date] = s.split(' ');
  const [d, m, y] = date.split('-').map(Number);
  if (!d || !m || !y) return null;
  return new Date(y, m - 1, d);
}

/**
 * Prisma write side of the GR mirror. Upserts Client/Service rows keyed by the
 * external GR ids, leaving any pre-existing (e.g. Splynx-sourced) rows untouched.
 */
export class PrismaClientMirrorRepository implements ClientMirrorRepository {
  async upsertClient(c: GrClient): Promise<UpsertResult> {
    const existing = await prisma.client.findUnique({
      where: { grClienteId: c.grClienteId },
      select: { id: true },
    });

    const data = {
      name: c.name || `Cliente ${c.grClienteId}`,
      email: c.email ?? '',
      phone: c.phone ?? '',
      status: mapStatus(c.statusCode),
      address: c.address,
      city: c.city,
      country: c.province,
      customAttributes: c.raw as object,
    };

    if (existing) {
      await prisma.client.update({ where: { grClienteId: c.grClienteId }, data });
      return { created: false };
    }

    await prisma.client.create({
      data: {
        ...data,
        grClienteId: c.grClienteId,
        // login is unique + required; GR has no login, so namespace by GR id.
        login: `gr:${c.grClienteId}`,
      },
    });
    return { created: true };
  }

  async updateClientBalance(grClienteId: string, amount: number, currency: string | null, at: Date): Promise<void> {
    // Touch ONLY the three balance columns — never customAttributes, status, or catalog data.
    await prisma.client.updateMany({
      where: { grClienteId },
      data: {
        balanceDue: amount,
        balanceCurrency: currency,
        lastBalanceAt: at,
      },
    });
  }

  async upsertContract(k: GrContract): Promise<UpsertResult> {
    const parent = await prisma.client.findUnique({
      where: { grClienteId: k.grClienteId },
      select: { id: true },
    });
    // Parent must exist — the client sync always runs before contracts.
    if (!parent) return { created: false };

    const existing = await prisma.contract.findUnique({
      where: { grContratoId: k.grContratoId },
      select: { id: true },
    });

    // GUARD: `technology` is intentionally EXCLUDED from this data object.
    // Contract.technology is a user-managed field (backed by the ContractTechnology catalog).
    // The GR sync must never overwrite it — adding `technology` here would silently reset it to
    // null on every sync cycle. If you add new GR fields, double-check they are not user-owned.
    const data = {
      type: 'internet',
      plan: k.plan ?? 'Sin plan',
      status: k.status ?? 'active',
      startDate: parseGrDate(k.startDate) ?? new Date(),
      address: k.address ?? null,
      lat: k.lat ?? null,
      lng: k.lng ?? null,
    };

    if (existing) {
      await prisma.contract.update({ where: { grContratoId: k.grContratoId }, data });
      return { created: false };
    }

    await prisma.contract.create({
      data: { ...data, grContratoId: k.grContratoId, clientId: parent.id },
    });
    return { created: true };
  }
}

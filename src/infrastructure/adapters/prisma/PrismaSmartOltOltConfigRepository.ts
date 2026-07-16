import {
  SmartOltOltConfig,
  SmartOltOltConfigRepository,
  UpdateSmartOltOltConfigInput,
} from '@domain/ports/SmartOltOltConfigRepository';
import { prisma } from '../../database/prisma';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toConfig(row: any): SmartOltOltConfig {
  return {
    id: row.id,
    smartoltOltId: row.smartoltOltId,
    name: row.name,
    serviceVlanDefault: row.serviceVlanDefault ?? null,
    mgmtVlan: row.mgmtVlan ?? null,
  };
}

/**
 * smartolt-provision (K2) — adapter Prisma del catálogo de OLTs SmartOLT.
 * Seed por migración (20260923000000_smartolt_provision); update parcial con la
 * semántica del port: campo OMITIDO = mantener, `null` explícito = limpiar.
 */
export class PrismaSmartOltOltConfigRepository implements SmartOltOltConfigRepository {
  async list(): Promise<SmartOltOltConfig[]> {
    const rows = await (prisma as any).smartOltOltConfig.findMany({
      orderBy: { smartoltOltId: 'asc' },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return rows.map((r: any) => toConfig(r));
  }

  async findBySmartoltOltId(smartoltOltId: string): Promise<SmartOltOltConfig | null> {
    const row = await (prisma as any).smartOltOltConfig.findUnique({ where: { smartoltOltId } });
    return row ? toConfig(row) : null;
  }

  async update(id: string, patch: UpdateSmartOltOltConfigInput): Promise<SmartOltOltConfig | null> {
    const data: Record<string, unknown> = {};
    if (patch.name !== undefined) data['name'] = patch.name;
    if ('serviceVlanDefault' in patch) data['serviceVlanDefault'] = patch.serviceVlanDefault ?? null;
    if ('mgmtVlan' in patch) data['mgmtVlan'] = patch.mgmtVlan ?? null;
    try {
      const row = await (prisma as any).smartOltOltConfig.update({ where: { id }, data });
      return toConfig(row);
    } catch (err) {
      // P2025 = fila inexistente → contrato del port: null (el use case tipa el 404).
      if (typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2025') {
        return null;
      }
      throw err;
    }
  }
}

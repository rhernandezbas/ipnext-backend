import {
  SmartOltOltConfig,
  SmartOltOltConfigRepository,
  UpdateSmartOltOltConfigInput,
} from '@domain/ports/SmartOltOltConfigRepository';

/**
 * smartolt-provision (K2) — catálogo de OLTs in-memory para tests. Se seedea
 * con `seed()`; espeja el contrato del adapter Prisma (update parcial que
 * distingue "omitido" de "null").
 */
export class InMemorySmartOltOltConfigRepository implements SmartOltOltConfigRepository {
  private rows = new Map<string, SmartOltOltConfig>();

  seed(row: SmartOltOltConfig): void {
    this.rows.set(row.id, { ...row });
  }

  async list(): Promise<SmartOltOltConfig[]> {
    return [...this.rows.values()]
      .map(r => ({ ...r }))
      .sort((a, b) => a.smartoltOltId.localeCompare(b.smartoltOltId, undefined, { numeric: true }));
  }

  async findBySmartoltOltId(smartoltOltId: string): Promise<SmartOltOltConfig | null> {
    const row = [...this.rows.values()].find(r => r.smartoltOltId === smartoltOltId);
    return row ? { ...row } : null;
  }

  async update(id: string, patch: UpdateSmartOltOltConfigInput): Promise<SmartOltOltConfig | null> {
    const current = this.rows.get(id);
    if (!current) return null;
    const updated: SmartOltOltConfig = {
      ...current,
      name: patch.name ?? current.name,
      // Nullables: "omitido" (mantener) ≠ "null" (limpiar) — patrón IngestConfig.
      serviceVlanDefault:
        'serviceVlanDefault' in patch ? patch.serviceVlanDefault ?? null : current.serviceVlanDefault,
      mgmtVlan: 'mgmtVlan' in patch ? patch.mgmtVlan ?? null : current.mgmtVlan,
    };
    this.rows.set(id, updated);
    return { ...updated };
  }
}

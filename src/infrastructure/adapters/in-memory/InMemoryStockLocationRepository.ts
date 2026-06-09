import { StockLocationRepository, LocationContent, LocationLabel } from '@domain/ports/StockLocationRepository';
import { StockLocation, StockLocationType } from '@domain/entities/stock-location';

/** Test-only content override for a location — used to seed listWithContent without a real DB. */
interface ContentOverride {
  assetCount: number;
  materialQty: number;
  label: string | null;
}

/** Test-only label override for findLabelsByIds — used by FIX-3 tests for empty-location label resolution. */
interface LabelOverride {
  type: StockLocationType;
  label: string | null;
}

const ALL_TYPES: StockLocationType[] = ['DEPOSITO', 'CLIENTE', 'TECNICO', 'CAMIONETA'];

export class InMemoryStockLocationRepository implements StockLocationRepository {
  readonly store = new Map<string, StockLocation>();
  /** Test seam: seed content data for listWithContent() without needing asset/stock repos. */
  private readonly contentOverrides = new Map<string, ContentOverride>();
  /** Test seam: seed label data for findLabelsByIds() — allows testing empty-location resolution. */
  private readonly labelOverrides = new Map<string, LabelOverride>();

  /**
   * Test-only setter — call in test setup to define what listWithContent() returns for a location.
   * Mimics Prisma's selective include (contract.client, technician, vehicle) without a real DB.
   */
  seedContent(locationId: string, override: ContentOverride): void {
    this.contentOverrides.set(locationId, override);
  }

  /**
   * FIX-3 test seam — call in test setup to define what findLabelsByIds() returns for a location.
   * Allows testing label resolution for locations that have no current content.
   */
  seedLabel(locationId: string, override: LabelOverride): void {
    this.labelOverrides.set(locationId, override);
  }

  async findByCode(code: string): Promise<StockLocation | null> {
    const found = Array.from(this.store.values()).find((l) => l.code === code);
    return found ? { ...found } : null;
  }

  async findByTypeAndContract(type: string, contractId: string): Promise<StockLocation | null> {
    const found = Array.from(this.store.values()).find(
      (l) => l.type === type && l.contractId === contractId,
    );
    return found ? { ...found } : null;
  }

  async findByTypeAndTechnician(type: string, technicianId: string): Promise<StockLocation | null> {
    const found = Array.from(this.store.values()).find(
      (l) => l.type === type && l.technicianId === technicianId,
    );
    return found ? { ...found } : null;
  }

  async findByTypeAndVehicle(type: StockLocationType, vehicleId: string): Promise<StockLocation | null> {
    const found = Array.from(this.store.values()).find(
      (l) => l.type === type && l.vehicleId === vehicleId,
    );
    return found ? { ...found } : null;
  }

  async create(location: StockLocation): Promise<StockLocation> {
    this.store.set(location.id, { ...location });
    return { ...location };
  }

  /**
   * Wave 7 (Capstone) — returns locations with content (assetCount > 0 OR materialQty > 0).
   * In-memory: uses contentOverrides set via seedContent() for test control.
   * Parity with Prisma adapter: same shape, same empty-location exclusion rule.
   */
  async listWithContent(): Promise<LocationContent[]> {
    const results: LocationContent[] = [];
    for (const loc of this.store.values()) {
      const override = this.contentOverrides.get(loc.id);
      const assetCount = override?.assetCount ?? 0;
      const materialQty = override?.materialQty ?? 0;
      if (assetCount > 0 || materialQty > 0) {
        let label: string | null = override?.label ?? null;
        if (label === null) {
          // Derive a fallback label from type
          if (loc.type === 'DEPOSITO') label = 'Depósito';
        }
        results.push({
          id: loc.id,
          type: loc.type,
          code: loc.code,
          contractId: loc.contractId,
          technicianId: loc.technicianId,
          vehicleId: loc.vehicleId,
          label,
          assetCount,
          materialQty,
        });
      }
    }
    return results;
  }

  /**
   * FIX-3 (Wave 7 review) — batch-resolve labels for ANY location ids, including
   * now-empty locations. In-memory: uses labelOverrides (via seedLabel) if present,
   * falls back to DEPOSITO type rule, else null.
   */
  async findLabelsByIds(ids: string[]): Promise<LocationLabel[]> {
    return ids.map((id): LocationLabel => {
      const labelOverride = this.labelOverrides.get(id);
      if (labelOverride) {
        return { id, type: labelOverride.type, label: labelOverride.label };
      }
      const loc = this.store.get(id);
      if (!loc) return { id, type: 'DEPOSITO', label: null };
      // Fallback label derivation — same rules as Prisma adapter
      let label: string | null = null;
      if (loc.type === 'DEPOSITO') label = 'Depósito';
      return { id, type: loc.type, label };
    });
  }
}

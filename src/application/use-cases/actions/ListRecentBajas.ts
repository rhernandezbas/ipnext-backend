import { ContractPairingReader } from '@domain/ports/ContractPairingReader';
import { RetirementOrderReader, RetirementTaskResult } from '@domain/ports/RetirementOrderReader';
import { ContractInventoryRepository } from '@domain/ports/ContractInventoryRepository';
import { ClientNameLookup } from './lookups';
import { clampPage, clampPageSize } from './paging';

// ─── DTOs ─────────────────────────────────────────────────────────────────────

export interface RecentBajaDto {
  contractId: string;
  clientId: string;
  clientName: string | null;
  address: string | null;
  startDate: string;
  motivoBaja: string | null;
  /** Check "orden de retiro": ScheduledTask de un proyecto con allowsEquipmentRetirement. */
  retirementOrder: RetirementTaskResult;
  /** Ítems de inventario ACTIVOS aún colgados del contrato — la alarma si no hay orden. */
  activeEquipmentCount: number;
}

export interface ListRecentBajasInput {
  page?: number;
  pageSize?: number;
}

export interface ListRecentBajasResult {
  items: RecentBajaDto[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * actions-worklist BAJA-1 — listado COMPUTADO de bajas recientes (sin tabla
 * propia, derivado del mirror). Excluye SIEMPRE las bajas de titularidad
 * (viven en el tab de casos). Por fila computa el check "orden de retiro"
 * (por contrato O por cliente sin contrato linkeado — M4) + el conteo de
 * equipos activos.
 *
 * "Reciente" (M3, design §4): sin updatedAt ni fecha de baja persistida, un
 * `days=` real NO es implementable — el proxy honesto es motivoBaja NOT NULL
 * (forward-only desde 2026-07-10; el backfill histórico tiene NULL y queda
 * fuera). El DTO NO trae fecha de baja; orden estable del reader
 * (ver ContractPairingReader).
 */
export class ListRecentBajas {
  constructor(
    private readonly pairingReader: ContractPairingReader,
    private readonly retirementReader: RetirementOrderReader,
    private readonly inventoryRepo: ContractInventoryRepository,
    private readonly clientLookup: ClientNameLookup,
  ) {}

  async execute(input: ListRecentBajasInput): Promise<ListRecentBajasResult> {
    const page = clampPage(input.page);
    const pageSize = clampPageSize(input.pageSize);

    const { items, total } = await this.pairingReader.findRecentBajas({
      excludeTitularity: true,
      page,
      pageSize,
    });

    const clientNames = new Map<string, string | null>();
    const dtos: RecentBajaDto[] = [];

    for (const contract of items) {
      const [retirementOrder, inventory] = await Promise.all([
        this.retirementReader.hasRetirementTask({ contractId: contract.id, clientId: contract.clientId }),
        this.inventoryRepo.listByContract(contract.id),
      ]);

      if (!clientNames.has(contract.clientId)) {
        const client = await this.clientLookup.findById(contract.clientId);
        clientNames.set(contract.clientId, client?.name ?? null);
      }

      dtos.push({
        contractId: contract.id,
        clientId: contract.clientId,
        clientName: clientNames.get(contract.clientId) ?? null,
        address: contract.address,
        startDate: contract.startDate,
        motivoBaja: contract.motivoBaja,
        retirementOrder,
        activeEquipmentCount: inventory.filter((i) => i.status === 'active').length,
      });
    }

    return { items: dtos, total, page, pageSize };
  }
}

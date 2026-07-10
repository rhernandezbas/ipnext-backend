import { OwnershipCaseStatus, OwnershipTransferCase } from '@domain/entities/ownershipCase';
import { OwnershipCaseRepository } from '@domain/ports/OwnershipCaseRepository';
import { ClientTvCancellationRepository } from '@domain/ports/ClientTvCancellationRepository';
import { ContractServiceRepository } from '@domain/ports/ContractServiceRepository';
import { ServiceCatalogRepository } from '@domain/ports/ServiceCatalogRepository';
import { PppoeServiceRepository } from '@domain/ports/PppoeServiceRepository';
import { ContractInventoryRepository } from '@domain/ports/ContractInventoryRepository';
import { ClientNameLookup, UserNameLookup } from './lookups';
import { clampPage, clampPageSize } from './paging';

// ─── DTOs (nunca entidades crudas) ────────────────────────────────────────────

/**
 * 'ok' | 'pending' | null. H2: null = "no evaluable O no aplica" — sin target,
 * sin catálogo TV, o el ORIGEN no tiene nada que transferir/migrar (cliente sin
 * TV / sin PPPoE). El FE muestra "—". Los null NUNCA bloquean el flip a done.
 */
export type OwnershipAutoCheck = 'ok' | 'pending' | null;

export interface OwnershipCaseEquipmentDto {
  /** Ítems de inventario ACTIVOS aún colgados del contrato origen. */
  sourceActive: number;
  /** Ídem contrato destino — null cuando el caso no tiene target. */
  targetActive: number | null;
  /** Check MANUAL (mundo físico) persistido, con rastro. */
  reviewed: boolean;
  reviewedAt: string | null;
  reviewedByName: string | null;
}

export interface OwnershipCaseChecksDto {
  tv: OwnershipAutoCheck;
  pppoe: OwnershipAutoCheck;
  equipment: OwnershipCaseEquipmentDto;
}

export interface OwnershipCaseCandidateDto {
  contractId: string;
  clientId: string;
  clientName: string | null;
}

export interface OwnershipCaseDto {
  id: string;
  status: OwnershipCaseStatus;
  sourceContractId: string;
  sourceClientId: string;
  sourceClientName: string | null;
  motivoBaja: string;
  /**
   * L6 — HOY SIEMPRE null: la fecha de baja de GR (raw `baja`, dd-mm-yyyy) no
   * se persiste en el mirror ni en el caso todavía. El campo queda en el wire
   * (el FE ya está construido contra él) y se poblará cuando el sync persista
   * la fecha de baja (follow-up documentado en design §1).
   */
  bajaDate: string | null;
  targetContractId: string | null;
  targetClientId: string | null;
  targetClientName: string | null;
  candidates: OwnershipCaseCandidateDto[] | null;
  dismissReason: string | null;
  checks: OwnershipCaseChecksDto;
  detectedAt: string;
  updatedAt: string;
}

export interface ListOwnershipCasesInput {
  status?: OwnershipCaseStatus;
  page?: number;
  pageSize?: number;
}

export interface ListOwnershipCasesResult {
  items: OwnershipCaseDto[];
  total: number;
  page: number;
  pageSize: number;
}

/** Nombre del catálogo TV managed — mismo ancla que los use cases Gigared. */
const TV_CATALOG_NAME = 'TV';

/**
 * actions-worklist CASE-1 — lista paginada de casos de titularidad con los
 * checks AUTO computados EN LA LECTURA contra el estado real (nunca persistidos
 * como verdad). Semántica H2 — null significa "no evaluable O no aplica":
 *
 *   tv     = null sin target, sin catálogo TV, o si el ORIGEN no tiene rastro
 *            de TV (ni severed ni fila TV managed ACTIVA en el contrato origen
 *            — un titular viejo SIN TV no tiene nada que transferir).
 *            'pending' solo cuando HAY TV que transferir (origen con TV viva, o
 *            severed pero destino aún sin fila activa).
 *            'ok' = isCancelled(sourceClient) && fila TV ACTIVA en el target.
 *   pppoe  = null sin target o si el contrato ORIGEN no tiene NINGÚN
 *            PppoeService (nada que migrar — cliente TV-only).
 *            'ok' = existe PppoeService `enabled` en el target; si no, 'pending'.
 *   equipment = conteos de inventario activo (source/target) + el check MANUAL
 *            persistido (reviewed + actor + fecha).
 *
 * Flip a done (design §5, H2+M1): un caso `pending` con equipmentReviewed y
 * SIN checks 'pending' (tv !== 'pending' && pppoe !== 'pending' — los n/a no
 * bloquean; ambos null + reviewed = caso solo-equipos) se flipea vía
 * `flipToDone` (CAS: updateMany condicional). Si el CAS pierde (dismiss
 * concurrente entre lectura y flip) el DTO NO sale done — sale el estado real
 * releído. Si el flip LANZA, best-effort: DTO done, se re-intenta en la
 * próxima lectura. Un fallo del flip NUNCA rompe la lectura.
 */
export class ListOwnershipCases {
  constructor(
    private readonly caseRepo: OwnershipCaseRepository,
    private readonly tvCancellation: ClientTvCancellationRepository,
    private readonly contractServiceRepo: ContractServiceRepository,
    private readonly serviceCatalogRepo: ServiceCatalogRepository,
    private readonly pppoeRepo: PppoeServiceRepository,
    private readonly inventoryRepo: ContractInventoryRepository,
    private readonly clientLookup: ClientNameLookup,
    private readonly userLookup: UserNameLookup,
  ) {}

  async execute(input: ListOwnershipCasesInput): Promise<ListOwnershipCasesResult> {
    const page = clampPage(input.page);
    const pageSize = clampPageSize(input.pageSize);

    const { items, total } = await this.caseRepo.list({ status: input.status, page, pageSize });

    // Resuelto UNA vez por página (no por caso) — sin catálogo TV el check no aplica.
    const tvCatalog = await this.serviceCatalogRepo.getByName(TV_CATALOG_NAME);
    const tvCatalogId = tvCatalog?.id ?? null;

    // Cache de nombres por página — evita re-lookups del mismo cliente/usuario.
    const clientNames = new Map<string, string | null>();
    const userNames = new Map<string, string | null>();

    const dtos: OwnershipCaseDto[] = [];
    for (const c of items) {
      dtos.push(await this.toDto(c, tvCatalogId, clientNames, userNames));
    }

    return { items: dtos, total, page, pageSize };
  }

  private async toDto(
    c: OwnershipTransferCase,
    tvCatalogId: string | null,
    clientNames: Map<string, string | null>,
    userNames: Map<string, string | null>,
  ): Promise<OwnershipCaseDto> {
    const tv = await this.computeTvCheck(c, tvCatalogId);
    const pppoe = await this.computePppoeCheck(c);
    const equipment = await this.computeEquipment(c, userNames);

    // Flip a done (H2 + M1): reviewed y sin checks 'pending' (los n/a no
    // bloquean). CAS vía flipToDone — si pierde la carrera (dismiss concurrente)
    // el DTO NO sale done, sale el estado real releído. Si el flip LANZA,
    // best-effort: DTO done y se re-intenta en la próxima lectura.
    let status = c.status;
    if (c.status === 'pending' && c.equipmentReviewed && tv !== 'pending' && pppoe !== 'pending') {
      try {
        const flipped = await this.caseRepo.flipToDone(c.id);
        if (flipped) {
          status = 'done';
        } else {
          const fresh = await this.caseRepo.getById(c.id);
          status = fresh?.status ?? c.status;
        }
      } catch {
        // best-effort: swallow — el flip volverá a intentarse en la próxima lectura
        status = 'done';
      }
    }

    const candidates = c.candidates === null
      ? null
      : await Promise.all(
          c.candidates.map(async (cand) => ({
            contractId: cand.contractId,
            clientId: cand.clientId,
            clientName: await this.clientName(cand.clientId, clientNames),
          })),
        );

    return {
      id: c.id,
      status,
      sourceContractId: c.sourceContractId,
      sourceClientId: c.sourceClientId,
      sourceClientName: await this.clientName(c.sourceClientId, clientNames),
      motivoBaja: c.motivoBaja,
      bajaDate: c.bajaDate,
      targetContractId: c.targetContractId,
      targetClientId: c.targetClientId,
      targetClientName: c.targetClientId === null ? null : await this.clientName(c.targetClientId, clientNames),
      candidates,
      dismissReason: c.dismissReason,
      checks: { tv, pppoe, equipment },
      detectedAt: c.detectedAt,
      updatedAt: c.updatedAt,
    };
  }

  // ─── Checks AUTO ─────────────────────────────────────────────────────────────

  private async computeTvCheck(
    c: OwnershipTransferCase,
    tvCatalogId: string | null,
  ): Promise<OwnershipAutoCheck> {
    if (c.targetContractId === null || tvCatalogId === null) return null;

    const sourceSevered = await this.tvCancellation.isCancelled(c.sourceClientId);
    if (!sourceSevered) {
      // H2 — sin severed, el rastro de TV es la fila managed ACTIVA en el ORIGEN:
      // si tampoco existe, el titular viejo no tiene TV → no aplica (null).
      const sourceRow = await this.contractServiceRepo.getByPair(c.sourceContractId, tvCatalogId);
      if (sourceRow?.status !== 'active') return null;
      return 'pending'; // hay TV viva en el origen — falta transferirla
    }

    const targetRow = await this.contractServiceRepo.getByPair(c.targetContractId, tvCatalogId);
    return targetRow?.status === 'active' ? 'ok' : 'pending';
  }

  private async computePppoeCheck(c: OwnershipTransferCase): Promise<OwnershipAutoCheck> {
    if (c.targetContractId === null) return null;

    // H2 — el contrato ORIGEN sin ningún PppoeService = nada que migrar (null).
    const sourceRows = await this.pppoeRepo.findByContract(c.sourceContractId);
    if (sourceRows.length === 0) return null;

    const rows = await this.pppoeRepo.findByContract(c.targetContractId);
    return rows.some((r) => r.status === 'enabled') ? 'ok' : 'pending';
  }

  private async computeEquipment(
    c: OwnershipTransferCase,
    userNames: Map<string, string | null>,
  ): Promise<OwnershipCaseEquipmentDto> {
    const sourceActive = await this.activeItemCount(c.sourceContractId);
    const targetActive = c.targetContractId === null ? null : await this.activeItemCount(c.targetContractId);

    let reviewedByName: string | null = null;
    if (c.equipmentReviewedById !== null) {
      if (!userNames.has(c.equipmentReviewedById)) {
        const user = await this.userLookup.findById(c.equipmentReviewedById);
        userNames.set(c.equipmentReviewedById, user?.name ?? null);
      }
      reviewedByName = userNames.get(c.equipmentReviewedById) ?? null;
    }

    return {
      sourceActive,
      targetActive,
      reviewed: c.equipmentReviewed,
      reviewedAt: c.equipmentReviewedAt,
      reviewedByName,
    };
  }

  private async activeItemCount(contractId: string): Promise<number> {
    const items = await this.inventoryRepo.listByContract(contractId);
    return items.filter((i) => i.status === 'active').length;
  }

  private async clientName(clientId: string, cache: Map<string, string | null>): Promise<string | null> {
    if (!cache.has(clientId)) {
      const client = await this.clientLookup.findById(clientId);
      cache.set(clientId, client?.name ?? null);
    }
    return cache.get(clientId) ?? null;
  }
}

import type { PppoeServiceRepository } from '@domain/ports/PppoeServiceRepository';
import type { RadiusEventRepository } from '@domain/ports/RadiusEventRepository';
import type { UispDeviceRepository } from '@domain/ports/UispDeviceRepository';
import type { AccessPointRepository } from '@domain/ports/AccessPointRepository';
import type { ContractRepository } from '@domain/ports/ContractRepository';
import type { SyncStateRepository } from '@domain/ports/SyncStateRepository';
import type { PppoeService } from '@domain/entities/pppoeService';
import type { UispDevice } from '@domain/entities/uisp';
import { normalizeMac } from '@domain/services/macNormalize';

const ENTITY = 'contract-network-auto-assign';

export interface AutoAssignContractNetworkResult {
  /** Contratos con al menos un PppoeService (contractId != null) — el universo evaluado. */
  contractsEvaluated: number;
  /** Escrituras efectivas (matriz filas 1, 2, 9, 10 del design). */
  assigned: number;
  /** Derivó igual a lo persistido — sin write. */
  unchanged: number;
  /** Algún eslabón no resolvió — no se tocó lo existente. */
  unresolved: number;
  /** Duplicado de MAC sin desempate posible — no se tocó, se logueó. */
  ambiguous: number;
  /** Cascada nivel 1: MAC resuelta vía PppoeService.callerId. */
  macFromCallerId: number;
  /** Cascada nivel 2: MAC resuelta vía el último RadiusEvent del username. */
  macFromRadiusEvent: number;
  durationMs: number;
}

/** Puntaje de desempate: lastSeenAt más reciente gana; null se trata como "sin señal" (pierde). */
function lastSeenScore(device: UispDevice): number {
  return device.lastSeenAt ? device.lastSeenAt.getTime() : -Infinity;
}

/**
 * contract-node-ap-auto-assign (Fase B) — deriva `Contract.networkSiteId`/`accessPointId` desde
 * la evidencia de red (PppoeService → MAC → UispDevice station → AccessPoint) y los ESCRIBE
 * cuando la derivación resuelve — semántica AUTO DURA (design §6): pisa cualquier asignación
 * previa (manual o automática); si NO resuelve, NUNCA toca lo existente; si hay MAC duplicada sin
 * desempate posible, salta el contrato y loguea un warning.
 *
 * Invocado por `UispSyncScheduler` post-sync, dentro del advisory lock, gated por su PROPIO
 * feature flag (`contract-network-auto-assign`, dark por default) — ver Batch 5. Este use case
 * NO conoce el flag: siempre corre cuando se lo invoca; el gate vive en el scheduler.
 *
 * Perf (design §8): 5 reads batch (pppoe, RadiusEvent MACs, mirror devices, catálogo AP,
 * asignaciones actuales) + writes SOLO para diffs, secuenciales.
 */
export class AutoAssignContractNetwork {
  constructor(
    private readonly pppoeRepo: PppoeServiceRepository,
    private readonly radiusEventRepo: RadiusEventRepository,
    private readonly uispDeviceRepo: UispDeviceRepository,
    private readonly accessPointRepo: AccessPointRepository,
    private readonly contractRepo: ContractRepository,
    private readonly syncStateRepo: SyncStateRepository,
  ) {}

  async execute(): Promise<AutoAssignContractNetworkResult> {
    try {
      const result = await this.run();
      await this.persistState(`ok: ${JSON.stringify(result)}`, result.assigned);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Best-effort: si el propio persistState falla, no enmascarar el error original.
      await this.persistState(`error: ${message}`, 0).catch(() => undefined);
      throw err;
    }
  }

  private async persistState(lastResult: string, itemsSynced: number): Promise<void> {
    await this.syncStateRepo.save({
      entity: ENTITY,
      cursor: null,
      lastRunAt: new Date(),
      lastResult,
      itemsSynced,
    });
  }

  private async run(): Promise<AutoAssignContractNetworkResult> {
    const start = Date.now();
    let assigned = 0;
    let unchanged = 0;
    let unresolved = 0;
    let ambiguous = 0;
    let macFromCallerId = 0;
    let macFromRadiusEvent = 0;

    // 1. Universo: TODO PppoeService con contractId != null (fila 6 lo excluye si es null),
    //    agrupado por contrato. El candidato es el 'enabled' de createdAt más reciente; un
    //    contrato con 0 enabled queda SIN candidato (fila 7/8 -> unresolved).
    const allPppoe = await this.pppoeRepo.list();
    const byContract = new Map<string, PppoeService[]>();
    for (const p of allPppoe) {
      if (p.contractId == null) continue;
      const list = byContract.get(p.contractId);
      if (list) list.push(p);
      else byContract.set(p.contractId, [p]);
    }

    const candidateByContract = new Map<string, PppoeService>();
    for (const [contractId, rows] of byContract) {
      let best: PppoeService | null = null;
      for (const row of rows) {
        if (row.status !== 'enabled') continue;
        if (!best || row.createdAt > best.createdAt) best = row;
      }
      if (best) candidateByContract.set(contractId, best);
    }

    const contractsEvaluated = byContract.size;

    // 2. MACs vía RadiusEvent — UNA query batch para todos los candidatos (fallback nivel 2).
    const candidateUsernames = [...candidateByContract.values()].map((p) => p.username);
    const radiusMacByUsername =
      candidateUsernames.length > 0
        ? await this.radiusEventRepo.latestMacByUsernames(candidateUsernames)
        : new Map<string, string>();

    // 3. Mirror: stations VIVAS agrupadas por MAC normalizada (fila 8: missingSince excluye).
    const allDevices = await this.uispDeviceRepo.listAll();
    const stationsByMac = new Map<string, UispDevice[]>();
    for (const device of allDevices) {
      if (device.role == null || device.role.toLowerCase() !== 'station') continue;
      if (device.missingSince !== null) continue;
      const mac = normalizeMac(device.mac);
      if (mac === null) continue;
      const list = stationsByMac.get(mac);
      if (list) list.push(device);
      else stationsByMac.set(mac, [device]);
    }

    // 4. Catálogo de APs por uispDeviceId — INCLUYE retirados (matriz fila 9 los asigna igual).
    const allAps = await this.accessPointRepo.findMany();
    const apByUispDeviceId = new Map(allAps.map((ap) => [ap.uispDeviceId, ap]));

    // 5. Asignaciones actuales, batch — solo para los contratos con candidato (los sin
    //    candidato ya son unresolved sin necesidad de leer su estado actual).
    const candidateContractIds = [...candidateByContract.keys()];
    const currentRows =
      candidateContractIds.length > 0
        ? await this.contractRepo.getNetworkAssignments(candidateContractIds)
        : [];
    const currentByContract = new Map(currentRows.map((r) => [r.id, r]));

    // 6. Resolver cada contrato del universo.
    for (const contractId of byContract.keys()) {
      const candidate = candidateByContract.get(contractId);
      if (!candidate) {
        unresolved++; // fila 7 (0 pppoe enabled)
        continue;
      }

      // Cascada de MAC (§4): callerId primero, RadiusEvent como fallback.
      let mac = normalizeMac(candidate.callerId);
      if (mac !== null) {
        macFromCallerId++;
      } else {
        const rawMac = radiusMacByUsername.get(candidate.username);
        mac = rawMac !== undefined ? normalizeMac(rawMac) : null;
        if (mac !== null) macFromRadiusEvent++;
      }
      if (mac === null) {
        unresolved++;
        continue;
      }

      // Match de station + desempate §6.2.
      const stations = stationsByMac.get(mac) ?? [];
      if (stations.length === 0) {
        unresolved++;
        continue;
      }
      let station: UispDevice;
      if (stations.length === 1) {
        station = stations[0]!;
      } else {
        const sorted = [...stations].sort((a, b) => lastSeenScore(b) - lastSeenScore(a));
        if (lastSeenScore(sorted[0]!) === lastSeenScore(sorted[1]!)) {
          ambiguous++;
          console.warn(
            `[auto-assign] MAC ambigua tras desempate: ${mac} — candidatos: ${stations.map((s) => s.uispId).join(', ')}`,
          );
          continue;
        }
        station = sorted[0]!;
      }

      // Resolución del AP (fila 9: puede estar retirado, se asigna igual; fila 10: par coherente).
      if (station.apUispDeviceId === null) {
        unresolved++;
        continue;
      }
      const ap = apByUispDeviceId.get(station.apUispDeviceId);
      if (!ap) {
        unresolved++;
        continue;
      }

      const derived = { networkSiteId: ap.networkSiteId, accessPointId: ap.id };
      const current = currentByContract.get(contractId);
      if (current && current.networkSiteId === derived.networkSiteId && current.accessPointId === derived.accessPointId) {
        unchanged++;
        continue;
      }

      await this.contractRepo.updateNetworkAssignment(contractId, derived);
      assigned++;
    }

    return {
      contractsEvaluated,
      assigned,
      unchanged,
      unresolved,
      ambiguous,
      macFromCallerId,
      macFromRadiusEvent,
      durationMs: Date.now() - start,
    };
  }
}

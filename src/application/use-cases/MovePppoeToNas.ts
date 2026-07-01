import { PppoeService } from '@domain/entities/pppoeService';
import { NasServer, routesViaOrchestrator } from '@domain/entities/nas';
import { PppoeServiceRepository } from '@domain/ports/PppoeServiceRepository';
import { NasRepository } from '@domain/ports/NasRepository';
import { RadiusOrchestratorGateway } from '@domain/ports/RadiusOrchestratorGateway';
import {
  PppoeNasMoveEventRepository,
  PppoeNasMoveOutcome,
  PppoeNasMoveTrigger,
} from '@domain/ports/PppoeNasMoveEventRepository';
import { ServiceCatalogRepository } from '@domain/ports/ServiceCatalogRepository';
import { ContractServiceEventRepository } from '@domain/ports/ContractServiceEventRepository';
import {
  NasNotFoundError,
  PppoeMoveMixedNasTypesError,
  PppoeServiceNotFoundError,
  PppoeServiceTerminatedError,
} from '@domain/errors/pppoe';
import { NoFreeIpError, NoPoolForNasTypeError } from '@domain/errors/network';
import { FindFreeIp } from './FindFreeIp';
import { MovePppoeServiceToRouter } from './MovePppoeServiceToRouter';

export interface MovePppoeToNasInput {
  id: string;
  nasId: string; // NAS destino
  /** Disparador del move: 'manual' (operador, default) | 'auto' (watcher W2). */
  trigger?: PppoeNasMoveTrigger;
}

export interface MovePppoeToNasActor {
  actorId?: string | null;
  actorName?: string;
}

/**
 * MovePppoeToNas (pppoe-move-nas W1, design D1/D2) — move radius-aware. Subsume al legacy.
 *
 * Rutea por `routesViaOrchestrator(nas.type)`:
 *   - **radius → radius** (los 10 NAS de prod): el secret vive en el RADIUS central → NO hay
 *     create/remove de secrets. Secuencia (plano de control primero, patrón CreatePppoeService):
 *       1. newIp = FindFreeIp(destino, 'cgnat')      ← NoFreeIpError → abort, NADA cambió
 *       2. orchestrator.changeFramedIp(user, newIp)  ← si falla → abort, DB intacta
 *       3. repo.upsert(nasId destino, remoteAddress nueva, ipMode 'fixed')
 *       4. orchestrator.disconnectSessions(user)     ← BEST-EFFORT: si falla, warn (NO revierte)
 *       5. registro doble: PppoeNasMoveEvent + evento historial 'modified' (si hay contrato)
 *   - **legacy → legacy**: delega al flujo pre-HA intacto (`MovePppoeServiceToRouter`:
 *     create destino → remove origen → DB). La IP NO se reasigna (comportamiento histórico).
 *   - **mixto radius↔legacy**: `PppoeMoveMixedNasTypesError` sin tocar nada (REQ-MOVE-3).
 *
 * REQ-LOG-1: todo intento persiste un PppoeNasMoveEvent (`moved` | `failed_no_free_ip` |
 * `failed_orchestrator`) — best-effort: el log NUNCA tumba el move ni enmascara el error original.
 *
 * Depende SOLO de ports + colaboradores de application (FindFreeIp, legacy move). Cero infra.
 */
export class MovePppoeToNas {
  constructor(
    private readonly repo: PppoeServiceRepository,
    private readonly nasRepo: NasRepository,
    private readonly orchestrator: RadiusOrchestratorGateway,
    private readonly findFreeIp: FindFreeIp,
    private readonly legacyMove: MovePppoeServiceToRouter,
    private readonly moveEventRepo: PppoeNasMoveEventRepository,
    private readonly catalogRepo: ServiceCatalogRepository,
    private readonly eventRepo: ContractServiceEventRepository,
  ) {}

  async execute(input: MovePppoeToNasInput, actor?: MovePppoeToNasActor): Promise<PppoeService> {
    const s = await this.repo.findById(input.id);
    if (!s) throw new PppoeServiceNotFoundError(input.id);
    // Baja HARD: el usuario ya no existe en el RADIUS — la fila es una lápida, no hay qué mover.
    if (s.status === 'terminated') throw new PppoeServiceTerminatedError(input.id);
    if (input.nasId === s.nasId) return s; // S1.2 — no-op: ni RADIUS ni DB ni eventos

    const destino = await this.nasRepo.findNasServerById(input.nasId);
    if (!destino) throw new NasNotFoundError(input.nasId);
    const origen = await this.nasRepo.findNasServerById(s.nasId);

    const destinoRadius = routesViaOrchestrator(destino.type);
    // Mixto radius↔legacy → error tipado, nada cambió (S3.3). Si el NAS origen ya no está en el
    // inventario, se rutea por el destino (para radius el origen es irrelevante: secret central).
    if (origen && routesViaOrchestrator(origen.type) !== destinoRadius) {
      throw new PppoeMoveMixedNasTypesError(origen.type, destino.type);
    }

    const trigger = input.trigger ?? 'manual';

    if (!destinoRadius) {
      return this.moveLegacy(s, origen, destino, trigger, actor);
    }
    return this.moveRadius(s, origen, destino, trigger, actor);
  }

  /** Rama radius → radius: reasignar IP CGNAT del destino + kick (design D2). */
  private async moveRadius(
    s: PppoeService,
    origen: NasServer | null,
    destino: NasServer,
    trigger: PppoeNasMoveTrigger,
    actor?: MovePppoeToNasActor,
  ): Promise<PppoeService> {
    // 1. IP nueva del pool CGNAT del destino. Pool lleno/inexistente → abort ANTES de tocar nada (S1.3).
    let newIp: string;
    try {
      newIp = await this.findFreeIp.execute({ nasId: destino.id, type: 'cgnat' });
    } catch (err) {
      if (err instanceof NoFreeIpError || err instanceof NoPoolForNasTypeError) {
        await this.recordMoveEvent(s, origen, destino, s.remoteAddress, null, trigger, 'failed_no_free_ip', err.code, actor);
      }
      throw err;
    }

    // 2. Plano de control PRIMERO (patrón CreatePppoeService): si el RADIUS no confirma, la DB no miente (S1.4).
    try {
      await this.orchestrator.changeFramedIp(s.username, newIp);
    } catch (err) {
      await this.recordMoveEvent(s, origen, destino, s.remoteAddress, newIp, trigger, 'failed_orchestrator',
        err instanceof Error ? err.message : String(err), actor);
      throw err;
    }

    // 3. Confirmar en DB: NAS destino + IP nueva FIJA. Preserva el resto (password/profile/status/
    //    contractId/enforcedState). ipMode='fixed': la IP del move es estática por requisito operativo.
    const updated = await this.repo.upsertByUsername({
      username:      s.username,
      password:      s.password,
      profile:       s.profile,
      remoteAddress: newIp,
      status:        s.status,
      nasId:         destino.id,
      contractId:    s.contractId,
      enforcedState: s.enforcedState,
      ipMode:        'fixed',
    });

    // 4. Kick BEST-EFFORT (REQ-MOVE-2): fuerza la re-auth con la IP nueva. Si el CoA-Disconnect
    //    falla (NAS viejo muerto), el cliente converge solo por keepalive/re-auth — NO se revierte.
    try {
      await this.orchestrator.disconnectSessions(s.username);
    } catch (err) {
      console.warn(
        `[MovePppoeToNas] disconnectSessions('${s.username}') falló (best-effort, el cliente re-conecta por keepalive):`,
        err,
      );
    }

    // 5. Registro doble (design D6): log visible + historial del contrato.
    await this.recordMoveEvent(s, origen, destino, s.remoteAddress, newIp, trigger, 'moved', null, actor);
    await this.recordHistory(s, origen, destino, s.remoteAddress, newIp, trigger, actor);

    return updated;
  }

  /** Rama legacy → legacy: delega al flujo pre-HA intacto (S3.2). La IP no cambia. */
  private async moveLegacy(
    s: PppoeService,
    origen: NasServer | null,
    destino: NasServer,
    trigger: PppoeNasMoveTrigger,
    actor?: MovePppoeToNasActor,
  ): Promise<PppoeService> {
    const moved = await this.legacyMove.execute({ id: s.id, nasId: destino.id });
    await this.recordMoveEvent(s, origen, destino, s.remoteAddress, moved.remoteAddress, trigger, 'moved', null, actor);
    await this.recordHistory(s, origen, destino, s.remoteAddress, moved.remoteAddress, trigger, actor);
    return moved;
  }

  /** REQ-LOG-1 — best-effort: el registro visible NUNCA tumba el move ni enmascara el error original. */
  private async recordMoveEvent(
    s: PppoeService,
    origen: NasServer | null,
    destino: NasServer,
    fromIp: string | null,
    toIp: string | null,
    trigger: PppoeNasMoveTrigger,
    outcome: PppoeNasMoveOutcome,
    reason: string | null,
    actor?: MovePppoeToNasActor,
  ): Promise<void> {
    try {
      await this.moveEventRepo.record({
        username:       s.username,
        pppoeServiceId: s.id,
        fromNasId:      origen?.id ?? s.nasId,
        toNasId:        destino.id,
        fromIp,
        toIp,
        trigger,
        outcome,
        reason,
        actorName:      actor?.actorName ?? (trigger === 'auto' ? 'sistema' : null),
      });
    } catch (err) {
      console.warn('[MovePppoeToNas] Failed to record PppoeNasMoveEvent (best-effort):', err);
    }
  }

  /**
   * REQ-HIST-1 — evento 'modified' (union canónico de 7 tipos que el FE pina con contract test)
   * en el historial del servicio INTERNET del contrato, con detalle from/to NAS+IP y actor.
   * Best-effort (patrón CreatePppoeService). Huérfanos: log estructurado.
   */
  private async recordHistory(
    s: PppoeService,
    origen: NasServer | null,
    destino: NasServer,
    fromIp: string | null,
    toIp: string | null,
    trigger: PppoeNasMoveTrigger,
    actor?: MovePppoeToNasActor,
  ): Promise<void> {
    if (s.contractId == null) {
      console.warn(
        `[MovePppoeToNas] move de '${s.username}' sin contrato (huérfano) — sin evento de historial (queda en PppoeNasMoveEvent)`,
      );
      return;
    }
    try {
      const catalog = await this.catalogRepo.getByName('INTERNET');
      if (!catalog) {
        console.warn(`[MovePppoeToNas] catálogo INTERNET no disponible — evento de historial omitido (contractId=${s.contractId})`);
        return;
      }
      await this.eventRepo.record({
        contractId:       s.contractId,
        serviceCatalogId: catalog.id,
        eventType:        'modified',
        actorId:          actor?.actorId ?? null,
        actorName:        actor?.actorName ?? (trigger === 'auto' ? 'sistema' : ''),
        reason:           null,
        notes:            `Movido de NAS ${origen?.name ?? s.nasId} (${fromIp ?? '—'}) → ${destino.name} (${toIp ?? '—'}) [${trigger}]`,
      });
    } catch (err) {
      console.warn('[MovePppoeToNas] Failed to record modified event (best-effort):', err);
    }
  }
}

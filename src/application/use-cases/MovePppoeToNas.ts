import { PppoeService } from '@domain/entities/pppoeService';
import { NasServer, routesViaOrchestrator } from '@domain/entities/nas';
import { PppoeServiceRepository } from '@domain/ports/PppoeServiceRepository';
import { NasRepository } from '@domain/ports/NasRepository';
import { IpNetworkRepository } from '@domain/ports/IpNetworkRepository';
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
  OrchestratorRejectedError,
  OrchestratorUnreachableError,
  PppoeConcurrentAdoptionError,
  PppoeMoveMixedNasTypesError,
  PppoeMovePublicIpError,
  PppoePendingLegacyNasError,
  PppoeServiceNotFoundError,
  PppoeServiceTerminatedError,
} from '@domain/errors/pppoe';
import { NoFreeIpError, NoPoolForNasTypeError } from '@domain/errors/network';
import { ipInAnyRange } from '@domain/services/ipMath';
import { isDuplicateAutoEvent } from '@application/services/pppoeNasMoveThrottle';
import { FindFreeIp } from './FindFreeIp';
import { MovePppoeServiceToRouter } from './MovePppoeServiceToRouter';

export interface MovePppoeToNasInput {
  id: string;
  nasId: string; // NAS destino
  /** Disparador del move: 'manual' (operador, default) | 'auto' (watcher W2). */
  trigger?: PppoeNasMoveTrigger;
  /**
   * fix waves 1+mini (ajustes 6+9 / S1.5, FAIL-CLOSED): mover un servicio cuya IP ACTUAL no es
   * clasificable como CGNAT (cae en pool `public` O fuera de TODO pool cargado) exige
   * `force: true` (decisión explícita — mover a CGNAT libera la IP actual, que puede ser una
   * pública contratada aunque su pool no esté cargado en Prominense).
   */
  force?: boolean;
}

export interface MovePppoeToNasActor {
  actorId?: string | null;
  actorName?: string;
}

/**
 * Ajuste 8b: actorName vacío/blanco → null. La ruta manda `req.user?.username ?? ''` — con
 * string vacío el `?? fallback` de los registros NUNCA aplicaba (ni el null del move event
 * ni el 'sistema' del auto-move).
 */
function normalizeActorName(actor?: MovePppoeToNasActor): string | null {
  const name = actor?.actorName;
  return name && name.trim() !== '' ? name : null;
}

/**
 * MovePppoeToNas (pppoe-move-nas W1, design D1/D2) — move radius-aware. Subsume al legacy.
 *
 * Rutea por `routesViaOrchestrator(nas.type)`:
 *   - **radius → radius** (los 10 NAS de prod): el secret vive en el RADIUS central → NO hay
 *     create/remove de secrets. Secuencia (plano de control primero, patrón CreatePppoeService):
 *       0. guard IP no-CGNAT FAIL-CLOSED (S1.5): IP actual NO clasificada en pool `cgnat`
 *          (pública o fuera de todo pool) sin `force: true` → 409, nada cambió
 *       1. newIp = FindFreeIp(destino, 'cgnat')      ← NoFreeIpError → abort, NADA cambió
 *       2. orchestrator.changeFramedIp(user, newIp)  ← guard AUTORITATIVO de colisiones (S1.6):
 *          rechazo 409 (FramedIpAlreadyAssigned) → UN retry con FindFreeIp fresco; 2º rechazo → abort
 *       3. repo.setNasAndIp(id, destino, IP nueva, 'fixed')  ← update NO-creador (S1.7); si la DB
 *          falla acá → evento `failed_db` + propaga (S1.8: la divergencia RADIUS↔DB deja rastro)
 *       4. orchestrator.disconnectSessions(user)     ← BEST-EFFORT: si falla, el evento moved
 *          lleva reason='kick_failed' (NO revierte)
 *       5. registro doble: PppoeNasMoveEvent + evento historial 'modified' (si hay contrato)
 *   - **legacy → legacy**: delega al flujo pre-HA intacto (`MovePppoeServiceToRouter`:
 *     create destino → remove origen → DB). La IP NO se reasigna (comportamiento histórico).
 *     Si falla → evento `failed_router` + propaga.
 *   - **mixto radius↔legacy**: `PppoeMoveMixedNasTypesError` sin tocar nada (REQ-MOVE-3).
 *
 * REQ-LOG-1 (ampliado fix wave 1): todo intento que LLEGA a la fase de asignación persiste un
 * PppoeNasMoveEvent (`moved` | `failed_no_free_ip` | `failed_orchestrator` | `failed_db` |
 * `failed_router`) — best-effort: el log NUNCA tumba el move ni enmascara el error original.
 * Los RECHAZOS de guard de input (no-op, mixto, terminated, pública-sin-force) responden 4xx
 * directo y NO persisten fila.
 *
 * Depende SOLO de ports + colaboradores de application (FindFreeIp, legacy move). Cero infra.
 */
export class MovePppoeToNas {
  private readonly now: () => Date;

  constructor(
    private readonly repo: PppoeServiceRepository,
    private readonly nasRepo: NasRepository,
    private readonly orchestrator: RadiusOrchestratorGateway,
    private readonly findFreeIp: FindFreeIp,
    private readonly legacyMove: MovePppoeServiceToRouter,
    private readonly moveEventRepo: PppoeNasMoveEventRepository,
    private readonly catalogRepo: ServiceCatalogRepository,
    private readonly eventRepo: ContractServiceEventRepository,
    /** ajuste 6: clasifica la IP actual contra los pools cargados (guard de IP pública). */
    private readonly networkRepo: IpNetworkRepository,
    /**
     * pppoe-preprovision (fix colateral, patrón AutoMovePppoe): reloj inyectable para el check
     * del throttle de registro. Antes el core usaba SIEMPRE Date.now() — con fixtures de reloj
     * congelado la ventana de 6h "expiraba" según la hora REAL de la corrida (test time-bomb).
     * En prod no cambia nada (default reloj real).
     */
    now?: () => Date,
  ) {
    this.now = now ?? (() => new Date());
  }

  async execute(input: MovePppoeToNasInput, actor?: MovePppoeToNasActor): Promise<PppoeService> {
    const s = await this.repo.findById(input.id);
    if (!s) throw new PppoeServiceNotFoundError(input.id);
    // S1.2 — no-op ANTES de cualquier otro guard (fix wave 1, ajuste 8a): mover al MISMO NAS no
    // es una operación — ni siquiera sobre una lápida terminated (no merece un 409).
    if (input.nasId === s.nasId) return s;
    // Baja HARD: el usuario ya no existe en el RADIUS — la fila es una lápida, no hay qué mover.
    if (s.status === 'terminated') throw new PppoeServiceTerminatedError(input.id);

    const destino = await this.nasRepo.findNasServerById(input.nasId);
    if (!destino) throw new NasNotFoundError(input.nasId);
    // pppoe-preprovision (D1): origen null también cuando el servicio está PENDIENTE de
    // instalación (nasId null) — mover un pendiente = ADOPCIÓN (manual o del watcher).
    const origen = s.nasId !== null ? await this.nasRepo.findNasServerById(s.nasId) : null;

    const destinoRadius = routesViaOrchestrator(destino.type);
    // Mixto radius↔legacy → error tipado, nada cambió (S3.3). Si el NAS origen ya no está en el
    // inventario, se rutea por el destino (para radius el origen es irrelevante: secret central).
    if (origen && routesViaOrchestrator(origen.type) !== destinoRadius) {
      throw new PppoeMoveMixedNasTypesError(origen.type, destino.type);
    }

    const trigger = input.trigger ?? 'manual';

    if (!destinoRadius) {
      // pppoe-preprovision D6.5: un PENDIENTE (nasId null) vive en el RADIUS central — el flujo
      // legacy lo "adoptaría" copiando el secret al router SIN IP (ignorando la preferencia) y
      // dejando el usuario fantasma en el RADIUS. Error tipado ANTES de tocar nada. Guard de
      // bomba latente: hoy no hay NAS legacy en prod. Guard de INPUT: 4xx directo, SIN fila.
      if (s.nasId === null) throw new PppoePendingLegacyNasError(s.id, destino.type);
      return this.moveLegacy(s, origen, destino, trigger, actor);
    }
    return this.moveRadius(s, origen, destino, trigger, input.force ?? false, actor);
  }

  /** Rama radius → radius: reasignar IP CGNAT del destino + kick (design D2 + fix wave 1). */
  private async moveRadius(
    s: PppoeService,
    origen: NasServer | null,
    destino: NasServer,
    trigger: PppoeNasMoveTrigger,
    force: boolean,
    actor?: MovePppoeToNasActor,
  ): Promise<PppoeService> {
    // 0. Guard FAIL-CLOSED de IP no-CGNAT (ajustes 6+9 / S1.5): mover a CGNAT libera la IP
    //    actual — no puede pasar por accidente. Solo una IP clasificada POSITIVAMENTE como
    //    cgnat pasa sin force; pública O fuera de todo pool cargado exige force (en prod solo
    //    3 NAS tienen pools públicos cargados — fail-open desprotegía al resto). Servicio SIN
    //    IP actual → no hay IP que perder, no exige force. Guard de INPUT: 4xx directo, SIN
    //    fila de evento (REQ-LOG-1).
    if (!force && s.remoteAddress) {
      const cgnatPools = (await this.networkRepo.findAllPools()).filter((p) => p.ipKind === 'cgnat');
      if (!ipInAnyRange(s.remoteAddress, cgnatPools)) {
        throw new PppoeMovePublicIpError(s.id, s.remoteAddress);
      }
    }

    // pppoe-preprovision (D4/S4.3): mover un PENDIENTE (nasId null) = ADOPCIÓN — la IP sale del
    // pool del `ipTypePreference` PERSISTIDO (la preferencia manda el pool). Un move NORMAL
    // sigue asignando SIEMPRE cgnat (semántica W1 intacta: cgnat + force para no-cgnat).
    const esAdopcion = s.nasId === null;
    const poolType = esAdopcion ? s.ipTypePreference : 'cgnat';

    // 1. IP nueva del pool del destino. Pool lleno/inexistente → abort ANTES de tocar nada (S1.3);
    //    'public' en NAS sin pool público (adopción) → NoPoolForNasTypeError → failed_no_free_ip.
    let newIp = await this.allocateFreeIp(s, origen, destino, trigger, poolType, actor);

    // 2. Plano de control PRIMERO (patrón CreatePppoeService): si el RADIUS no confirma, la DB no
    //    miente (S1.4). El orchestrator es además el guard AUTORITATIVO de colisiones de Framed-IP
    //    (ajuste 2 / S1.6, verificado en user_management_service.py:203-218): si otro move tomó la
    //    IP entre el snapshot y la escritura, rechaza con 409 → UN retry con FindFreeIp fresco
    //    (el snapshot nuevo ya ve la IP tomada). Un 2º rechazo → failed_orchestrator + propagar.
    try {
      await this.orchestrator.changeFramedIp(s.username, newIp);
    } catch (err) {
      if (!(err instanceof OrchestratorRejectedError) || err.upstreamStatus !== 409) {
        await this.recordMoveEvent(s, origen, destino, s.remoteAddress, newIp, trigger, 'failed_orchestrator',
          err instanceof Error ? err.message : String(err), actor);
        throw err;
      }
      newIp = await this.allocateFreeIp(s, origen, destino, trigger, poolType, actor);
      try {
        await this.orchestrator.changeFramedIp(s.username, newIp);
      } catch (retryErr) {
        await this.recordMoveEvent(s, origen, destino, s.remoteAddress, newIp, trigger, 'failed_orchestrator',
          retryErr instanceof Error ? retryErr.message : String(retryErr), actor);
        throw retryErr;
      }
    }

    // 3. Confirmar en DB: NAS destino + IP nueva FIJA, con update NO-creador por id (ajuste 3 /
    //    S1.7 — anti-resurrección: upsertByUsername re-INSERTABA la fila si un terminate/rename
    //    concurrente la borró entre la lectura y acá). Preserva password/profile/status/
    //    contractId/enforcedState. ipMode='fixed': la IP del move es estática por requisito operativo.
    //    D7.3: la ADOPCIÓN pasa expectedNasId=null → update CONDICIONAL (WHERE nasId IS NULL):
    //    el perdedor de la carrera doble-adopción matchea 0 filas y NO pisa al ganador (cierra
    //    el lado DB por completo; el post-persist check de D6.4 queda como segunda red).
    let updated: PppoeService | null;
    try {
      updated = await this.repo.setNasAndIp(s.id, destino.id, newIp, 'fixed', esAdopcion ? null : undefined);
    } catch (err) {
      // Ajuste 4 / S1.8: el RADIUS YA quedó escrito — sin este evento la divergencia RADIUS↔DB
      // sería invisible (el watcher W2 NO la cura: compara sesión vs nasId, no la Framed-IP).
      await this.recordMoveEvent(s, origen, destino, s.remoteAddress, newIp, trigger, 'failed_db',
        'db_update_failed_after_radius_write', actor);
      throw err;
    }
    if (!updated) {
      // D7.3 — con expectedNasId=null el `null` es ambiguo: fila BORRADA (terminate concurrente)
      // o condición sin match (OTRO actor adoptó primero). Se distingue re-leyendo por id.
      // (Si esta re-lectura lanza —hiccup de DB inmediatamente después de un update limpio,
      // secuencia rarísima— el error propaga crudo: el caller lo ve como fallo del move.)
      if (esAdopcion && (await this.repo.findById(s.id))) {
        // Carrera DOBLE-ADOPCIÓN perdida (tick del watcher vs adopción manual del MISMO
        // pendiente): la fila del GANADOR queda intacta — nada se pisó. El RADIUS pudo quedar
        // con NUESTRA Framed-IP (la última escritura gana). DECISIÓN D7.3: SIN auto-heal,
        // consistente con D6.4 (misma carrera sub-segundo, mismo trato): una escritura
        // compensatoria puede fallar o carrerear a su vez (tercer estado), y el orden real de
        // los writes en el orchestrator es incognoscible desde acá — el evento VISIBLE
        // failed_db es la cue de intervención manual, con la IP escrita en `toIp`.
        console.warn(
          `[MovePppoeToNas] concurrent_adoption_lost_race: '${s.username}' — otro actor adoptó ` +
          `primero (update condicional matcheó 0 filas). RADIUS pudo quedar con ${newIp}; sin auto-heal.`,
        );
        await this.recordMoveEvent(s, origen, destino, s.remoteAddress, newIp, trigger, 'failed_db',
          'concurrent_adoption_lost_race', actor);
        throw new PppoeConcurrentAdoptionError(s.id);
      }
      // Fila borrada por un terminate concurrente (que también limpia el RADIUS por su lado):
      // typed not-found, CERO filas creadas (S1.7). Mini fix wave (ajuste 10): el RADIUS YA
      // quedó escrito acá — evento failed_db best-effort para que la divergencia deje rastro
      // (era el último path divergente invisible).
      await this.recordMoveEvent(s, origen, destino, s.remoteAddress, newIp, trigger, 'failed_db',
        'row_deleted_after_radius_write', actor);
      throw new PppoeServiceNotFoundError(s.id);
    }

    // 3b. pppoe-preprovision D6.4 — verificación post-persist BARATA de la carrera
    //     doble-adopción (tick vs adopción manual del MISMO pendiente): re-leer la fila tras
    //     nuestro setNasAndIp; si trae OTRA remoteAddress, un actor interleaved escribió después
    //     — la Framed-IP del RADIUS (la nuestra o la de él, según el orden en el orchestrator)
    //     diverge de la DB. Evento VISIBLE (failed_db / concurrent_adoption_detected) + WARN,
    //     SIN auto-heal (ventana sub-segundo; intervención manual). Best-effort: el check jamás
    //     tumba el move ya persistido.
    if (esAdopcion) {
      try {
        const reread = await this.repo.findById(s.id);
        if (reread && reread.remoteAddress !== newIp) {
          console.warn(
            `[MovePppoeToNas] concurrent_adoption_detected: '${s.username}' — DB=${reread.remoteAddress} ` +
            `vs RADIUS escrito=${newIp} (otro actor interleaved durante la adopción). Sin auto-heal.`,
          );
          await this.recordMoveEvent(s, origen, destino, s.remoteAddress, newIp, trigger, 'failed_db',
            'concurrent_adoption_detected', actor);
        }
      } catch (err) {
        console.warn('[MovePppoeToNas] post-persist check de adopción falló (best-effort):', err);
      }
    }

    // 4. Kick BEST-EFFORT (REQ-MOVE-2): fuerza la re-auth con la IP nueva. Si el CoA-Disconnect
    //    falla (NAS viejo muerto), el cliente converge solo por keepalive/re-auth — NO se revierte.
    //    Ajuste 7: el fallo deja PISTA (reason='kick_failed' en el evento moved); catch acotado a
    //    los errores esperables del plano de control, el resto se loguea como error (no revierte:
    //    el move ya está persistido).
    let kickFailed = false;
    try {
      await this.orchestrator.disconnectSessions(s.username);
    } catch (err) {
      kickFailed = true;
      if (err instanceof OrchestratorUnreachableError || err instanceof OrchestratorRejectedError) {
        console.warn(
          `[MovePppoeToNas] disconnectSessions('${s.username}') falló (best-effort, el cliente re-conecta por keepalive):`,
          err,
        );
      } else {
        console.error(
          `[MovePppoeToNas] disconnectSessions('${s.username}') error INESPERADO (move ya persistido, no se revierte):`,
          err,
        );
      }
    }

    // 5. Registro doble (design D6): log visible + historial del contrato.
    //    pppoe-preprovision (D4/S3.1): la ADOPCIÓN del watcher lleva reason 'auto_install'
    //    (outcome 'moved' — SIN outcome nuevo, el FE no cambia). Si además falló el kick, la
    //    pista no se pierde: 'auto_install_kick_failed'. La adopción MANUAL registra como un
    //    move normal (fromNas null ya cuenta la historia).
    const movedReason = esAdopcion && trigger === 'auto'
      ? (kickFailed ? 'auto_install_kick_failed' : 'auto_install')
      : (kickFailed ? 'kick_failed' : null);
    await this.recordMoveEvent(s, origen, destino, s.remoteAddress, newIp, trigger, 'moved',
      movedReason, actor);
    await this.recordHistory(s, origen, destino, s.remoteAddress, newIp, trigger, actor);

    return updated;
  }

  /**
   * FindFreeIp con registro VISIBLE del fallo (REQ-LOG-1 ampliado, ajuste 5):
   *   - pool lleno/inexistente → evento `failed_no_free_ip` (S1.3),
   *   - orchestrator caído consultando las IPs asignadas → evento `failed_orchestrator`
   *     reason `list_assigned_ips` (antes ese intento moría sin rastro).
   * En ambos casos PROPAGA — nada se escribió todavía.
   * pppoe-preprovision (D4): `poolType` viene del caller — 'cgnat' para el move normal (W1
   * intacto) o el `ipTypePreference` persistido para la ADOPCIÓN de un pendiente.
   */
  private async allocateFreeIp(
    s: PppoeService,
    origen: NasServer | null,
    destino: NasServer,
    trigger: PppoeNasMoveTrigger,
    poolType: PppoeService['ipTypePreference'],
    actor?: MovePppoeToNasActor,
  ): Promise<string> {
    try {
      return await this.findFreeIp.execute({ nasId: destino.id, type: poolType });
    } catch (err) {
      if (err instanceof NoFreeIpError || err instanceof NoPoolForNasTypeError) {
        await this.recordMoveEvent(s, origen, destino, s.remoteAddress, null, trigger, 'failed_no_free_ip', err.code, actor);
      } else if (err instanceof OrchestratorUnreachableError) {
        await this.recordMoveEvent(s, origen, destino, s.remoteAddress, null, trigger, 'failed_orchestrator', 'list_assigned_ips', actor);
      }
      throw err;
    }
  }

  /** Rama legacy → legacy: delega al flujo pre-HA intacto (S3.2). La IP no cambia. */
  private async moveLegacy(
    s: PppoeService,
    origen: NasServer | null,
    destino: NasServer,
    trigger: PppoeNasMoveTrigger,
    actor?: MovePppoeToNasActor,
  ): Promise<PppoeService> {
    let moved: PppoeService;
    try {
      moved = await this.legacyMove.execute({ id: s.id, nasId: destino.id });
    } catch (err) {
      // Ajuste 5 (REQ-LOG-1): el fallo del flujo legacy (API del router) también deja rastro.
      await this.recordMoveEvent(s, origen, destino, s.remoteAddress, null, trigger, 'failed_router',
        err instanceof Error ? err.message : String(err), actor);
      throw err;
    }
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
      // W2 (D-W2.2 / S10.5) — throttle anti-spam del tab: un `failed_*` del WATCHER (trigger
      // 'auto') idéntico al último evento del username NO genera fila nueva — el intento SÍ
      // ocurre cada tick (pool lleno se reintenta, barato); solo se suprime el registro.
      // Trigger 'manual' NO cambia: cada intento manual registra SIEMPRE. Los 'moved' siempre
      // registran (cambian estado).
      // D-W2.5 item 7 (throttle v2 — ÚNICO cambio de este use case en la fix wave): identidad
      // = outcome + toNasId + REASON, match EXACTO de username (usernameExact, no contains),
      // solo suprime si el último evento es 'auto', y el check es FAIL-OPEN (vive en el helper).
      if (
        trigger === 'auto' &&
        outcome !== 'moved' &&
        (await isDuplicateAutoEvent(this.moveEventRepo, s.username, outcome, destino.id, reason, this.now().getTime()))
      ) {
        return;
      }
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
        // Ajuste 8b: '' se normaliza a null — sin esto el `??` nunca aplica con string vacío
        // (el auto-move quedaba sin 'sistema' y el manual persistía '' en vez de null).
        actorName:      normalizeActorName(actor) ?? (trigger === 'auto' ? 'sistema' : null),
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
        // Ajuste 8b: '' normalizado — el fallback 'sistema' del auto-move SÍ aplica.
        actorName:        normalizeActorName(actor) ?? (trigger === 'auto' ? 'sistema' : ''),
        reason:           null,
        // pppoe-preprovision: origen null + nasId null = adopción de un pendiente de instalación.
        notes:            `Movido de NAS ${origen?.name ?? s.nasId ?? 'sin NAS (pre-provisión)'} (${fromIp ?? '—'}) → ${destino.name} (${toIp ?? '—'}) [${trigger}]`,
      });
    } catch (err) {
      console.warn('[MovePppoeToNas] Failed to record modified event (best-effort):', err);
    }
  }
}

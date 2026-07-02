/**
 * CreatePppoeStandalone — pppoe-full-management (D3) + fix-wave (C2/C2d/W3) + pppoe-preprovision.
 *
 * Crea un PPPoE directamente en el plano de control y guarda la fila espejo.
 * El contrato es OPCIONAL (contractId=null → PPPoE huérfano, asignable después).
 * pppoe-preprovision: el NAS también es OPCIONAL — nasId ausente/null = pre-provisión
 * "pendiente de instalación" (usuario en el RADIUS central SIN Framed-IP; el watcher lo adopta).
 *
 * Flujo CON contractId (C2d):
 *   → Delega a `CreatePppoeService` que tiene Guard #4 + routing + activación + evento
 *     (incluida la rama pre-provisión con nasId null).
 *
 * Flujo SIN contractId (standalone):
 *   1. Verificar unicidad de username en el espejo (PppoeUsernameTakenError si ya existe).
 *   2. pppoe-preprovision: nasId null → orchestrator.createUser(framedIp null) + espejo
 *      {nasId:null, remoteAddress:null, ipMode:'fixed', ipTypePreference} (anti-TOCTOU igual).
 *   3. Con NAS: validar que existe (NasNotFoundError si no) — C2a.
 *   4. Rutear por tipo de NAS — C2b:
 *      - `radius_orchestrator` → orchestrator.createUser (RADIUS HA)
 *        · pppoe-preprovision (S1.4): sin framedIp, sin pool-mode y con allocator inyectado →
 *          FindFreeIp(nas, ipTypePreference) asigna la IP fija server-side.
 *      - resto (mikrotik_api, …) → router.createSecret (RouterOS API)
 *   5. Persistir espejo con createByUsername (W3: falla atómicamente si ya existe → anti-TOCTOU).
 *   6. Devolver la entidad creada.
 *
 * Errores tipados:
 *   - PppoeUsernameTakenError        → 409 (espejo ya tiene ese username)
 *   - NasNotFoundError               → 404 (nasId no existe) — C2a
 *   - OrchestratorRejectedError      → 409 (RADIUS ya tiene ese username; no hay fila espejo)
 *   - OrchestratorUnreachableError   → 502 (sin fila espejo)
 *   - PppoeContractAlreadyHasServiceError → 409 (Guard #4, vía delegate) — C2d
 */
import type { PppoeServiceRepository } from '@domain/ports/PppoeServiceRepository';
import type { RadiusOrchestratorGateway } from '@domain/ports/RadiusOrchestratorGateway';
import type { NasRepository } from '@domain/ports/NasRepository';
import type { PppoeRouterGateway } from '@domain/ports/PppoeRouterGateway';
import type { PppoeService } from '@domain/entities/pppoeService';
import type { IpKind } from '@domain/entities/network';
import { routesViaOrchestrator } from '@domain/entities/nas';
import { PppoeUsernameTakenError, NasNotFoundError } from '@domain/errors/pppoe';
import { toNasTarget } from './nasTarget';
import type { CreatePppoeService } from './CreatePppoeService';
import type { FindFreeIp } from './FindFreeIp';

export interface CreatePppoeStandaloneInput {
  username:   string;
  password:   string;
  plan:       string;
  /** pppoe-preprovision: ausente/null = pre-provisión "pendiente de instalación". */
  nasId?:     string | null;
  framedIp?:  string | null;
  ipMode?:    'fixed' | 'pool';
  contractId?: string;
  /** pppoe-preprovision (D2): tipo de IP elegido. El wire lo exige; default 'cgnat' para callers legacy. */
  ipTypePreference?: IpKind;
}

export class CreatePppoeStandalone {
  constructor(
    private readonly pppoeRepo: PppoeServiceRepository,
    private readonly orchestrator: RadiusOrchestratorGateway,
    private readonly nasRepo: NasRepository,
    /**
     * C2b: gateway hacia el router MikroTik (RouterOS API). Necesario para NAS de tipo
     * `mikrotik_api`. Opcional para backward-compat con callers que solo usan RADIUS.
     */
    private readonly router?: PppoeRouterGateway,
    /**
     * C2d: delegate a CreatePppoeService cuando viene contractId. Maneja Guard #4 +
     * routing + activación de internet + registro del evento 'activated'.
     * Recomendación fuerte: no duplicar esa lógica acá — delegar al caso de uso que
     * ya la tiene correcta y testeada.
     */
    private readonly createPppoeServiceDelegate?: CreatePppoeService,
    /**
     * pppoe-preprovision (S1.4): allocator server-side del alta (mismo que CreatePppoeService).
     * Opcional para back-compat; en prod SIEMPRE viene wired (composition test).
     */
    private readonly findFreeIp?: FindFreeIp,
  ) {}

  /**
   * W3 fix: acepta `actor` opcional y lo forwardea al delegate cuando hay contractId.
   * Sin actor el evento 'activated' queda con actorName='' (comportamiento legacy).
   */
  async execute(
    input: CreatePppoeStandaloneInput,
    actor?: { actorId?: string | null; actorName?: string },
  ): Promise<PppoeService> {
    const { username, password, plan, framedIp, ipMode, contractId } = input;
    const nasId = input.nasId ?? null;
    const ipTypePreference: IpKind = input.ipTypePreference ?? 'cgnat';

    // ── Camino CON contractId: delegar a CreatePppoeService ──────────────────
    // Guard #4 + routing + ensureInternet + evento 'activated' ya están implementados
    // y testeados en CreatePppoeService (incluida la rama pre-provisión). No duplicar lógica.
    if (contractId) {
      if (!this.createPppoeServiceDelegate) {
        throw new Error(
          '[CreatePppoeStandalone] Se requiere CreatePppoeService delegate para procesar contractId. ' +
          'Asegurá de pasarlo en el constructor al ensamblar el módulo.',
        );
      }
      return this.createPppoeServiceDelegate.execute({
        contractId,
        username,
        password,
        profile: plan,
        remoteAddress: framedIp ?? null,
        nasId,
        ipTypePreference,
      }, actor);
    }

    // ── Camino SIN contractId (standalone / huérfano) ────────────────────────

    // 1. Unicidad en el espejo: fail-fast antes de tocar el plano de control.
    const existing = await this.pppoeRepo.findByUsername(username);
    if (existing) {
      throw new PppoeUsernameTakenError(username);
    }

    // 1b. pppoe-preprovision: SIN NAS = pre-provisión huérfana. RADIUS central sin Framed-IP;
    //     espejo pendiente de instalación (nasId null). El create es anti-TOCTOU igual (W3).
    if (nasId === null) {
      await this.orchestrator.createUser({ username, password, plan, framedIp: null });
      return this.pppoeRepo.createByUsername({
        username,
        password,
        profile:       plan,
        remoteAddress: null,
        ipMode:        'fixed',
        nasId:         null,
        contractId:    null,
        ipTypePreference,
      });
    }

    // 2. C2a — Validar que el NAS existe.
    const nas = await this.nasRepo.findNasServerById(nasId);
    if (!nas) throw new NasNotFoundError(nasId);

    // 3. C2b — Rutear por tipo de NAS.
    const isRadius = routesViaOrchestrator(nas.type);

    let resolvedFramedIp = framedIp ?? null;

    if (isRadius) {
      // pppoe-preprovision (S1.4): sin framedIp pedido, sin pool-mode (poolName null), sin
      // ipMode 'pool' explícito y con el allocator inyectado → IP fija server-side del pool
      // del tipo elegido. La rama pool-mode y el framedIp explícito quedan intactos.
      if (
        resolvedFramedIp == null &&
        ipMode !== 'pool' &&
        nas.poolName == null &&
        this.findFreeIp
      ) {
        resolvedFramedIp = await this.findFreeIp.execute({ nasId: nas.id, type: ipTypePreference });
      }

      // RADIUS HA (radius_orchestrator): crear via orchestrator.
      await this.orchestrator.createUser({
        username,
        password,
        plan,
        framedIp: resolvedFramedIp,
      });
    } else {
      // MikroTik API (mikrotik_api) u otro: crear via router RouterOS.
      if (!this.router) {
        throw new Error(
          `[CreatePppoeStandalone] PppoeRouterGateway requerido para NAS type '${nas.type}' pero no fue provisto.`,
        );
      }
      await this.router.createSecret(toNasTarget(nas), {
        username,
        password,
        profile: plan,
        remoteAddress: resolvedFramedIp,
      });
    }

    // 4. W3 — Persistir espejo con createByUsername (strict create, anti-TOCTOU).
    //    Si entre el check (paso 1) y acá otro request insertó el mismo username,
    //    createByUsername lanza PppoeUsernameTakenError en vez de pisar silenciosamente.
    const resolvedIpMode = ipMode ?? (resolvedFramedIp ? 'fixed' : 'pool');

    return this.pppoeRepo.createByUsername({
      username,
      password,
      profile:       plan,
      remoteAddress: resolvedFramedIp,
      ipMode:        resolvedIpMode,
      nasId,
      contractId:    null,
      ipTypePreference,
    });
  }
}

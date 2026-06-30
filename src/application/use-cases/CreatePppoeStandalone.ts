/**
 * CreatePppoeStandalone — pppoe-full-management (D3) + fix-wave (C2/C2d/W3).
 *
 * Crea un PPPoE directamente en el plano de control y guarda la fila espejo.
 * El contrato es OPCIONAL (contractId=null → PPPoE huérfano, asignable después).
 *
 * Flujo CON contractId (C2d):
 *   → Delega a `CreatePppoeService` que tiene Guard #4 + routing + activación + evento.
 *     El camino "con contractId" es idéntico al de POST /contracts/:id/pppoe — no se duplica.
 *
 * Flujo SIN contractId (standalone):
 *   1. Verificar unicidad de username en el espejo (PppoeUsernameTakenError si ya existe).
 *   2. Validar que el NAS existe (NasNotFoundError si no) — C2a.
 *   3. Rutear por tipo de NAS — C2b:
 *      - `radius_orchestrator` → orchestrator.createUser (RADIUS HA)
 *      - resto (mikrotik_api, …) → router.createSecret (RouterOS API)
 *   4. Persistir espejo con createByUsername (W3: falla atómicamente si ya existe → anti-TOCTOU).
 *   5. Devolver la entidad creada.
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
import { routesViaOrchestrator } from '@domain/entities/nas';
import { PppoeUsernameTakenError, NasNotFoundError } from '@domain/errors/pppoe';
import { toNasTarget } from './nasTarget';
import type { CreatePppoeService } from './CreatePppoeService';

export interface CreatePppoeStandaloneInput {
  username:   string;
  password:   string;
  plan:       string;
  nasId:      string;
  framedIp?:  string | null;
  ipMode?:    'fixed' | 'pool';
  contractId?: string;
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
  ) {}

  /**
   * W3 fix: acepta `actor` opcional y lo forwardea al delegate cuando hay contractId.
   * Sin actor el evento 'activated' queda con actorName='' (comportamiento legacy).
   */
  async execute(
    input: CreatePppoeStandaloneInput,
    actor?: { actorId?: string | null; actorName?: string },
  ): Promise<PppoeService> {
    const { username, password, plan, nasId, framedIp, ipMode, contractId } = input;

    // ── Camino CON contractId: delegar a CreatePppoeService ──────────────────
    // Guard #4 + routing + ensureInternet + evento 'activated' ya están implementados
    // y testeados en CreatePppoeService. No duplicar lógica.
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
      }, actor);
    }

    // ── Camino SIN contractId (standalone / huérfano) ────────────────────────

    // 1. Unicidad en el espejo: fail-fast antes de tocar el plano de control.
    const existing = await this.pppoeRepo.findByUsername(username);
    if (existing) {
      throw new PppoeUsernameTakenError(username);
    }

    // 2. C2a — Validar que el NAS existe.
    const nas = await this.nasRepo.findNasServerById(nasId);
    if (!nas) throw new NasNotFoundError(nasId);

    // 3. C2b — Rutear por tipo de NAS.
    const isRadius = routesViaOrchestrator(nas.type);

    if (isRadius) {
      // RADIUS HA (radius_orchestrator): crear via orchestrator.
      await this.orchestrator.createUser({
        username,
        password,
        plan,
        framedIp: framedIp ?? null,
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
        remoteAddress: framedIp ?? null,
      });
    }

    // 4. W3 — Persistir espejo con createByUsername (strict create, anti-TOCTOU).
    //    Si entre el check (paso 1) y acá otro request insertó el mismo username,
    //    createByUsername lanza PppoeUsernameTakenError en vez de pisar silenciosamente.
    const resolvedIpMode = ipMode ?? (framedIp ? 'fixed' : 'pool');

    return this.pppoeRepo.createByUsername({
      username,
      password,
      profile:       plan,
      remoteAddress: framedIp ?? null,
      ipMode:        resolvedIpMode,
      nasId,
      contractId:    null,
    });
  }
}

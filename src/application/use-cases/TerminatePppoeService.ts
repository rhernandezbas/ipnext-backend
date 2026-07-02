import { PppoeService } from '@domain/entities/pppoeService';
import { PppoeServiceRepository } from '@domain/ports/PppoeServiceRepository';
import { PppoeRouterGateway } from '@domain/ports/PppoeRouterGateway';
import { NasRepository } from '@domain/ports/NasRepository';
import { RadiusOrchestratorGateway } from '@domain/ports/RadiusOrchestratorGateway';
import { NasNotFoundError, PppoeServiceNotFoundError, OrchestratorRejectedError } from '@domain/errors/pppoe';
import { routesViaOrchestrator } from '@domain/entities/nas';
import { EnsureInternetContractService, EnsureInternetOpts } from './EnsureInternetContractService';
import { toNasTarget } from './nasTarget';

/**
 * Baja HARD: elimina el usuario del RADIUS (libera la IP) y borra la fila de la DB.
 * El username queda libre para ser re-ingresado en el futuro sin conflictos.
 *
 * Ruteado por `nas.type`:
 *   - `radius_orchestrator` → `orchestrator.deleteUser` (borra radcheck + radusergroup + radreply
 *     Framed-IP). Después, best-effort `orchestrator.disconnectSessions` (kick de la sesión viva).
 *   - resto (`mikrotik_api`, …) → `router.removeSecret` (`/ppp secret remove`), como siempre.
 *
 * Post-baja: si el PPPoE tenía contractId, llama ensureInternet(contractId, false) best-effort
 * para inactivar la línea INTERNET del contrato y registrar el evento con el motivo.
 */
export class TerminatePppoeService {
  constructor(
    private readonly repo: PppoeServiceRepository,
    private readonly orchestrator: RadiusOrchestratorGateway,
    private readonly router: PppoeRouterGateway,
    private readonly nasRepo: NasRepository,
    private readonly ensureInternet: EnsureInternetContractService,
  ) {}

  async execute(id: string, opts?: EnsureInternetOpts): Promise<PppoeService> {
    const s = await this.repo.findById(id);
    if (!s) throw new PppoeServiceNotFoundError(id);
    // pppoe-preprovision (REQ-PRE-4): un PENDIENTE de instalación (nasId null) SÍ se puede dar
    // de baja — el usuario vive en el RADIUS central (lo creó la pre-provisión), no necesita
    // NAS. Es el escape de limpieza de una pre-provisión equivocada/no instalada.
    const nas = s.nasId !== null ? await this.nasRepo.findNasServerById(s.nasId) : null;
    if (s.nasId !== null && !nas) throw new NasNotFoundError(s.nasId);

    if (nas === null || routesViaOrchestrator(nas.type)) {
      // deleteUser lanza OrchestratorUnreachableError si el orchestrator no responde → 502.
      // La DB NO se toca hasta que el plano de control confirma.
      // IDEMPOTENTE: si el user ya no existe en RADIUS (404) la baja ya está hecha — seguimos
      // a confirmar el estado en la DB. Cualquier OTRO error (502 inalcanzable, otro 4xx) se
      // propaga: red-first, no marcar 'terminated' si el orchestrator no confirmó la baja.
      try {
        await this.orchestrator.deleteUser(s.username);
      } catch (err) {
        if (!(err instanceof OrchestratorRejectedError && err.upstreamStatus === 404)) throw err;
      }

      // Best-effort: kickear la sesión live (CoA-Disconnect). Si no hay sesión activa o el
      // orchestrator falla el kick, la baja ya fue realizada en el RADIUS — no abortar.
      try {
        await this.orchestrator.disconnectSessions(s.username);
      } catch (err) {
        console.warn('[TerminatePppoeService] disconnectSessions best-effort falló:', err);
      }
    } else {
      await this.router.removeSecret(toNasTarget(nas), s.username);
    }

    // Borrado HARD: el username queda libre (ingest lo puede crear de cero en el futuro).
    await this.repo.deleteById(s.id);

    // Best-effort: inactivar la línea INTERNET si el PPPoE tenía un contrato.
    if (s.contractId != null) {
      try {
        await this.ensureInternet.execute(s.contractId, false, opts);
      } catch (err) {
        console.warn('[TerminatePppoeService] ensureInternet(false) falló (best-effort):', err);
      }
    }

    return s;
  }
}

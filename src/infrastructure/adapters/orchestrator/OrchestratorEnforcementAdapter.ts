import { EnforcementGateway } from '@domain/ports/EnforcementGateway';
import { PppoeService, EnforcementAction } from '@domain/entities/pppoeService';
import { NasServer } from '@domain/entities/nas';
import { RadiusOrchestratorGateway } from '@domain/ports/RadiusOrchestratorGateway';

/**
 * OrchestratorEnforcementAdapter — corte vía RADIUS detrás del `EnforcementGateway`.
 *
 * Para los NAS ya cutoveados al RADIUS HA (`nas.type === 'radius_orchestrator'`). Traduce la acción de
 * corte a las llamadas del radius-orchestrator (que internamente hace el modelo de grupos GR + CoA):
 *
 *   reduce  → changePlan(reducedPlan, applyInSession)   (DEUDORES → IP-REDUCCION; capado, sigue online)
 *   block   → suspend({disconnectActiveSessions})       (ELIMINADOS → Auth-Type Reject + kick)
 *   restore → reactivate / changePlan(<comercial>)      (según de dónde venimos; respeta baja comercial)
 *
 * El plan COMERCIAL lo recuerda la DB (`PppoeService.profile`), igual que en MK-directo → restore
 * lo devuelve. `restore` RESPETA la baja COMERCIAL: si `status === 'disabled'`, NO reactiva (deja
 * suspendido). El orchestrator caído → `OrchestratorUnreachableError`: el use case NO confirma en DB.
 */
export class OrchestratorEnforcementAdapter implements EnforcementGateway {
  constructor(
    private readonly orch: RadiusOrchestratorGateway,
    private readonly reducedPlan: string,
  ) {}

  async apply(pppoe: PppoeService, _nas: NasServer, action: EnforcementAction): Promise<void> {
    switch (action) {
      case 'reduce':
        await this.orch.changePlan(pppoe.username, this.reducedPlan, { applyInSession: true });
        return;

      case 'block':
        await this.orch.suspend(pppoe.username, { disconnectActiveSessions: true });
        return;

      case 'restore':
        // Baja COMERCIAL manda: aunque se levante el enforcement, un secret comercialmente dado de
        // baja queda suspendido (rechazado), igual que MK-directo lo deja disabled.
        if (pppoe.status === 'disabled') {
          await this.orch.suspend(pppoe.username, { disconnectActiveSessions: true });
          return;
        }
        // Deshacer según el estado del que venimos (el use case llama restore solo si NO está active).
        if (pppoe.enforcedState === 'blocked') {
          await this.orch.reactivate(pppoe.username);
        } else if (pppoe.enforcedState === 'reduced' && pppoe.profile) {
          await this.orch.changePlan(pppoe.username, pppoe.profile, { applyInSession: true });
        }
        return;
    }
  }
}

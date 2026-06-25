import { PppoeService, EnforcementAction } from '@domain/entities/pppoeService';
import { NasServer } from '@domain/entities/nas';

/**
 * EnforcementGateway — puerto del CÓMO se ejecuta un corte sobre un PPPoE.
 *
 * El use case `EnforcePppoeService` decide QUÉ (idempotencia, estado destino, confirm en DB)
 * y delega el CÓMO en este puerto. Dos implementaciones:
 *   - `RouterOsEnforcementAdapter` (Inc1) — MK-directo: cambia el `/ppp secret` + kick. Es el
 *     camino VIVO para el ~97% de la red que hoy autentica contra `/ppp secret` local.
 *   - `OrchestratorEnforcementAdapter` (Inc3) — RADIUS: modelo de grupos GR + CoA vía el
 *     radius-orchestrator. Para los NAS ya cutoveados al HA.
 *
 * El routeo entre ambos (Inc2) lo hace `PerNasEnforcementGateway` según `nas.type`
 * (`radius_orchestrator` → orchestrator; el resto → MK-directo).
 */
export interface EnforcementGateway {
  /**
   * Aplica la acción de corte en la RED para este PPPoE en su NAS. Cada adapter traduce la
   * acción a su backend. Falla (red/router/orchestrator inalcanzable) → lanza; el use case
   * NO confirma en DB (no miente).
   */
  apply(pppoe: PppoeService, nas: NasServer, action: EnforcementAction): Promise<void>;
}

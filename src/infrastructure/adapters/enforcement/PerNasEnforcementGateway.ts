import { EnforcementGateway } from '@domain/ports/EnforcementGateway';
import { PppoeService, EnforcementAction } from '@domain/entities/pppoeService';
import { NasServer, routesViaOrchestrator } from '@domain/entities/nas';

/**
 * PerNasEnforcementGateway — routea el corte SEGÚN el NAS.
 *
 *   nas.type === 'mikrotik_radius'  → RADIUS (orchestrator + CoA)   ← NAS ya cutoveado al HA
 *   resto                           → MK-directo (/ppp secret + kick) ← DEFAULT SEGURO
 *
 * Por qué el default es MK-directo: al 2026-06-17 el ~97% de la red autentica contra `/ppp secret`
 * local (solo Acceso Sur tiene RADIUS, y vía el legacy). Un NAS pasa a cortar por RADIUS marcándose
 * `mikrotik_radius` — sin big-bang, NAS por NAS. Cualquier `type` desconocido cae a MK-directo (el
 * camino que SÍ corta hoy), nunca a un RADIUS que no controla ese router.
 */
export class PerNasEnforcementGateway implements EnforcementGateway {
  constructor(
    private readonly mkDirect: EnforcementGateway,
    private readonly radius: EnforcementGateway,
  ) {}

  async apply(pppoe: PppoeService, nas: NasServer, action: EnforcementAction): Promise<void> {
    const gateway = routesViaOrchestrator(nas.type) ? this.radius : this.mkDirect;
    await gateway.apply(pppoe, nas, action);
  }
}

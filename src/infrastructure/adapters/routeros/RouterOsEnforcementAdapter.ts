import { EnforcementGateway } from '@domain/ports/EnforcementGateway';
import { PppoeService, EnforcementAction } from '@domain/entities/pppoeService';
import { NasServer } from '@domain/entities/nas';
import { PppoeRouterGateway, SecretInput } from '@domain/ports/PppoeRouterGateway';
import { toNasTarget } from '@application/use-cases/nasTarget';

/**
 * RouterOsEnforcementAdapter — corte MK-DIRECTO detrás del `EnforcementGateway`.
 *
 * Es la lógica que vivía en `EnforcePppoeService` (Fase C original), extraída tal cual:
 *   reduce  → /ppp secret profile = reducedProfile, disabled=no
 *   block   → /ppp secret disabled=yes
 *   restore → /ppp secret profile = <comercial de la DB>, disabled=(baja comercial)
 * + kick de la sesión activa para que el cambio tome efecto YA.
 *
 * El `profile` COMERCIAL (DB) NUNCA se pisa: el router cambia, la DB recuerda → restore devuelve
 * el original. `restore` RESPETA la baja comercial: un secret con `status='disabled'` NO se
 * re-habilita (solo se levanta el enforcement, no la baja).
 */
export class RouterOsEnforcementAdapter implements EnforcementGateway {
  constructor(
    private readonly router: PppoeRouterGateway,
    private readonly reducedProfile: string,
  ) {}

  async apply(pppoe: PppoeService, nas: NasServer, action: EnforcementAction): Promise<void> {
    const nasTarget = toNasTarget(nas);

    const patch: Partial<SecretInput> = {};
    switch (action) {
      case 'reduce':
        patch.profile = this.reducedProfile;
        patch.disabled = false;
        break;
      case 'block':
        patch.disabled = true;
        break;
      case 'restore':
        // Solo restaurar el profile si hay uno comercial guardado (evita mandar profile vacío
        // al router; un PPPoE sin profile comercial conserva el del router).
        if (pppoe.profile) patch.profile = pppoe.profile;
        // RESPETAR la baja COMERCIAL: status='disabled' → el secret queda disabled.
        patch.disabled = pppoe.status === 'disabled';
        break;
    }

    // 1) Router primero. Si falla → RouterUnreachableError (el use case NO confirma en DB).
    await this.router.updateSecret(nasTarget, pppoe.username, patch);
    // 2) Kick: desconectar la sesión activa para que el cambio tome efecto YA.
    await this.router.removeActiveSession(nasTarget, pppoe.username);
  }
}

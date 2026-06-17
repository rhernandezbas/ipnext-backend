import { PppoeService, EnforcementAction, enforcedStateForAction } from '@domain/entities/pppoeService';
import { PppoeServiceRepository } from '@domain/ports/PppoeServiceRepository';
import { PppoeRouterGateway, SecretInput } from '@domain/ports/PppoeRouterGateway';
import { NasRepository } from '@domain/ports/NasRepository';
import { NasNotFoundError, PppoeServiceNotFoundError } from '@domain/errors/pppoe';
import { toNasTarget } from './nasTarget';

export interface EnforcePppoeServiceInput {
  id: string;
  action: EnforcementAction; // 'reduce' | 'block' | 'restore'
}

/**
 * EnforcePppoeService (Fase C) — corte/reducción/restauración de UN PPPoE.
 *
 * Aplica el cambio en el router PRIMERO + kickea la sesión; recién si el router responde,
 * confirma el `enforcedState` en la DB (patrón router→confirm de Fase B). Router caído → 502,
 * la DB NO cambia (no miente).
 *
 *   reduce  → /ppp secret profile = reducedProfile, disabled=no    → enforcedState='reduced'
 *   block   → /ppp secret disabled=yes                             → enforcedState='blocked'
 *   restore → /ppp secret profile = <comercial de la DB>, disabled=no → enforcedState='active'
 *
 * El `profile` COMERCIAL en la DB NUNCA se pisa: el router cambia, la DB recuerda → restore
 * devuelve el original. IDEMPOTENTE: aplicar la acción a un PPPoE ya en el estado destino es
 * un no-op seguro (ni siquiera toca el router) — esto da idempotencia y "no reprocesar" al resumir.
 */
export class EnforcePppoeService {
  constructor(
    private readonly repo: PppoeServiceRepository,
    private readonly router: PppoeRouterGateway,
    private readonly nasRepo: NasRepository,
    private readonly reducedProfile: string,
  ) {}

  async execute(input: EnforcePppoeServiceInput): Promise<PppoeService> {
    const s = await this.repo.findById(input.id);
    if (!s) throw new PppoeServiceNotFoundError(input.id);

    const target = enforcedStateForAction(input.action);
    if (s.enforcedState === target) return s; // idempotente: no-op (no toca el router)

    const nas = await this.nasRepo.findNasServerById(s.nasId);
    if (!nas) throw new NasNotFoundError(s.nasId);
    const nasTarget = toNasTarget(nas);

    const patch: Partial<SecretInput> = {};
    switch (input.action) {
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
        if (s.profile) patch.profile = s.profile;
        // RESPETAR la baja COMERCIAL: si el secret está comercialmente deshabilitado
        // (status='disabled'), restore NO lo re-habilita — el enforcement se levanta, pero la
        // baja comercial sigue mandando. Solo se re-habilita lo que estaba comercialmente activo.
        patch.disabled = s.status === 'disabled';
        break;
    }

    // 1) Router primero. Si falla → RouterUnreachableError (502), la DB no cambia.
    await this.router.updateSecret(nasTarget, s.username, patch);
    // 2) Kick: desconectar la sesión activa para que el cambio tome efecto YA.
    await this.router.removeActiveSession(nasTarget, s.username);

    // 3) Confirmar SOLO el enforcedState en la DB (el profile comercial queda intacto).
    const updated = await this.repo.setEnforcedState(s.id, target);
    return updated ?? { ...s, enforcedState: target };
  }
}

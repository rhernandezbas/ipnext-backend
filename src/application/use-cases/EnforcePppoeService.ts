import { PppoeService, EnforcementAction, enforcedStateForAction } from '@domain/entities/pppoeService';
import { PppoeServiceRepository } from '@domain/ports/PppoeServiceRepository';
import { EnforcementGateway } from '@domain/ports/EnforcementGateway';
import { NasRepository } from '@domain/ports/NasRepository';
import { NasNotFoundError, PppoeServiceNotFoundError } from '@domain/errors/pppoe';

export interface EnforcePppoeServiceInput {
  id: string;
  action: EnforcementAction; // 'reduce' | 'block' | 'restore'
}

/**
 * EnforcePppoeService (Fase C) — corte/reducción/restauración de UN PPPoE.
 *
 * Orquesta dominio puro: resuelve el PPPoE + su NAS, decide idempotencia y confirma el
 * `enforcedState` en la DB. El CÓMO se aplica el corte (MK-directo o RADIUS/CoA) vive detrás del
 * `EnforcementGateway` (Inc1: `RouterOsEnforcementAdapter`; Inc2+: routeo per-NAS por `nas.type`).
 *
 * Patrón red→confirm: el gateway aplica en la red PRIMERO; recién si responde se confirma en la
 * DB. Gateway que falla (router caído / orchestrator inalcanzable) → propaga el error (502), la DB
 * NO cambia (no miente). IDEMPOTENTE: aplicar la acción a un PPPoE ya en el estado destino es un
 * no-op (ni toca la red) — esto da idempotencia y "no reprocesar" al resumir un lote.
 */
export class EnforcePppoeService {
  constructor(
    private readonly repo: PppoeServiceRepository,
    private readonly enforcement: EnforcementGateway,
    private readonly nasRepo: NasRepository,
  ) {}

  async execute(input: EnforcePppoeServiceInput): Promise<PppoeService> {
    const s = await this.repo.findById(input.id);
    if (!s) throw new PppoeServiceNotFoundError(input.id);

    const target = enforcedStateForAction(input.action);
    if (s.enforcedState === target) return s; // idempotente: no-op (no toca la red)

    const nas = await this.nasRepo.findNasServerById(s.nasId);
    if (!nas) throw new NasNotFoundError(s.nasId);

    // 1) Red primero (a través del gateway). Si falla → propaga (502), la DB no cambia.
    await this.enforcement.apply(s, nas, input.action);

    // 2) Confirmar SOLO el enforcedState en la DB (el profile comercial queda intacto).
    const updated = await this.repo.setEnforcedState(s.id, target);
    return updated ?? { ...s, enforcedState: target };
  }
}

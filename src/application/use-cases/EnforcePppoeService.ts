import { PppoeService, EnforcementAction, enforcedStateForAction } from '@domain/entities/pppoeService';
import { PppoeServiceRepository } from '@domain/ports/PppoeServiceRepository';
import { EnforcementGateway } from '@domain/ports/EnforcementGateway';
import { NasRepository } from '@domain/ports/NasRepository';
import { NasNotFoundError, PppoeServiceNotFoundError } from '@domain/errors/pppoe';
import type { RecordPppoeEnforceEvent } from './RecordPppoeEnforceEvent';

export interface EnforcePppoeServiceInput {
  id: string;
  action: EnforcementAction; // 'reduce' | 'block' | 'restore'
  // pppoe-corte-individual: optional reason + actor forwarded to event log.
  reason?:    string | null;
  actorId?:   string | null;
  actorName?: string;
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
 *
 * pppoe-corte-individual: 4th optional param `recordEvent` logs a 'reduced'/'blocked'/'restored'
 * event (best-effort) when the enforcement is NOT a no-op and the PPPoE has a contractId.
 */
export class EnforcePppoeService {
  constructor(
    private readonly repo: PppoeServiceRepository,
    private readonly enforcement: EnforcementGateway,
    private readonly nasRepo: NasRepository,
    /** pppoe-corte-individual: optional; keeps back-compat with callers that don't pass it. */
    private readonly recordEvent?: RecordPppoeEnforceEvent,
  ) {}

  async execute(input: EnforcePppoeServiceInput): Promise<PppoeService> {
    const s = await this.repo.findById(input.id);
    if (!s) throw new PppoeServiceNotFoundError(input.id);

    const target = enforcedStateForAction(input.action);
    if (s.enforcedState === target) return s; // idempotente: no-op (no toca la red, no evento)

    const nas = await this.nasRepo.findNasServerById(s.nasId);
    if (!nas) throw new NasNotFoundError(s.nasId);

    // 1) Red primero (a través del gateway). Si falla → propaga (502), la DB no cambia.
    await this.enforcement.apply(s, nas, input.action);

    // 2) Confirmar SOLO el enforcedState en la DB (el profile comercial queda intacto).
    const updated = await this.repo.setEnforcedState(s.id, target);

    // 3) pppoe-corte-individual: registrar evento (best-effort) si hay contrato.
    if (this.recordEvent && s.contractId != null) {
      void this.recordEvent.execute(s.contractId, input.action, {
        reason:    input.reason,
        actorId:   input.actorId,
        actorName: input.actorName,
      });
    }

    return updated ?? { ...s, enforcedState: target };
  }
}

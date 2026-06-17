import { PppoeService, EnforcementAction, enforcedStateForAction } from '@domain/entities/pppoeService';
import { PppoeServiceRepository } from '@domain/ports/PppoeServiceRepository';

/**
 * Criterio de selección de PPPoE para un corte masivo:
 *   'debtors'            → clientes deudores (Client.status='late')
 *   { clientStatus }     → cualquier Client.status (ej. 'baja' para bloquear)
 *   { pppoeIds }         → lista explícita de PPPoE
 */
export type EnforcementTarget =
  | 'debtors'
  | { clientStatus: string }
  | { pppoeIds: string[] };

export interface EnforcementPreviewSample {
  id: string;
  username: string;
  nasId: string;
  contractId: string | null;
  enforcedState: PppoeService['enforcedState'];
}

export interface EnforcementPreview {
  total: number;
  byRouter: Record<string, number>; // nasId → cantidad
  sample: EnforcementPreviewSample[];
  pppoeIds: string[];               // ids candidatos (los que la acción CAMBIARÍA)
}

const SAMPLE_SIZE = 20;

/**
 * PreviewEnforcement (Fase C) — calcula el impacto de un corte SIN ejecutar nada.
 *
 * Resuelve la lista según `target`, descarta los que ya están en el estado destino
 * (idempotencia: la acción no los cambiaría) y devuelve total + desglose por router + muestra.
 *
 * SEGURIDAD: NO recibe el `PppoeRouterGateway` — estructuralmente no puede tocar el router.
 * Solo lee del repo; NUNCA escribe.
 */
export class PreviewEnforcement {
  constructor(private readonly repo: PppoeServiceRepository) {}

  async execute(input: { action: EnforcementAction; target: EnforcementTarget }): Promise<EnforcementPreview> {
    const candidates = await resolveEnforcementCandidates(this.repo, input.action, input.target);

    const byRouter: Record<string, number> = {};
    for (const s of candidates) {
      byRouter[s.nasId] = (byRouter[s.nasId] ?? 0) + 1;
    }

    return {
      total: candidates.length,
      byRouter,
      sample: candidates.slice(0, SAMPLE_SIZE).map(s => ({
        id: s.id,
        username: s.username,
        nasId: s.nasId,
        contractId: s.contractId,
        enforcedState: s.enforcedState,
      })),
      pppoeIds: candidates.map(s => s.id),
    };
  }
}

/**
 * Resuelve y filtra los PPPoE que la acción REALMENTE cambiaría (enforcedState != destino).
 * Compartido por PreviewEnforcement y el wiring del bulk. Solo lectura.
 */
export async function resolveEnforcementCandidates(
  repo: PppoeServiceRepository,
  action: EnforcementAction,
  target: EnforcementTarget,
): Promise<PppoeService[]> {
  const target_state = enforcedStateForAction(action);
  let pool: PppoeService[];

  if (target === 'debtors') {
    pool = await repo.listByClientStatus('late');
  } else if ('clientStatus' in target) {
    pool = await repo.listByClientStatus(target.clientStatus);
  } else {
    const found = await Promise.all(target.pppoeIds.map(id => repo.findById(id)));
    pool = found.filter((s): s is PppoeService => s !== null);
  }

  return pool.filter(s => s.enforcedState !== target_state);
}

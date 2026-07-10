import { OwnershipTransferCase } from '@domain/entities/ownershipCase';
import { OwnershipCaseRepository } from '@domain/ports/OwnershipCaseRepository';
import {
  OwnershipCaseNotFoundError,
  InvalidCandidatePickError,
  InvalidTargetAssignmentError,
  DismissReasonRequiredError,
  InvalidCaseTransitionError,
} from '@domain/errors/actions';
import { ContractOwnershipLookup } from './lookups';

/**
 * Union PATCH del design §5 — la route parsea el body a UNO de estos kinds:
 *   {equipmentReviewed}       → 'equipmentReviewed' (true setea actor+fecha; false limpia
 *                               los 3). Solo sobre casos ABIERTOS (pending/ambiguous — L2).
 *   {targetContractId}        → 'pickTarget'. Tres ramas:
 *                               · ambiguous → pick por membership en candidates (como siempre)
 *                               · pending CON candidates → RE-pick por membership (H1c —
 *                                 corrige la elección errada)
 *                               · pending SIN target NI candidates → SET-target validado
 *                                 contra el mirror (H1b — existe, no-baja, otro cliente)
 *   {status:'dismissed', reason} → 'dismiss' (reason obligatorio; NUNCA desde done — L3)
 *   {status:'pending'}        → 'reopen' (solo desde dismissed; si el caso tenía candidates
 *                               vuelve a ambiguous Y limpia el target heredado — H1d)
 */
export type UpdateOwnershipCaseAction =
  | { kind: 'equipmentReviewed'; reviewed: boolean }
  | { kind: 'pickTarget'; targetContractId: string }
  | { kind: 'dismiss'; reason: string }
  | { kind: 'reopen' };

/**
 * actions-worklist CASE-2 — mutaciones del caso con rastro. Todas las ramas
 * validan ANTES de escribir (un error tipado jamás deja efectos parciales).
 */
export class UpdateOwnershipCase {
  constructor(
    private readonly caseRepo: OwnershipCaseRepository,
    private readonly contractLookup: ContractOwnershipLookup,
  ) {}

  async execute(
    id: string,
    actorId: string,
    action: UpdateOwnershipCaseAction,
  ): Promise<OwnershipTransferCase> {
    const existing = await this.caseRepo.getById(id);
    if (existing === null) throw new OwnershipCaseNotFoundError(id);

    switch (action.kind) {
      case 'equipmentReviewed':
        // L2 — el check manual solo tiene sentido en un caso ABIERTO.
        if (existing.status !== 'pending' && existing.status !== 'ambiguous') {
          throw new InvalidCaseTransitionError(id, existing.status, 'equipment-review');
        }
        return this.applyPatch(
          id,
          action.reviewed
            ? {
                equipmentReviewed: true,
                equipmentReviewedById: actorId,
                equipmentReviewedAt: new Date().toISOString(),
              }
            : {
                // false limpia los TRES campos — sin rastro fantasma de un actor viejo
                equipmentReviewed: false,
                equipmentReviewedById: null,
                equipmentReviewedAt: null,
              },
        );

      case 'pickTarget':
        return this.pickTarget(existing, action.targetContractId);

      case 'dismiss': {
        // L3 — done es un cierre exitoso: descartarlo no tiene sentido.
        if (existing.status === 'done') {
          throw new InvalidCaseTransitionError(id, 'done', 'dismissed');
        }
        if (action.reason.trim() === '') throw new DismissReasonRequiredError(id);
        return this.applyPatch(id, { status: 'dismissed', dismissReason: action.reason });
      }

      case 'reopen': {
        if (existing.status !== 'dismissed') {
          throw new InvalidCaseTransitionError(id, existing.status, 'pending');
        }
        // H1d (evolución de la decisión W2): un descartado CON candidates vuelve
        // a `ambiguous` — y LIMPIA el target heredado de un pick previo (si el
        // pick fue el motivo del descarte, conservarlo re-abriría el error).
        if (existing.candidates !== null) {
          return this.applyPatch(id, {
            status: 'ambiguous',
            dismissReason: null,
            targetContractId: null,
            targetClientId: null,
          });
        }
        return this.applyPatch(id, { status: 'pending', dismissReason: null });
      }
    }
  }

  /**
   * H1b/H1c — pickTarget con tres ramas (ver doc del union). El caso `pending`
   * con target y SIN candidates no acepta pick (el target vino de un pairing
   * 1-candidato del detector — corregirlo es dismiss+reopen o transferencia
   * manual, no un pick ciego); done/dismissed tampoco.
   */
  private async pickTarget(
    existing: OwnershipTransferCase,
    targetContractId: string,
  ): Promise<OwnershipTransferCase> {
    const isOpen = existing.status === 'ambiguous' || existing.status === 'pending';

    // Ramas por membership: ambiguous (pick original) o pending con candidates (re-pick H1c).
    if (isOpen && existing.candidates !== null) {
      const candidate = existing.candidates.find((c) => c.contractId === targetContractId);
      if (candidate === undefined) {
        throw new InvalidCandidatePickError(existing.id, targetContractId);
      }
      return this.applyPatch(existing.id, {
        targetContractId: candidate.contractId,
        targetClientId: candidate.clientId,
        status: 'pending',
      });
    }

    // H1b — set-target sobre el pending nacido sin candidatos (caso 0-candidatos):
    // validación contra el mirror, porque acá no hay lista blanca de candidates.
    if (existing.status === 'pending' && existing.targetContractId === null) {
      const contract = await this.contractLookup.getContract(targetContractId);
      if (contract === null) {
        throw new InvalidTargetAssignmentError(existing.id, targetContractId, 'not found in the contract mirror');
      }
      if (contract.status.toLowerCase() === 'baja') {
        throw new InvalidTargetAssignmentError(existing.id, targetContractId, 'the contract is in baja');
      }
      if (contract.clientId === existing.sourceClientId) {
        throw new InvalidTargetAssignmentError(
          existing.id,
          targetContractId,
          'the contract belongs to the same client as the baja (not a titularity transfer)',
        );
      }
      return this.applyPatch(existing.id, {
        targetContractId: contract.id,
        targetClientId: contract.clientId,
      });
    }

    throw new InvalidCandidatePickError(existing.id, targetContractId);
  }

  private async applyPatch(
    id: string,
    patch: Parameters<OwnershipCaseRepository['update']>[1],
  ): Promise<OwnershipTransferCase> {
    const updated = await this.caseRepo.update(id, patch);
    // Carrera getById→update (el caso desapareció en el medio) — mismo 404 tipado.
    if (updated === null) throw new OwnershipCaseNotFoundError(id);
    return updated;
  }
}

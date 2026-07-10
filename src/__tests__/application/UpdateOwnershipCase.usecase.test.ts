/**
 * actions-worklist W2 — CASE-2: mutaciones del caso con rastro.
 * Union PATCH: check manual con actor/fecha · pick de candidato validado ·
 * set-target validado contra el mirror (H1b) · re-pick con candidates (H1c) ·
 * descarte con motivo obligatorio · reapertura desde dismissed (H1d limpia el
 * target heredado) · guards de estado (L2/L3).
 */
import { UpdateOwnershipCase } from '@application/use-cases/actions/UpdateOwnershipCase';
import { InMemoryOwnershipCaseRepository } from '@infrastructure/adapters/in-memory/InMemoryOwnershipCaseRepository';
import { InMemoryContractPairingReader } from '@infrastructure/adapters/in-memory/InMemoryContractPairingReader';
import { OwnershipTransferCase, PairingContract } from '@domain/entities/ownershipCase';
import {
  OwnershipCaseNotFoundError,
  InvalidCandidatePickError,
  InvalidTargetAssignmentError,
  DismissReasonRequiredError,
  InvalidCaseTransitionError,
} from '@domain/errors/actions';

function makeCase(overrides: Partial<OwnershipTransferCase> = {}): OwnershipTransferCase {
  return {
    id: 'case-1',
    sourceContractId: 'ct-src',
    sourceClientId: 'cli-src',
    motivoBaja: 'CAMBIO DE TITULARIDAD',
    bajaDate: null,
    targetContractId: 'ct-tgt',
    targetClientId: 'cli-tgt',
    candidates: null,
    status: 'pending',
    dismissReason: null,
    equipmentReviewed: false,
    equipmentReviewedById: null,
    equipmentReviewedAt: null,
    detectedAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function contract(id: string, clientId: string, overrides: Partial<PairingContract> = {}): PairingContract {
  return {
    id,
    clientId,
    address: 'MITRE 100',
    startDate: '2024-05-01T00:00:00.000Z',
    motivoBaja: null,
    status: 'active',
    ...overrides,
  };
}

function build(seed?: OwnershipTransferCase) {
  const repo = new InMemoryOwnershipCaseRepository();
  if (seed) repo.seedCase(seed);
  // El pairing reader in-memory satisface estructuralmente ContractOwnershipLookup (getContract).
  const contracts = new InMemoryContractPairingReader();
  const useCase = new UpdateOwnershipCase(repo, contracts);
  return { repo, contracts, useCase };
}

const ACTOR = 'user-test';

// ─── Guard: caso existe ───────────────────────────────────────────────────────

describe('UpdateOwnershipCase — guards', () => {
  it('lanza OwnershipCaseNotFoundError (code OWNERSHIP_CASE_NOT_FOUND) si el caso no existe', async () => {
    const { useCase } = build();

    await expect(
      useCase.execute('nope', ACTOR, { kind: 'equipmentReviewed', reviewed: true }),
    ).rejects.toThrow(OwnershipCaseNotFoundError);
  });
});

// ─── Check manual de equipos ──────────────────────────────────────────────────

describe('UpdateOwnershipCase — check manual de equipos (CASE-2)', () => {
  it('reviewed=true guarda el flag + actorId + fecha', async () => {
    const { repo, useCase } = build(makeCase());

    const updated = await useCase.execute('case-1', ACTOR, { kind: 'equipmentReviewed', reviewed: true });

    expect(updated.equipmentReviewed).toBe(true);
    expect(updated.equipmentReviewedById).toBe(ACTOR);
    expect(updated.equipmentReviewedAt).toEqual(expect.any(String));
    const persisted = await repo.getById('case-1');
    expect(persisted!.equipmentReviewed).toBe(true);
    expect(persisted!.equipmentReviewedById).toBe(ACTOR);
  });

  it('reviewed=false limpia los TRES campos (flag + actor + fecha)', async () => {
    const { repo, useCase } = build(makeCase({
      equipmentReviewed: true,
      equipmentReviewedById: 'user-otro',
      equipmentReviewedAt: '2026-07-05T10:00:00.000Z',
    }));

    const updated = await useCase.execute('case-1', ACTOR, { kind: 'equipmentReviewed', reviewed: false });

    expect(updated.equipmentReviewed).toBe(false);
    expect(updated.equipmentReviewedById).toBeNull();
    expect(updated.equipmentReviewedAt).toBeNull();
    const persisted = await repo.getById('case-1');
    expect(persisted!.equipmentReviewedById).toBeNull();
  });

  it('funciona también sobre un caso ambiguous (L2: pending y ambiguous son los estados abiertos)', async () => {
    const { useCase } = build(makeCase({
      status: 'ambiguous',
      targetContractId: null,
      targetClientId: null,
      candidates: [{ contractId: 'ct-a', clientId: 'cli-a' }, { contractId: 'ct-b', clientId: 'cli-b' }],
    }));

    const updated = await useCase.execute('case-1', ACTOR, { kind: 'equipmentReviewed', reviewed: true });

    expect(updated.equipmentReviewed).toBe(true);
  });

  // L2 — el check manual solo tiene sentido sobre un caso abierto.
  it('sobre un caso done → InvalidCaseTransitionError (422) sin efectos', async () => {
    const { repo, useCase } = build(makeCase({ status: 'done' }));

    await expect(
      useCase.execute('case-1', ACTOR, { kind: 'equipmentReviewed', reviewed: true }),
    ).rejects.toThrow(InvalidCaseTransitionError);

    expect((await repo.getById('case-1'))!.equipmentReviewed).toBe(false);
  });

  it('sobre un caso dismissed → InvalidCaseTransitionError (422) sin efectos', async () => {
    const { repo, useCase } = build(makeCase({ status: 'dismissed', dismissReason: 'x' }));

    await expect(
      useCase.execute('case-1', ACTOR, { kind: 'equipmentReviewed', reviewed: true }),
    ).rejects.toThrow(InvalidCaseTransitionError);

    expect((await repo.getById('case-1'))!.equipmentReviewed).toBe(false);
  });
});

// ─── Pick de candidato ────────────────────────────────────────────────────────

describe('UpdateOwnershipCase — pick de candidato (CASE-2)', () => {
  const AMBIGUOUS = makeCase({
    status: 'ambiguous',
    targetContractId: null,
    targetClientId: null,
    candidates: [
      { contractId: 'ct-a', clientId: 'cli-a' },
      { contractId: 'ct-b', clientId: 'cli-b' },
    ],
  });

  it('pick válido: pasa a pending con target (contract + client del candidato)', async () => {
    const { repo, useCase } = build({ ...AMBIGUOUS });

    const updated = await useCase.execute('case-1', ACTOR, { kind: 'pickTarget', targetContractId: 'ct-a' });

    expect(updated.status).toBe('pending');
    expect(updated.targetContractId).toBe('ct-a');
    expect(updated.targetClientId).toBe('cli-a');
    const persisted = await repo.getById('case-1');
    expect(persisted!.status).toBe('pending');
    expect(persisted!.targetContractId).toBe('ct-a');
  });

  it('pick con contractId que NO está en candidates → InvalidCandidatePickError SIN efectos', async () => {
    const { repo, useCase } = build({ ...AMBIGUOUS });

    await expect(
      useCase.execute('case-1', ACTOR, { kind: 'pickTarget', targetContractId: 'ct-intruso' }),
    ).rejects.toThrow(InvalidCandidatePickError);

    const persisted = await repo.getById('case-1');
    expect(persisted!.status).toBe('ambiguous');
    expect(persisted!.targetContractId).toBeNull();
  });

  // H1c — re-pick: un pending CON target pero con candidates persistidos acepta
  // corregir la elección (membership en candidates, como el pick original).
  it('re-pick sobre un pending con target y candidates → corrige el target (200)', async () => {
    const { repo, useCase } = build(makeCase({
      status: 'pending',
      targetContractId: 'ct-a',
      targetClientId: 'cli-a',
      candidates: [
        { contractId: 'ct-a', clientId: 'cli-a' },
        { contractId: 'ct-b', clientId: 'cli-b' },
      ],
    }));

    const updated = await useCase.execute('case-1', ACTOR, { kind: 'pickTarget', targetContractId: 'ct-b' });

    expect(updated.status).toBe('pending');
    expect(updated.targetContractId).toBe('ct-b');
    expect(updated.targetClientId).toBe('cli-b');
    expect((await repo.getById('case-1'))!.targetContractId).toBe('ct-b');
  });

  it('re-pick fuera de candidates → InvalidCandidatePickError SIN efectos', async () => {
    const { repo, useCase } = build(makeCase({
      status: 'pending',
      targetContractId: 'ct-a',
      targetClientId: 'cli-a',
      candidates: [
        { contractId: 'ct-a', clientId: 'cli-a' },
        { contractId: 'ct-b', clientId: 'cli-b' },
      ],
    }));

    await expect(
      useCase.execute('case-1', ACTOR, { kind: 'pickTarget', targetContractId: 'ct-intruso' }),
    ).rejects.toThrow(InvalidCandidatePickError);

    expect((await repo.getById('case-1'))!.targetContractId).toBe('ct-a');
  });

  it('pick sobre un pending CON target y SIN candidates → InvalidCandidatePickError SIN efectos', async () => {
    const { repo, useCase } = build(makeCase()); // pending con target, candidates null

    await expect(
      useCase.execute('case-1', ACTOR, { kind: 'pickTarget', targetContractId: 'ct-a' }),
    ).rejects.toThrow(InvalidCandidatePickError);

    const persisted = await repo.getById('case-1');
    expect(persisted!.status).toBe('pending');
    expect(persisted!.targetContractId).toBe('ct-tgt');
  });

  it('pick sobre un caso dismissed → InvalidCandidatePickError (reabrir primero)', async () => {
    const { useCase } = build(makeCase({
      status: 'dismissed',
      dismissReason: 'x',
      targetContractId: null,
      targetClientId: null,
      candidates: [{ contractId: 'ct-a', clientId: 'cli-a' }, { contractId: 'ct-b', clientId: 'cli-b' }],
    }));

    await expect(
      useCase.execute('case-1', ACTOR, { kind: 'pickTarget', targetContractId: 'ct-a' }),
    ).rejects.toThrow(InvalidCandidatePickError);
  });
});

// ─── H1b — set-target sobre un pending sin target ni candidatos ──────────────

describe('UpdateOwnershipCase — set-target sobre pending sin target (H1b)', () => {
  const UNPAIRED = makeCase({ targetContractId: null, targetClientId: null, candidates: null });

  it('setea target validado contra el mirror: existe, no-baja, de OTRO cliente → pending con target', async () => {
    const { repo, contracts, useCase } = build({ ...UNPAIRED });
    contracts.seed(contract('ct-nuevo', 'cli-nuevo'));

    const updated = await useCase.execute('case-1', ACTOR, { kind: 'pickTarget', targetContractId: 'ct-nuevo' });

    expect(updated.status).toBe('pending');
    expect(updated.targetContractId).toBe('ct-nuevo');
    expect(updated.targetClientId).toBe('cli-nuevo');
    const persisted = await repo.getById('case-1');
    expect(persisted!.targetContractId).toBe('ct-nuevo');
    expect(persisted!.targetClientId).toBe('cli-nuevo');
  });

  it('contrato inexistente en el mirror → InvalidTargetAssignmentError (422) SIN efectos', async () => {
    const { repo, useCase } = build({ ...UNPAIRED });

    await expect(
      useCase.execute('case-1', ACTOR, { kind: 'pickTarget', targetContractId: 'ct-fantasma' }),
    ).rejects.toThrow(InvalidTargetAssignmentError);

    expect((await repo.getById('case-1'))!.targetContractId).toBeNull();
  });

  it('contrato en baja → InvalidTargetAssignmentError SIN efectos (cubre raw "Baja")', async () => {
    const { repo, contracts, useCase } = build({ ...UNPAIRED });
    contracts.seed(contract('ct-baja', 'cli-nuevo', { status: 'Baja' }));

    await expect(
      useCase.execute('case-1', ACTOR, { kind: 'pickTarget', targetContractId: 'ct-baja' }),
    ).rejects.toThrow(InvalidTargetAssignmentError);

    expect((await repo.getById('case-1'))!.targetContractId).toBeNull();
  });

  it('contrato del MISMO cliente de la baja → InvalidTargetAssignmentError SIN efectos', async () => {
    const { repo, contracts, useCase } = build({ ...UNPAIRED });
    contracts.seed(contract('ct-propio', 'cli-src'));

    await expect(
      useCase.execute('case-1', ACTOR, { kind: 'pickTarget', targetContractId: 'ct-propio' }),
    ).rejects.toThrow(InvalidTargetAssignmentError);

    expect((await repo.getById('case-1'))!.targetContractId).toBeNull();
  });
});

// ─── Descarte ─────────────────────────────────────────────────────────────────

describe('UpdateOwnershipCase — descarte (CASE-2)', () => {
  it('dismiss con reason: queda dismissed con el motivo persistido', async () => {
    const { repo, useCase } = build(makeCase());

    const updated = await useCase.execute('case-1', ACTOR, { kind: 'dismiss', reason: 'falso positivo' });

    expect(updated.status).toBe('dismissed');
    expect(updated.dismissReason).toBe('falso positivo');
    expect((await repo.getById('case-1'))!.status).toBe('dismissed');
  });

  it('dismiss con reason en blanco → DismissReasonRequiredError SIN efectos', async () => {
    const { repo, useCase } = build(makeCase());

    await expect(
      useCase.execute('case-1', ACTOR, { kind: 'dismiss', reason: '   ' }),
    ).rejects.toThrow(DismissReasonRequiredError);

    expect((await repo.getById('case-1'))!.status).toBe('pending');
  });

  // L3 — un caso done es un caso CERRADO con éxito: descartarlo no tiene sentido.
  it('dismiss sobre un caso done → InvalidCaseTransitionError (422) SIN efectos', async () => {
    const { repo, useCase } = build(makeCase({ status: 'done' }));

    await expect(
      useCase.execute('case-1', ACTOR, { kind: 'dismiss', reason: 'me arrepentí' }),
    ).rejects.toThrow(InvalidCaseTransitionError);

    expect((await repo.getById('case-1'))!.status).toBe('done');
  });
});

// ─── Reapertura ───────────────────────────────────────────────────────────────

describe('UpdateOwnershipCase — reapertura (CASE-2)', () => {
  it('reopen desde dismissed → vuelve a pending y limpia dismissReason', async () => {
    const { repo, useCase } = build(makeCase({ status: 'dismissed', dismissReason: 'error' }));

    const updated = await useCase.execute('case-1', ACTOR, { kind: 'reopen' });

    expect(updated.status).toBe('pending');
    expect(updated.dismissReason).toBeNull();
    expect((await repo.getById('case-1'))!.status).toBe('pending');
  });

  it('reopen de un dismissed que era ambiguous (sin target, con candidatos) → vuelve a ambiguous (el pick sigue posible)', async () => {
    const { useCase } = build(makeCase({
      status: 'dismissed',
      dismissReason: 'duplicado',
      targetContractId: null,
      targetClientId: null,
      candidates: [
        { contractId: 'ct-a', clientId: 'cli-a' },
        { contractId: 'ct-b', clientId: 'cli-b' },
      ],
    }));

    const updated = await useCase.execute('case-1', ACTOR, { kind: 'reopen' });

    expect(updated.status).toBe('ambiguous');
  });

  // H1d — el target heredado de un pick previo se LIMPIA: si el pick fue el
  // motivo del descarte, reabrir conservándolo dejaría el error persistido.
  it('reopen de un dismissed con candidates Y target (pick previo) → ambiguous con target LIMPIO', async () => {
    const { repo, useCase } = build(makeCase({
      status: 'dismissed',
      dismissReason: 'pick equivocado',
      targetContractId: 'ct-a',
      targetClientId: 'cli-a',
      candidates: [
        { contractId: 'ct-a', clientId: 'cli-a' },
        { contractId: 'ct-b', clientId: 'cli-b' },
      ],
    }));

    const updated = await useCase.execute('case-1', ACTOR, { kind: 'reopen' });

    expect(updated.status).toBe('ambiguous');
    expect(updated.targetContractId).toBeNull();
    expect(updated.targetClientId).toBeNull();
    expect(updated.candidates).toEqual([
      { contractId: 'ct-a', clientId: 'cli-a' },
      { contractId: 'ct-b', clientId: 'cli-b' },
    ]);
    const persisted = await repo.getById('case-1');
    expect(persisted!.targetContractId).toBeNull();
    expect(persisted!.status).toBe('ambiguous');
  });

  it('reopen sobre un caso NO dismissed → InvalidCaseTransitionError sin efectos', async () => {
    const { repo, useCase } = build(makeCase()); // pending

    await expect(useCase.execute('case-1', ACTOR, { kind: 'reopen' })).rejects.toThrow(InvalidCaseTransitionError);

    expect((await repo.getById('case-1'))!.status).toBe('pending');
  });
});

import { describe, it, expect } from '@jest/globals';
import { GetPendingSideEffectsCount } from '@application/use-cases/GetPendingSideEffectsCount';
import { InMemoryClosedServiceOrderRepository } from '../../infrastructure/adapters/in-memory/InMemoryClosedServiceOrderRepository';
import type { ClosedServiceOrder } from '../../domain/entities/iclass-closed-order';

/** SO mínimo válido para poblar el repo en tests */
function minimalSO(iclassId: string): ClosedServiceOrder {
  return {
    iclassId,
    iclassCodigo: iclassId,
    iclassUpdatedAt: '2024-01-01',
    clusterName: 'cluster',
    thirdPartyCode: null,
    nodeCode: null,
    soTypeId: null,
    soTypeDescription: null,
    customerCode: null,
    customerName: null,
    addressCode: null,
    addressLine: null,
    addressCity: null,
    addressLat: null,
    addressLng: null,
    statusCode: '7',
    statusDescription: 'Encerrado',
    requestedAt: null,
    scheduledFor: null,
    availableAt: null,
    serviceStartedAt: null,
    serviceEndedAt: null,
    resultCodeName: null,
    closedByLogin: null,
    closedByName: null,
    closeLatitude: null,
    closeLongitude: null,
    closeGpsAt: null,
    billingAmount: null,
    technicianNote: null,
    internalNote: null,
    commentaryLog: null,
    teamLogin: null,
    teamTechnicianName: null,
    teamPhone: null,
    teamEmail: null,
    iclassCreatedAt: null,
    rawDetail: {},
    closedAt: null,
    firstClosedAt: null,
    approvedAt: null,
    resultCodeType: null,
    history: [],
    checklists: [],
    materials: [],
    equipmentEvents: [],
  };
}

describe('GetPendingSideEffectsCount', () => {
  it('REQ-PENDING-COUNT-1 happy path: returns pending > 0 when SOs have pending side-effects', async () => {
    const repo = new InMemoryClosedServiceOrderRepository();
    await repo.upsert(minimalSO('so-1'), 'task-1');
    await repo.upsert(minimalSO('so-2'), 'task-2');

    const useCase = new GetPendingSideEffectsCount(repo);
    const result = await useCase.execute();

    expect(result).toEqual({ pending: 2 });
  });

  it('REQ-PENDING-COUNT-1 no pending SOs: returns pending = 0', async () => {
    const repo = new InMemoryClosedServiceOrderRepository();
    await repo.upsert(minimalSO('so-done'), 'task-done');
    await repo.markSideEffect('so-done', 'commentPosted', true);
    await repo.markSideEffect('so-done', 'inventoryBuilt', true);
    await repo.markSideEffect('so-done', 'auditDone', true);

    const useCase = new GetPendingSideEffectsCount(repo);
    const result = await useCase.execute();

    expect(result).toEqual({ pending: 0 });
  });
});

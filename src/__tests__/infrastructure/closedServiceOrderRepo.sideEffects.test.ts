import { InMemoryClosedServiceOrderRepository } from '@infrastructure/adapters/in-memory/InMemoryClosedServiceOrderRepository';
import { ClosedServiceOrder } from '@domain/entities/iclass-closed-order';

function order(over: Partial<ClosedServiceOrder> & Pick<ClosedServiceOrder, 'iclassId' | 'iclassCodigo'>): ClosedServiceOrder {
  return {
    clusterName: 'IPNEXT', thirdPartyCode: null, nodeCode: null, soTypeId: null, soTypeDescription: null,
    customerCode: null, customerName: null, addressCode: null, addressLine: null, addressCity: null,
    addressLat: null, addressLng: null, statusCode: '7', statusDescription: 'Concluida',
    requestedAt: null, scheduledFor: null, availableAt: null, serviceStartedAt: null, serviceEndedAt: null,
    resultCodeName: 'Instalacion Completa Fibra', closedByLogin: null, closedByName: null,
    closeLatitude: null, closeLongitude: null, closeGpsAt: null, billingAmount: null,
    technicianNote: null, internalNote: null, commentaryLog: null,
    teamLogin: null, teamTechnicianName: null, teamPhone: null, teamEmail: null,
    iclassCreatedAt: null, iclassUpdatedAt: '2026-05-21T17:49:12.000Z', rawDetail: {},
    closedAt: null, firstClosedAt: null, approvedAt: null, resultCodeType: null,
    history: [], checklists: [], materials: [], equipmentEvents: [], ...over,
  };
}

describe('InMemoryClosedServiceOrderRepository — side-effect tracking', () => {
  it('starts every mirror with all side-effects pending and zero audit attempts', async () => {
    const repo = new InMemoryClosedServiceOrderRepository();
    await repo.upsert(order({ iclassId: '900', iclassCodigo: '4013' }), 't1');
    expect(await repo.getSideEffectState('900')).toEqual({
      commentPosted: false, inventoryBuilt: false, auditDone: false, auditAttempts: 0,
    });
  });

  it('marks a single side-effect and increments audit attempts independently', async () => {
    const repo = new InMemoryClosedServiceOrderRepository();
    await repo.upsert(order({ iclassId: '900', iclassCodigo: '4013' }), 't1');
    await repo.markSideEffect('900', 'commentPosted', true);
    await repo.incrementAuditAttempt('900');
    await repo.incrementAuditAttempt('900');
    expect(await repo.getSideEffectState('900')).toEqual({
      commentPosted: true, inventoryBuilt: false, auditDone: false, auditAttempts: 2,
    });
  });

  it('preserves side-effect state across a re-mirror (upsert never resets it)', async () => {
    const repo = new InMemoryClosedServiceOrderRepository();
    await repo.upsert(order({ iclassId: '900', iclassCodigo: '4013' }), 't1');
    await repo.markSideEffect('900', 'auditDone', true);
    await repo.upsert(order({ iclassId: '900', iclassCodigo: '4013', technicianNote: 'changed' }), 't1');
    expect((await repo.getSideEffectState('900'))!.auditDone).toBe(true);
  });

  it('lists pending side-effects but drops audit once it is done OR over the attempt cap', async () => {
    const repo = new InMemoryClosedServiceOrderRepository();
    // A: everything done → not pending
    await repo.upsert(order({ iclassId: 'A', iclassCodigo: '1' }), null);
    await repo.markSideEffect('A', 'commentPosted', true);
    await repo.markSideEffect('A', 'inventoryBuilt', true);
    await repo.markSideEffect('A', 'auditDone', true);
    // B: comment+inventory done, audit pending but UNDER cap → pending
    await repo.upsert(order({ iclassId: 'B', iclassCodigo: '2' }), 't2');
    await repo.markSideEffect('B', 'commentPosted', true);
    await repo.markSideEffect('B', 'inventoryBuilt', true);
    // C: only audit pending but OVER cap (2 attempts, cap 2) → NOT pending
    await repo.upsert(order({ iclassId: 'C', iclassCodigo: '3' }), 't3');
    await repo.markSideEffect('C', 'commentPosted', true);
    await repo.markSideEffect('C', 'inventoryBuilt', true);
    await repo.incrementAuditAttempt('C');
    await repo.incrementAuditAttempt('C');

    const pending = await repo.listPendingSideEffects(2);
    expect(pending.map(p => p.iclassId).sort()).toEqual(['B']);
    expect(pending[0]).toMatchObject({ iclassId: 'B', scheduledTaskId: 't2' });
  });

  it('reconstructs the full aggregate via getByIclassId', async () => {
    const repo = new InMemoryClosedServiceOrderRepository();
    await repo.upsert(order({ iclassId: '900', iclassCodigo: '4013', technicianNote: 'ok' }), 't1');
    const got = await repo.getByIclassId('900');
    expect(got!.iclassCodigo).toBe('4013');
    expect(got!.technicianNote).toBe('ok');
    expect(await repo.getByIclassId('nope')).toBeNull();
  });
});

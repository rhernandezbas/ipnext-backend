import { ReprocessClosureSideEffects, REPROCESS_FLAG_KEY, ClosureSideEffectRunner } from '@application/use-cases/ReprocessClosureSideEffects';
import { IngestClosedServiceOrders } from '@application/use-cases/IngestClosedServiceOrders';
import { AuditInstallationQuality } from '@application/use-cases/AuditInstallationQuality';
import { InMemoryFeatureFlagRepository } from '@infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';
import { InMemoryClosedServiceOrderRepository } from '@infrastructure/adapters/in-memory/InMemoryClosedServiceOrderRepository';
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryStageRepository } from '@infrastructure/adapters/in-memory/InMemoryStageRepository';
import { InMemoryTaskAuditRepository } from '@infrastructure/adapters/in-memory/InMemoryTaskAuditRepository';
import { InMemoryTaskCommentRepository } from '@infrastructure/adapters/in-memory/InMemoryTaskCommentRepository';
import { InMemoryIClassClient } from '@infrastructure/adapters/in-memory/InMemoryIClassClient';
import { InMemoryIClassResultCodeRepository } from '@infrastructure/adapters/in-memory/InMemoryIClassResultCodeRepository';
import { InMemorySyncStateRepository } from '@infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import { InstallationAuditor } from '@domain/ports/InstallationAuditor';
import { AuditContext, AuditResult } from '@domain/entities/installation-audit';
import { ClosedServiceOrder } from '@domain/entities/iclass-closed-order';

class StubAuditor implements InstallationAuditor {
  readonly provider = 'stub:test';
  result: AuditResult = { ok: true, findings: [] };
  calls = 0;
  async audit(_ctx: AuditContext): Promise<AuditResult> {
    this.calls++;
    return this.result;
  }
}

function order(over: Partial<ClosedServiceOrder> & Pick<ClosedServiceOrder, 'iclassId' | 'iclassCodigo'>): ClosedServiceOrder {
  return {
    clusterName: 'IPNEXT', thirdPartyCode: null, nodeCode: null, soTypeId: null, soTypeDescription: null,
    customerCode: null, customerName: null, addressCode: null, addressLine: null, addressCity: null,
    addressLat: null, addressLng: null, statusCode: '7', statusDescription: 'Concluida',
    requestedAt: null, scheduledFor: null, availableAt: null, serviceStartedAt: null, serviceEndedAt: null,
    resultCodeName: 'Cambio de Ficha', closedByLogin: null, closedByName: null,
    closeLatitude: null, closeLongitude: null, closeGpsAt: null, billingAmount: null,
    technicianNote: 'ok', internalNote: null, commentaryLog: null,
    teamLogin: null, teamTechnicianName: 'Rodrigo', teamPhone: null, teamEmail: null,
    iclassCreatedAt: null, iclassUpdatedAt: '2026-05-21T17:49:12.000Z', rawDetail: {},
    closedAt: null, firstClosedAt: null, approvedAt: null, resultCodeType: null,
    history: [], checklists: [], materials: [], equipmentEvents: [], ...over,
  };
}

describe('ReprocessClosureSideEffects', () => {
  it('skips entirely when the flag is OFF (runner never called)', async () => {
    const flags = new InMemoryFeatureFlagRepository();
    const closed = new InMemoryClosedServiceOrderRepository();
    await closed.upsert(order({ iclassId: '900', iclassCodigo: '1' }), 't1');
    const calls: string[] = [];
    const runner: ClosureSideEffectRunner = { runClosureSideEffects: async o => { calls.push(o.iclassId); } };

    const r = await new ReprocessClosureSideEffects(flags, closed, runner).execute();

    expect(r.skipped).toBe(true);
    expect(calls).toEqual([]);
  });

  it('re-fires pending mirrors with a task, skips those without, ignores fully-done ones', async () => {
    const flags = new InMemoryFeatureFlagRepository();
    await flags.setEnabled(REPROCESS_FLAG_KEY, true);
    const closed = new InMemoryClosedServiceOrderRepository();
    await closed.upsert(order({ iclassId: '900', iclassCodigo: '1' }), 't1'); // pending + task
    await closed.upsert(order({ iclassId: '901', iclassCodigo: '2' }), null); // pending, NO task
    await closed.upsert(order({ iclassId: '902', iclassCodigo: '3' }), 't3'); // fully done
    await closed.markSideEffect('902', 'commentPosted', true);
    await closed.markSideEffect('902', 'inventoryBuilt', true);
    await closed.markSideEffect('902', 'auditDone', true);
    const calls: string[] = [];
    const runner: ClosureSideEffectRunner = { runClosureSideEffects: async o => { calls.push(o.iclassId); } };

    const r = await new ReprocessClosureSideEffects(flags, closed, runner).execute();

    expect(r).toMatchObject({ skipped: false, candidates: 2, processed: 1, noTask: 1 });
    expect(calls).toEqual(['900']);
  });

  it('isolates a failing SO — one runner throw never aborts the batch', async () => {
    const flags = new InMemoryFeatureFlagRepository();
    await flags.setEnabled(REPROCESS_FLAG_KEY, true);
    const closed = new InMemoryClosedServiceOrderRepository();
    await closed.upsert(order({ iclassId: '900', iclassCodigo: '1' }), 't1');
    await closed.upsert(order({ iclassId: '901', iclassCodigo: '2' }), 't2');
    const runner: ClosureSideEffectRunner = {
      runClosureSideEffects: async o => { if (o.iclassId === '900') throw new Error('boom'); },
    };

    const r = await new ReprocessClosureSideEffects(flags, closed, runner).execute();

    expect(r.candidates).toBe(2);
    expect(r.processed).toBe(1); // only 901 succeeded; 900 threw but didn't abort
  });

  it('integration: re-fires a pending audit via the real runner and marks auditDone', async () => {
    const flags = new InMemoryFeatureFlagRepository();
    await flags.setEnabled(REPROCESS_FLAG_KEY, true);
    const closed = new InMemoryClosedServiceOrderRepository();
    const scheduling = new InMemorySchedulingRepository(new InMemoryStageRepository());
    scheduling.seedTask({ id: 't1', sequenceNumber: 4013 });
    const audits = new InMemoryTaskAuditRepository();
    const comments = new InMemoryTaskCommentRepository();
    const auditor = new StubAuditor();
    auditor.result = { ok: true, findings: [{ severity: 'ok', category: 'otros', text: 'bien', photoUrls: [] }] };
    await flags.setEnabled('iclass-audit', true);
    const auditInstallation = new AuditInstallationQuality(auditor, audits, scheduling, comments, flags);
    const ingest = new IngestClosedServiceOrders(
      new InMemoryIClassClient(), closed, new InMemoryIClassResultCodeRepository(),
      scheduling, new InMemorySyncStateRepository(), { auditInstallation },
    );
    await closed.upsert(order({ iclassId: '900', iclassCodigo: '4013' }), 't1'); // audit pending

    const r = await new ReprocessClosureSideEffects(flags, closed, ingest).execute();

    expect(r).toMatchObject({ skipped: false, candidates: 1, processed: 1 });
    expect(auditor.calls).toBe(1);
    expect((await closed.getSideEffectState('900'))!.auditDone).toBe(true);
    expect((await closed.getSideEffectState('900'))!.auditAttempts).toBe(1);
    expect(await audits.listFindingsByTask('t1')).toHaveLength(1);
  });

  it('integration: stops re-firing the audit once it is over the attempt cap', async () => {
    const flags = new InMemoryFeatureFlagRepository();
    await flags.setEnabled(REPROCESS_FLAG_KEY, true);
    const closed = new InMemoryClosedServiceOrderRepository();
    const scheduling = new InMemorySchedulingRepository(new InMemoryStageRepository());
    scheduling.seedTask({ id: 't1', sequenceNumber: 4013 });
    const auditor = new StubAuditor();
    auditor.result = { ok: false, findings: [] }; // always soft-fails
    await flags.setEnabled('iclass-audit', true);
    const auditInstallation = new AuditInstallationQuality(auditor, new InMemoryTaskAuditRepository(), scheduling, new InMemoryTaskCommentRepository(), flags);
    const ingest = new IngestClosedServiceOrders(
      new InMemoryIClassClient(), closed, new InMemoryIClassResultCodeRepository(),
      scheduling, new InMemorySyncStateRepository(), { auditInstallation, maxAuditAttempts: 2 },
    );
    await closed.upsert(order({ iclassId: '900', iclassCodigo: '4013' }), 't1');

    const reprocess = new ReprocessClosureSideEffects(flags, closed, ingest, { maxAuditAttempts: 2 });
    await reprocess.execute(); // attempt 1
    await reprocess.execute(); // attempt 2 → now at cap
    const third = await reprocess.execute(); // over cap → audit no longer a candidate

    expect(auditor.calls).toBe(2); // never tried a 3rd time
    expect((await closed.getSideEffectState('900'))!.auditAttempts).toBe(2);
    // comment+inventory still pending (no runners injected) so it's still a candidate,
    // but the audit specifically is capped.
    expect(third.candidates).toBe(1);
  });
});

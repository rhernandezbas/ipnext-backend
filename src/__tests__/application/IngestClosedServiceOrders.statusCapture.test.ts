/**
 * Tests for the iclass-status-sync capture in IngestClosedServiceOrders.processSummary:
 *
 * 1. Non-terminal OS with a matching task → catalog auto-populated + task iclassStatusCode written
 * 2. OS with no matching task → neither catalog nor task written
 * 3. Same statusCode again (no change) → idempotent (setIClassStatus not re-fired in practice)
 * 4. statusCode transition → code updated
 * 5. guard '7' (TERMINAL_STATUS) still fires mirror/side-effects as before
 * 6. No statusCatalog injected → legacy behavior intact (existing tests stay green)
 */
import { IngestClosedServiceOrders } from '@application/use-cases/IngestClosedServiceOrders';
import { InMemoryIClassClient } from '@infrastructure/adapters/in-memory/InMemoryIClassClient';
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryStageRepository } from '@infrastructure/adapters/in-memory/InMemoryStageRepository';
import { InMemoryIClassResultCodeRepository } from '@infrastructure/adapters/in-memory/InMemoryIClassResultCodeRepository';
import { InMemoryClosedServiceOrderRepository } from '@infrastructure/adapters/in-memory/InMemoryClosedServiceOrderRepository';
import { InMemorySyncStateRepository } from '@infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import { InMemoryIClassStatusCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryIClassStatusCatalogRepository';
import { ClosedServiceOrderSummary } from '@domain/entities/iclass-closed-order';
import { Stage } from '@domain/entities/workflow';

const REGISTRADO: Stage = { id: 'st-reg', workflowId: 'wf', name: 'Registrado en IClass', code: 'registered_in_iclass', category: 'nuevo', order: 5, color: null };
const INSTALADO: Stage = { id: 'st-inst', workflowId: 'wf', name: 'Instalado', code: 'instalado', category: 'hecho', order: 8, color: null };

function makeSummary(over: Partial<ClosedServiceOrderSummary> & Pick<ClosedServiceOrderSummary, 'iclassId' | 'iclassCodigo'>): ClosedServiceOrderSummary {
  return {
    clusterName: 'IPNEXT', thirdPartyCode: null, nodeCode: 'Mercedes', soTypeId: null, soTypeDescription: 'INSTALACION',
    customerCode: '204382', customerName: 'Cliente X', addressCode: '204382', addressLine: 'Calle 1', addressCity: 'Mercedes',
    addressLat: null, addressLng: null, statusCode: '3', statusDescription: 'Agendada',
    requestedAt: null, scheduledFor: null, availableAt: null, serviceStartedAt: null, serviceEndedAt: null,
    resultCodeName: null, closedByLogin: null, closedByName: null,
    closeLatitude: null, closeLongitude: null, closeGpsAt: null, billingAmount: 0,
    technicianNote: null, internalNote: null, commentaryLog: null,
    teamLogin: null, teamTechnicianName: null, teamPhone: null, teamEmail: null,
    iclassCreatedAt: '2026-05-01T00:00:00.000Z', iclassUpdatedAt: '2026-05-21T17:49:12.000Z',
    rawDetail: {}, ...over,
  };
}

function setup(withStatusCatalog = true) {
  const stages = new InMemoryStageRepository();
  stages.addDirect(REGISTRADO);
  stages.addDirect(INSTALADO);
  const statusCatalog = new InMemoryIClassStatusCatalogRepository();
  const scheduling = new InMemorySchedulingRepository(stages, undefined, withStatusCatalog ? statusCatalog : undefined);
  const iclass = new InMemoryIClassClient();
  const resultCodes = new InMemoryIClassResultCodeRepository();
  const closed = new InMemoryClosedServiceOrderRepository();
  const state = new InMemorySyncStateRepository();

  const now = () => new Date('2026-05-29T12:00:00Z');

  const useCase = new IngestClosedServiceOrders(
    iclass,
    closed,
    resultCodes,
    scheduling,
    state,
    {
      now,
      statusCatalog: withStatusCatalog ? statusCatalog : undefined,
    },
  );

  return { stages, scheduling, iclass, resultCodes, closed, state, statusCatalog, useCase };
}

describe('IngestClosedServiceOrders — status capture (iclass-status-sync)', () => {
  it('auto-populates catalog and sets iclassStatusCode for a non-terminal OS with a matching task', async () => {
    const { scheduling, iclass, statusCatalog, useCase } = setup();
    scheduling.seedTask({ id: 't1', sequenceNumber: 1001, stageId: REGISTRADO.id });
    iclass.serviceOrders = [makeSummary({ iclassId: '9001', iclassCodigo: '1001', statusCode: '3', statusDescription: 'Agendada' })];

    const counts = await useCase.execute();

    // Non-terminal → skippedNotClosed
    expect(counts.skippedNotClosed).toBe(1);

    // Catalog was auto-populated
    const entry = await statusCatalog.getByStatusCode('3');
    expect(entry).not.toBeNull();
    expect(entry!.iclassLabel).toBe('Agendada');
    expect(entry!.tracked).toBe(false);

    // Task got its iclassStatusCode set
    const task = await scheduling.getTask('t1');
    expect(task!.iclassStatusCode).toBe('3');
  });

  it('does NOT write catalog or task when OS has no matching task', async () => {
    const { scheduling, iclass, statusCatalog, useCase } = setup();
    // No task seeded — iclassCodigo=9999 has no match
    iclass.serviceOrders = [makeSummary({ iclassId: '9001', iclassCodigo: '9999', statusCode: '3', statusDescription: 'Agendada' })];

    await useCase.execute();

    const items = await statusCatalog.list();
    expect(items).toHaveLength(0);
  });

  it('is idempotent — same statusCode on repeated runs does NOT re-set iclassStatusUpdatedAt', async () => {
    const { scheduling, iclass, useCase } = setup();
    scheduling.seedTask({ id: 't1', sequenceNumber: 1001, stageId: REGISTRADO.id });
    iclass.serviceOrders = [makeSummary({ iclassId: '9001', iclassCodigo: '1001', statusCode: '3', statusDescription: 'Agendada' })];

    await useCase.execute();
    const task1 = await scheduling.getTask('t1');
    const at1 = task1!.iclassStatusUpdatedAt;

    // Re-run with same statusCode
    await useCase.execute();
    const task2 = await scheduling.getTask('t1');
    // updatedAt should not change (idempotent write)
    expect(task2!.iclassStatusUpdatedAt).toBe(at1);
  });

  it('updates iclassStatusCode when statusCode transitions', async () => {
    const { scheduling, iclass, statusCatalog, useCase } = setup();
    scheduling.seedTask({ id: 't1', sequenceNumber: 1001, stageId: REGISTRADO.id });

    // First run: status '3'
    iclass.serviceOrders = [makeSummary({ iclassId: '9001', iclassCodigo: '1001', statusCode: '3', statusDescription: 'Agendada' })];
    await useCase.execute();

    // Second run: status transitions to '50'
    iclass.serviceOrders = [makeSummary({ iclassId: '9001', iclassCodigo: '1001', statusCode: '50', statusDescription: 'Aprovada' })];
    await useCase.execute();

    const task = await scheduling.getTask('t1');
    expect(task!.iclassStatusCode).toBe('50');

    // Both statuses discovered
    const items = await statusCatalog.list();
    const codes = items.map(i => i.statusCode).sort();
    expect(codes).toContain('3');
    expect(codes).toContain('50');
  });

  it('guard statusCode !== "7" still fires — terminal OS still triggers mirror flow', async () => {
    const { scheduling, iclass, resultCodes, closed, statusCatalog, useCase } = setup();
    scheduling.seedTask({ id: 't1', sequenceNumber: 1001, stageId: REGISTRADO.id });

    // Seed a result-code mapping for the terminal OS
    await resultCodes.upsert({ soTypeId: null, code: 'Instalacion Completa', type: 'Sucesso' });
    const rc = await resultCodes.findByCode('Instalacion Completa');
    await resultCodes.assignStage(rc!.id, INSTALADO.id);

    iclass.serviceOrders = [makeSummary({
      iclassId: '9001', iclassCodigo: '1001',
      statusCode: '7', statusDescription: 'Concluida',
      resultCodeName: 'Instalacion Completa',
    })];
    iclass.historyByOrder['9001'] = [
      { iclassOsStatusId: '1', occurredAt: '2026-05-20T10:00:00.000Z', statusCode: '7', statusDescription: 'ENCERRADO', durationMinutes: 0, teamLogin: 'x', commentary: null },
    ];

    const counts = await useCase.execute();

    // Terminal → mirrored
    expect(counts.mirrored).toBe(1);
    expect(counts.transitioned).toBe(1);

    // Catalog also populated for '7'
    const entry = await statusCatalog.getByStatusCode('7');
    expect(entry).not.toBeNull();
    expect(entry!.iclassLabel).toBe('Concluida');

    // Task got iclassStatusCode
    const task = await scheduling.getTask('t1');
    expect(task!.iclassStatusCode).toBe('7');
  });

  it('legacy behavior (no statusCatalog injected) — existing IngestClosedServiceOrders tests stay green', async () => {
    const { scheduling, iclass, useCase } = setup(false /* no statusCatalog */);
    scheduling.seedTask({ id: 't1', sequenceNumber: 1001, stageId: REGISTRADO.id });
    iclass.serviceOrders = [makeSummary({ iclassId: '9001', iclassCodigo: '1001', statusCode: '3', statusDescription: 'Agendada' })];

    // Must not throw even when statusCatalog is absent
    const counts = await useCase.execute();
    expect(counts.skippedNotClosed).toBe(1);

    // Task has no iclassStatusCode (no catalog injected)
    const task = await scheduling.getTask('t1');
    expect(task!.iclassStatusCode).toBeNull();
  });

  // FIX 2 — int4-overflow guard: OS with iclassCodigo outside int4 range must NOT
  // call findTaskBySequenceNumber (would throw PrismaClientValidationError in prod).
  it('does NOT call findTaskBySequenceNumber when iclassCodigo exceeds int4 range', async () => {
    const { scheduling, iclass, useCase } = setup();
    const spy = jest.spyOn(scheduling, 'findTaskBySequenceNumber');

    // Native IClass OS: codigo is huge (well beyond INT4_MAX = 2147483647)
    iclass.serviceOrders = [makeSummary({
      iclassId: '1234567890',
      iclassCodigo: '99999999999', // > 2147483647 — int4 overflow in prod
      statusCode: '3', statusDescription: 'Agendada',
    })];

    // Must NOT throw, must NOT call findTaskBySequenceNumber
    const counts = await useCase.execute();
    expect(spy).not.toHaveBeenCalled();
    // Treated as skippedNotClosed (non-terminal, no task match needed)
    expect(counts.skippedNotClosed).toBe(1);
  });
});

import { InMemoryIClassClient } from '@infrastructure/adapters/in-memory/InMemoryIClassClient';
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryStageRepository } from '@infrastructure/adapters/in-memory/InMemoryStageRepository';
import { InMemoryIClassResultCodeRepository } from '@infrastructure/adapters/in-memory/InMemoryIClassResultCodeRepository';
import { InMemoryClosedServiceOrderRepository } from '@infrastructure/adapters/in-memory/InMemoryClosedServiceOrderRepository';
import { InMemorySyncStateRepository } from '@infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import { InMemoryIClassPortal } from '@infrastructure/adapters/in-memory/InMemoryIClassPortal';
import { IClassPortalPort } from '@domain/ports/IClassPortalPort';
import { PostClosureComment } from '@application/use-cases/PostClosureComment';
import { ExtractDeviceInfoFromPhoto } from '@application/use-cases/ExtractDeviceInfoFromPhoto';
import { BuildInventorySuggestions } from '@application/use-cases/BuildInventorySuggestions';
import { InMemoryDevicePhotoOcr } from '@infrastructure/adapters/in-memory/InMemoryDevicePhotoOcr';
import { InMemoryOcrExtractionRepository } from '@infrastructure/adapters/in-memory/InMemoryOcrExtractionRepository';
import { InMemoryInventorySuggestionRepository } from '@infrastructure/adapters/in-memory/InMemoryInventorySuggestionRepository';
import { InMemoryTaskCommentRepository } from '@infrastructure/adapters/in-memory/InMemoryTaskCommentRepository';
import { InMemoryDeviceTypeCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryDeviceTypeCatalogRepository';
import { IngestClosedServiceOrders } from '@application/use-cases/IngestClosedServiceOrders';
import { ClosedServiceOrderSummary, SoStatusHistoryEntry } from '@domain/entities/iclass-closed-order';
import { Stage } from '@domain/entities/workflow';

const REGISTRADO: Stage = { id: 'st-reg', workflowId: 'wf', name: 'Registrado en IClass', code: 'registered_in_iclass', category: 'nuevo', order: 5, color: null };
const INSTALADO: Stage = { id: 'st-inst', workflowId: 'wf', name: 'Instalado', code: 'instalado', category: 'hecho', order: 8, color: null };
const FACTURADO: Stage = { id: 'st-fact', workflowId: 'wf', name: 'Facturado', code: 'facturado', category: 'hecho', order: 9, color: null };

function summary(over: Partial<ClosedServiceOrderSummary> & Pick<ClosedServiceOrderSummary, 'iclassId' | 'iclassCodigo'>): ClosedServiceOrderSummary {
  return {
    clusterName: 'IPNEXT INTERNET', thirdPartyCode: null, nodeCode: 'Mercedes', soTypeId: null, soTypeDescription: 'INSTALACION FIBRA',
    customerCode: '204382', customerName: 'Cliente X', addressCode: '204382', addressLine: 'Calle 1', addressCity: 'Mercedes',
    addressLat: null, addressLng: null, statusCode: '7', statusDescription: 'Concluida',
    requestedAt: null, scheduledFor: null, availableAt: null, serviceStartedAt: null, serviceEndedAt: null,
    resultCodeName: 'Instalacion Completa Fibra', closedByLogin: 'IPNXLUISS', closedByName: 'Luis',
    closeLatitude: null, closeLongitude: null, closeGpsAt: null, billingAmount: 0,
    technicianNote: 'ok', internalNote: null, commentaryLog: null,
    teamLogin: 'IPNXRODRIGOS', teamTechnicianName: 'Rodrigo', teamPhone: null, teamEmail: null,
    iclassCreatedAt: '2026-05-01T00:00:00.000Z', iclassUpdatedAt: '2026-05-21T17:49:12.000Z',
    rawDetail: {}, ...over,
  };
}

const HISTORY_CLOSED: SoStatusHistoryEntry[] = [
  { iclassOsStatusId: '1', occurredAt: '2026-05-20T10:00:00.000Z', statusCode: '4', statusDescription: 'FECHADA', durationMinutes: 0, teamLogin: 'x', commentary: null },
  { iclassOsStatusId: '2', occurredAt: '2026-05-21T17:49:11.000Z', statusCode: '7', statusDescription: 'ENCERRADO', durationMinutes: 0, teamLogin: 'x', commentary: null },
];

function setup() {
  const stages = new InMemoryStageRepository();
  stages.addDirect(REGISTRADO);
  stages.addDirect(INSTALADO);
  stages.addDirect(FACTURADO);
  const scheduling = new InMemorySchedulingRepository(stages);
  const iclass = new InMemoryIClassClient();
  const resultCodes = new InMemoryIClassResultCodeRepository();
  const closed = new InMemoryClosedServiceOrderRepository();
  const state = new InMemorySyncStateRepository();
  const useCase = new IngestClosedServiceOrders(iclass, closed, resultCodes, scheduling, state, { now: () => new Date('2026-05-29T12:00:00Z') });
  return { stages, scheduling, iclass, resultCodes, closed, state, useCase };
}

async function mapResultCode(resultCodes: InMemoryIClassResultCodeRepository, code: string, stageId: string) {
  await resultCodes.upsert({ soTypeId: '1', code, type: 'Sucesso' });
  const rc = await resultCodes.findByCode(code);
  await resultCodes.assignStage(rc!.id, stageId);
}

describe('IngestClosedServiceOrders', () => {
  it('mirrors a closed OS matched to a local task and moves it to the mapped stage', async () => {
    const { scheduling, iclass, resultCodes, closed, useCase } = setup();
    scheduling.seedTask({ id: 't1', sequenceNumber: 4013, stageId: REGISTRADO.id });
    iclass.serviceOrders = [summary({ iclassId: '101040413533', iclassCodigo: '4013' })];
    iclass.historyByOrder['101040413533'] = HISTORY_CLOSED;
    await mapResultCode(resultCodes, 'Instalacion Completa Fibra', INSTALADO.id);

    const counts = await useCase.execute();

    expect(counts.mirrored).toBe(1);
    expect(counts.transitioned).toBe(1);
    expect(closed.orders.get('101040413533')!.scheduledTaskId).toBe('t1');
    const task = await scheduling.getTask('t1');
    expect(task!.stageId).toBe(INSTALADO.id);
  });

  it('matches the result code case-insensitively + trimmed (IClass varies the casing of motivoFechamento)', async () => {
    const { scheduling, iclass, resultCodes, useCase } = setup();
    scheduling.seedTask({ id: 't1', sequenceNumber: 4013, stageId: REGISTRADO.id });
    // IClass returns the result-code name in a DIFFERENT case (+ stray spaces) than the operator's catalog.
    iclass.serviceOrders = [summary({ iclassId: '900', iclassCodigo: '4013', resultCodeName: '  CAMBIO DE DOMICILIO REALIZADO ' })];
    iclass.historyByOrder['900'] = HISTORY_CLOSED;
    // Catalog stored it capitalized — must still match and transition.
    await mapResultCode(resultCodes, 'Cambio de Domicilio Realizado', INSTALADO.id);

    const counts = await useCase.execute();

    expect(counts.transitioned).toBe(1);
    const task = await scheduling.getTask('t1');
    expect(task!.stageId).toBe(INSTALADO.id);
  });

  it('disambiguates the result code by soType when the same code maps differently per SO type', async () => {
    const { scheduling, iclass, resultCodes, useCase } = setup();
    scheduling.seedTask({ id: 't1', sequenceNumber: 4013, stageId: REGISTRADO.id });
    // Same code "Posponer", two SO types, DIFFERENT target stages.
    await resultCodes.upsert({ soTypeId: 'A', code: 'Posponer', type: 'Pendente' });
    await resultCodes.upsert({ soTypeId: 'B', code: 'Posponer', type: 'Pendente' });
    const all = await resultCodes.list();
    await resultCodes.assignStage(all.find(r => r.soTypeId === 'A')!.id, REGISTRADO.id); // type A → stays
    await resultCodes.assignStage(all.find(r => r.soTypeId === 'B')!.id, INSTALADO.id);  // type B → Instalado
    iclass.serviceOrders = [summary({ iclassId: '900', iclassCodigo: '4013', soTypeId: 'B', resultCodeName: 'Posponer' })];
    iclass.historyByOrder['900'] = HISTORY_CLOSED;

    const counts = await useCase.execute();

    expect(counts.transitioned).toBe(1);
    expect((await scheduling.getTask('t1'))!.stageId).toBe(INSTALADO.id); // soType B's mapping, not A's
  });

  it('falls back to a name-only match when the SO carries no soTypeId', async () => {
    const { scheduling, iclass, resultCodes, useCase } = setup();
    scheduling.seedTask({ id: 't1', sequenceNumber: 4013, stageId: REGISTRADO.id });
    await mapResultCode(resultCodes, 'Instalacion Completa Fibra', INSTALADO.id); // catalogued under soTypeId '1'
    iclass.serviceOrders = [summary({ iclassId: '900', iclassCodigo: '4013', soTypeId: null })]; // no soType on the SO
    iclass.historyByOrder['900'] = HISTORY_CLOSED;

    const counts = await useCase.execute();

    expect(counts.transitioned).toBe(1);
    expect((await scheduling.getTask('t1'))!.stageId).toBe(INSTALADO.id);
  });

  it('dedupes a repeated status-history entry before mirroring (IClass returns a transition twice)', async () => {
    const { scheduling, iclass, closed, useCase } = setup();
    scheduling.seedTask({ id: 't1', sequenceNumber: 4013, stageId: REGISTRADO.id });
    iclass.serviceOrders = [summary({ iclassId: '900', iclassCodigo: '4013' })];
    iclass.historyByOrder['900'] = [HISTORY_CLOSED[0], HISTORY_CLOSED[1], { ...HISTORY_CLOSED[1] }]; // id '2' twice

    const counts = await useCase.execute();

    expect(counts.mirrored).toBe(1);
    expect(closed.orders.get('900')!.order.history.map((h) => h.iclassOsStatusId)).toEqual(['1', '2']);
  });

  it('isolates a failing SO: logs it, counts it, and still processes the rest', async () => {
    const { scheduling, iclass, closed, useCase } = setup();
    scheduling.seedTask({ id: 't1', sequenceNumber: 4013, stageId: REGISTRADO.id });
    scheduling.seedTask({ id: 't2', sequenceNumber: 4014, stageId: REGISTRADO.id });
    iclass.serviceOrders = [summary({ iclassId: 'A', iclassCodigo: '4013' }), summary({ iclassId: 'B', iclassCodigo: '4014' })];
    iclass.historyByOrder['A'] = HISTORY_CLOSED;
    iclass.historyByOrder['B'] = HISTORY_CLOSED;
    const realUpsert = closed.upsert.bind(closed);
    closed.upsert = async (order, taskId) => {
      if (order.iclassId === 'A') throw new Error('boom');
      return realUpsert(order, taskId);
    };
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const counts = await useCase.execute(); // must NOT throw

    expect(counts.errored).toBe(1);
    expect(counts.mirrored).toBe(1);
    expect(closed.orders.has('B')).toBe(true);
    expect(closed.orders.has('A')).toBe(false);
  });

  it('derives closedAt from the status-7 history entry', async () => {
    const { scheduling, iclass, resultCodes, closed, useCase } = setup();
    scheduling.seedTask({ id: 't1', sequenceNumber: 4013, stageId: REGISTRADO.id });
    iclass.serviceOrders = [summary({ iclassId: '900', iclassCodigo: '4013' })];
    iclass.historyByOrder['900'] = HISTORY_CLOSED;
    await mapResultCode(resultCodes, 'Instalacion Completa Fibra', INSTALADO.id);

    await useCase.execute();
    const stored = closed.orders.get('900')!.order;
    expect(stored.closedAt).toBe('2026-05-21T17:49:11.000Z');
    expect(stored.firstClosedAt).toBe('2026-05-20T10:00:00.000Z');
    expect(stored.resultCodeType).toBe('Sucesso');
  });

  it('skips a non-closed OS (statusCode != 7)', async () => {
    const { scheduling, iclass, useCase, closed } = setup();
    scheduling.seedTask({ id: 't1', sequenceNumber: 4013, stageId: REGISTRADO.id });
    iclass.serviceOrders = [summary({ iclassId: '900', iclassCodigo: '4013', statusCode: '3', statusDescription: 'Andamento' })];

    const counts = await useCase.execute();
    expect(counts.skippedNotClosed).toBe(1);
    expect(counts.mirrored).toBe(0);
    expect(closed.orders.size).toBe(0);
  });

  it('skips an OS that is not ours (codigo == iclass id, no matching task)', async () => {
    const { iclass, useCase, closed } = setup();
    iclass.serviceOrders = [summary({ iclassId: '101040485363', iclassCodigo: '101040485363' })];

    const counts = await useCase.execute();
    expect(counts.skippedNotOurs).toBe(1);
    expect(closed.orders.size).toBe(0);
  });

  it('is idempotent: a second run with the same iclassUpdatedAt skips', async () => {
    const { scheduling, iclass, resultCodes, useCase } = setup();
    scheduling.seedTask({ id: 't1', sequenceNumber: 4013, stageId: REGISTRADO.id });
    iclass.serviceOrders = [summary({ iclassId: '900', iclassCodigo: '4013' })];
    iclass.historyByOrder['900'] = HISTORY_CLOSED;
    await mapResultCode(resultCodes, 'Instalacion Completa Fibra', INSTALADO.id);

    const first = await useCase.execute();
    const second = await useCase.execute();
    expect(first.mirrored).toBe(1);
    expect(second.mirrored).toBe(0);
    expect(second.skippedUnchanged).toBe(1);
  });

  it('reconciles a stuck task on an UNCHANGED SO: transitions it once the mapping exists (no re-mirror, no side-effects)', async () => {
    const { scheduling, iclass, resultCodes, closed, useCase } = setup();
    scheduling.seedTask({ id: 't1', sequenceNumber: 4013, stageId: REGISTRADO.id });
    iclass.serviceOrders = [summary({ iclassId: '900', iclassCodigo: '4013' })];
    iclass.historyByOrder['900'] = HISTORY_CLOSED;

    // First run: result code NOT mapped yet → mirrors but the task stays in REGISTRADO.
    const first = await useCase.execute();
    expect(first.mirrored).toBe(1);
    expect(first.transitioned).toBe(0);
    expect((await scheduling.getTask('t1'))!.stageId).toBe(REGISTRADO.id);

    // Operator maps the result code AFTER the OS was already mirrored.
    await mapResultCode(resultCodes, 'Instalacion Completa Fibra', INSTALADO.id);

    // Second run: SO unchanged (same iclassUpdatedAt) → skippedUnchanged, but the
    // stuck task is reconciled to the now-mapped stage. No re-mirror.
    const before = closed.orders.get('900')!.order;
    const second = await useCase.execute();
    expect(second.skippedUnchanged).toBe(1);
    expect(second.transitioned).toBe(1);
    expect((await scheduling.getTask('t1'))!.stageId).toBe(INSTALADO.id);
    expect(closed.orders.get('900')!.order).toBe(before); // mirror untouched
  });

  it('does NOT reconcile a task that already left the in-flight stage (respects manual placement)', async () => {
    const { scheduling, iclass, resultCodes, useCase } = setup();
    scheduling.seedTask({ id: 't1', sequenceNumber: 4013, stageId: REGISTRADO.id });
    iclass.serviceOrders = [summary({ iclassId: '900', iclassCodigo: '4013' })];
    iclass.historyByOrder['900'] = HISTORY_CLOSED;
    await mapResultCode(resultCodes, 'Instalacion Completa Fibra', INSTALADO.id);
    await useCase.execute(); // mirrors + transitions to INSTALADO

    // Operator manually parks it in a DIFFERENT stage (not the in-flight one).
    await scheduling.moveTaskToStage('t1', FACTURADO.id);

    // Re-run on the unchanged SO → must NOT yank it back to INSTALADO.
    const second = await useCase.execute();
    expect(second.skippedUnchanged).toBe(1);
    expect(second.transitioned).toBe(0);
    expect((await scheduling.getTask('t1'))!.stageId).toBe(FACTURADO.id);
  });

  it('mirrors but does NOT move the task when the result code has no mapped stage', async () => {
    const { scheduling, iclass, useCase, closed } = setup();
    scheduling.seedTask({ id: 't1', sequenceNumber: 4013, stageId: REGISTRADO.id });
    iclass.serviceOrders = [summary({ iclassId: '900', iclassCodigo: '4013' })];
    iclass.historyByOrder['900'] = HISTORY_CLOSED;
    // result code exists but is NOT mapped to a stage
    await iclass; // no-op
    // (no mapResultCode call)

    const counts = await useCase.execute();
    expect(counts.mirrored).toBe(1);
    expect(counts.transitioned).toBe(0);
    const task = await scheduling.getTask('t1');
    expect(task!.stageId).toBe(REGISTRADO.id); // unchanged
    expect(closed.orders.get('900')!.scheduledTaskId).toBe('t1');
  });

  it('saves run counts to SyncState under iclass-closed', async () => {
    const { scheduling, iclass, resultCodes, state, useCase } = setup();
    scheduling.seedTask({ id: 't1', sequenceNumber: 4013, stageId: REGISTRADO.id });
    iclass.serviceOrders = [summary({ iclassId: '900', iclassCodigo: '4013' })];
    iclass.historyByOrder['900'] = HISTORY_CLOSED;
    await mapResultCode(resultCodes, 'Instalacion Completa Fibra', INSTALADO.id);

    await useCase.execute();
    const saved = await state.get('iclass-closed');
    expect(saved).not.toBeNull();
    expect(JSON.parse(saved!.lastResult!).mirrored).toBe(1);
  });

  it('correlates checklist photos from the portal by ordem (when a portal is provided)', async () => {
    const { scheduling, iclass, resultCodes, closed, state } = setup();
    scheduling.seedTask({ id: 't1', sequenceNumber: 4013, stageId: REGISTRADO.id });
    iclass.serviceOrders = [summary({ iclassId: '900', iclassCodigo: '4013' })];
    iclass.historyByOrder['900'] = HISTORY_CLOSED;
    iclass.checklistsByOrder['900'] = [{
      iclassSurveyId: 's1', surveyAt: null,
      answers: [{ questionId: null, questionText: 'FOTO ROUTER', questionType: 'Foto', answerOrder: 3, answerText: null, photoMissing: true, photoUrl: null }],
    }];
    const portal = new InMemoryIClassPortal();
    portal.set('900', {
      questions: [{ ordem: 3, kind: 'photo', label: 'FOTO ROUTER', answerText: null, photoUrl: 'https://x/router.jpg', fileName: 'r.jpg', photoMissing: false }],
      attachments: [],
    });
    const useCase = new IngestClosedServiceOrders(iclass, closed, resultCodes, scheduling, state, { now: () => new Date('2026-05-29T12:00:00Z'), portal });

    await useCase.execute();

    expect(closed.orders.get('900')!.order.checklists[0].answers[0].photoUrl).toBe('https://x/router.jpg');
  });

  it('SCEN-CO-3: still mirrors when the portal throws (photoUrl stays null, retried next run)', async () => {
    const { scheduling, iclass, resultCodes, closed, state } = setup();
    scheduling.seedTask({ id: 't1', sequenceNumber: 4013, stageId: REGISTRADO.id });
    iclass.serviceOrders = [summary({ iclassId: '900', iclassCodigo: '4013' })];
    iclass.historyByOrder['900'] = HISTORY_CLOSED;
    iclass.checklistsByOrder['900'] = [{
      iclassSurveyId: 's1', surveyAt: null,
      answers: [{ questionId: null, questionText: 'FOTO ROUTER', questionType: 'Foto', answerOrder: 3, answerText: null, photoMissing: true, photoUrl: null }],
    }];
    const portal: IClassPortalPort = { getOSDetail: async () => { throw new Error('SEAM down'); } };
    const useCase = new IngestClosedServiceOrders(iclass, closed, resultCodes, scheduling, state, { now: () => new Date('2026-05-29T12:00:00Z'), portal });

    const counts = await useCase.execute();

    expect(counts.mirrored).toBe(1);
    expect(closed.orders.get('900')!.order.checklists[0].answers[0].photoUrl).toBeNull();
  });

  it('marks the side-effect tracking columns on the mirror after a successful closure', async () => {
    const { scheduling, iclass, resultCodes, closed, state } = setup();
    scheduling.seedTask({ id: 't1', sequenceNumber: 4013, stageId: REGISTRADO.id });
    iclass.serviceOrders = [summary({ iclassId: '900', iclassCodigo: '4013' })];
    iclass.historyByOrder['900'] = HISTORY_CLOSED;
    const commentRepo = new InMemoryTaskCommentRepository();
    const useCase = new IngestClosedServiceOrders(iclass, closed, resultCodes, scheduling, state, {
      now: () => new Date('2026-05-29T12:00:00Z'),
      postComment: new PostClosureComment(commentRepo),
    });

    await useCase.execute();

    // comment posted → marked; no buildSuggestions/audit injected → those stay false.
    expect(await closed.getSideEffectState('900')).toEqual({
      commentPosted: true, inventoryBuilt: false, auditDone: false, auditAttempts: 0,
    });
  });

  it('orchestrates closure side effects: OCR → suggestions + auto-comment (all opt-in, non-fatal)', async () => {
    const { scheduling, iclass, resultCodes, closed, state } = setup();
    scheduling.seedTask({ id: 't1', sequenceNumber: 4013, stageId: REGISTRADO.id, contractId: 'svc1' });
    iclass.serviceOrders = [summary({ iclassId: '900', iclassCodigo: '4013' })];
    iclass.historyByOrder['900'] = HISTORY_CLOSED;
    iclass.checklistsByOrder['900'] = [{
      iclassSurveyId: 's1', surveyAt: null,
      answers: [{ questionId: null, questionText: 'SAQUE FOTO DE LA MAC Y SN DEL ROUTER', questionType: 'Foto', answerOrder: 3, answerText: null, photoMissing: true, photoUrl: null }],
    }];

    const portal = new InMemoryIClassPortal();
    portal.set('900', {
      questions: [{ ordem: 3, kind: 'photo', label: 'FOTO ROUTER', answerText: null, photoUrl: 'https://x/router.jpg', fileName: 'r.jpg', photoMissing: false }],
      attachments: [{ url: 'https://x/firma.jpg', label: 'firma' }],
    });

    const ocrStub = new InMemoryDevicePhotoOcr();
    ocrStub.set('https://x/router.jpg', { sn: 'SN1', mac: 'MAC1', confidence: 0.9, rawOutput: '' });
    const ocrRepo = new InMemoryOcrExtractionRepository();
    const suggestionsRepo = new InMemoryInventorySuggestionRepository();
    const commentRepo = new InMemoryTaskCommentRepository();
    const catalogRepo = new InMemoryDeviceTypeCatalogRepository();
    for (const name of ['ONU', 'ROUTER', 'ANTENA', 'REPETIDOR', 'OTROS']) {
      await catalogRepo.create({ name, active: true, sortOrder: 0 });
    }

    const useCase = new IngestClosedServiceOrders(iclass, closed, resultCodes, scheduling, state, {
      now: () => new Date('2026-05-29T12:00:00Z'),
      portal,
      extractOcr: new ExtractDeviceInfoFromPhoto(ocrStub, ocrRepo, catalogRepo),
      buildSuggestions: new BuildInventorySuggestions(suggestionsRepo),
      postComment: new PostClosureComment(commentRepo),
    });

    await useCase.execute();

    // OCR ran on the device photo
    expect(await ocrRepo.findByPhotoUrl('https://x/router.jpg')).not.toBeNull();
    // suggestion built from OCR
    const sugs = await suggestionsRepo.listByTask('t1');
    expect(sugs.some(s => s.kind === 'DEVICE' && s.deviceType === 'ROUTER' && s.serialNumber === 'SN1')).toBe(true);
    // readable comment posted with checklist photo + signature attachments
    const comments = await commentRepo.listByTask('t1');
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain('OS 4013');
    expect(comments[0].attachments.map(a => a.url)).toEqual(expect.arrayContaining(['https://x/router.jpg', 'https://x/firma.jpg']));
  });

  it('#22: a technical OCR failure leaves inventoryBuilt false (pending) and creates NO device suggestion', async () => {
    const { scheduling, iclass, resultCodes, closed, state } = setup();
    scheduling.seedTask({ id: 't1', sequenceNumber: 4013, stageId: REGISTRADO.id, contractId: 'svc1' });
    iclass.serviceOrders = [summary({ iclassId: '900', iclassCodigo: '4013' })];
    iclass.historyByOrder['900'] = HISTORY_CLOSED;
    iclass.checklistsByOrder['900'] = [{
      iclassSurveyId: 's1', surveyAt: null,
      answers: [{ questionId: null, questionText: 'SAQUE FOTO DE LA MAC Y SN DEL ROUTER', questionType: 'Foto', answerOrder: 3, answerText: null, photoMissing: true, photoUrl: null }],
    }];

    const portal = new InMemoryIClassPortal();
    portal.set('900', {
      questions: [{ ordem: 3, kind: 'photo', label: 'FOTO ROUTER', answerText: null, photoUrl: 'https://x/router.jpg', fileName: 'r.jpg', photoMissing: false }],
      attachments: [],
    });

    const ocrStub = new InMemoryDevicePhotoOcr();
    ocrStub.set('https://x/router.jpg', { sn: null, mac: null, confidence: 0, rawOutput: 'ocr-error: down', failed: true });
    const ocrRepo = new InMemoryOcrExtractionRepository();
    const suggestionsRepo = new InMemoryInventorySuggestionRepository();
    const catalogRepo = new InMemoryDeviceTypeCatalogRepository();
    for (const name of ['ONU', 'ROUTER', 'ANTENA', 'REPETIDOR', 'OTROS']) {
      await catalogRepo.create({ name, active: true, sortOrder: 0 });
    }

    const useCase = new IngestClosedServiceOrders(iclass, closed, resultCodes, scheduling, state, {
      now: () => new Date('2026-05-29T12:00:00Z'),
      portal,
      extractOcr: new ExtractDeviceInfoFromPhoto(ocrStub, ocrRepo, catalogRepo),
      buildSuggestions: new BuildInventorySuggestions(suggestionsRepo),
    });

    await useCase.execute();

    // technical failure → not cached, NOT built (stays pending for reprocess), no incomplete device suggestion
    expect(await ocrRepo.findByPhotoUrl('https://x/router.jpg')).toBeNull();
    expect((await closed.getSideEffectState('900'))?.inventoryBuilt).toBe(false);
    const sugs = await suggestionsRepo.listByTask('t1');
    expect(sugs.some(s => s.kind === 'DEVICE')).toBe(false);
  });

  it('#14: marks closureCommentDone + closureHasDeviceInventory on the task after closure', async () => {
    const { scheduling, iclass, resultCodes, closed, state } = setup();
    scheduling.seedTask({ id: 't1', sequenceNumber: 4013, stageId: REGISTRADO.id, contractId: 'svc1' });
    iclass.serviceOrders = [summary({ iclassId: '900', iclassCodigo: '4013' })];
    iclass.historyByOrder['900'] = HISTORY_CLOSED;
    iclass.checklistsByOrder['900'] = [{
      iclassSurveyId: 's1', surveyAt: null,
      answers: [{ questionId: null, questionText: 'SAQUE FOTO DE LA MAC Y SN DEL ROUTER', questionType: 'Foto', answerOrder: 3, answerText: null, photoMissing: true, photoUrl: null }],
    }];

    const portal = new InMemoryIClassPortal();
    portal.set('900', {
      questions: [{ ordem: 3, kind: 'photo', label: 'FOTO ROUTER', answerText: null, photoUrl: 'https://x/router.jpg', fileName: 'r.jpg', photoMissing: false }],
      attachments: [],
    });

    const ocrStub = new InMemoryDevicePhotoOcr();
    ocrStub.set('https://x/router.jpg', { sn: 'SN1', mac: 'MAC1', confidence: 0.9, rawOutput: '' });
    const ocrRepo = new InMemoryOcrExtractionRepository();
    const suggestionsRepo = new InMemoryInventorySuggestionRepository();
    const commentRepo = new InMemoryTaskCommentRepository();
    const catalogRepo = new InMemoryDeviceTypeCatalogRepository();
    for (const name of ['ONU', 'ROUTER', 'ANTENA', 'REPETIDOR', 'OTROS']) {
      await catalogRepo.create({ name, active: true, sortOrder: 0 });
    }

    const useCase = new IngestClosedServiceOrders(iclass, closed, resultCodes, scheduling, state, {
      now: () => new Date('2026-05-29T12:00:00Z'),
      portal,
      extractOcr: new ExtractDeviceInfoFromPhoto(ocrStub, ocrRepo, catalogRepo),
      buildSuggestions: new BuildInventorySuggestions(suggestionsRepo),
      suggestions: suggestionsRepo,
      postComment: new PostClosureComment(commentRepo),
    });

    await useCase.execute();

    const task = await scheduling.getTask('t1');
    expect(task!.closureCommentDone).toBe(true);
    expect(task!.closureHasDeviceInventory).toBe(true);
    expect(task!.closureAuditDone).toBe(false); // no audit injected → stays false
  });
});

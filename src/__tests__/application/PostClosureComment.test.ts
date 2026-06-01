import { PostClosureComment, ICLASS_SYSTEM_AUTHOR } from '@application/use-cases/PostClosureComment';
import { InMemoryTaskCommentRepository } from '@infrastructure/adapters/in-memory/InMemoryTaskCommentRepository';
import { ClosedServiceOrder, SoChecklist } from '@domain/entities/iclass-closed-order';

function order(over: Partial<ClosedServiceOrder> = {}): ClosedServiceOrder {
  return {
    iclassId: '900',
    iclassCodigo: '4013',
    clusterName: 'IPNEXT INTERNET',
    thirdPartyCode: null, nodeCode: null, soTypeDescription: null,
    customerCode: null, customerName: null, addressCode: null, addressLine: null,
    addressCity: null, addressLat: null, addressLng: null,
    statusCode: '7', statusDescription: 'ENCERRADO',
    requestedAt: null, scheduledFor: null, availableAt: null,
    serviceStartedAt: null, serviceEndedAt: null,
    resultCodeName: null, closedByLogin: null, closedByName: null,
    closeLatitude: null, closeLongitude: null, closeGpsAt: null, billingAmount: null,
    technicianNote: null, internalNote: null, commentaryLog: null,
    teamLogin: null, teamTechnicianName: null, teamPhone: null, teamEmail: null,
    iclassCreatedAt: null, iclassUpdatedAt: null, rawDetail: {},
    closedAt: null, firstClosedAt: null, approvedAt: null, resultCodeType: null,
    history: [], checklists: [], materials: [], equipmentEvents: [],
    ...over,
  };
}

const checklist = (answers: SoChecklist['answers']): SoChecklist => ({
  iclassSurveyId: 's1', surveyAt: null, answers,
});

describe('PostClosureComment', () => {
  it('SCEN-PC-1: posts a readable comment with text Q&A + photo/signature attachments', async () => {
    const repo = new InMemoryTaskCommentRepository();
    const uc = new PostClosureComment(repo);
    const o = order({
      iclassCodigo: '4013',
      closedByName: 'TEC DEMO',
      resultCodeName: 'Instalacion Completa Wireless',
      checklists: [checklist([
        { questionId: null, questionText: 'MATERIALES', questionType: 'Texto', answerOrder: 0, answerText: 'utp 30', photoMissing: false, photoUrl: null },
        { questionId: null, questionText: 'FOTO ROUTER', questionType: 'Foto', answerOrder: 3, answerText: null, photoMissing: false, photoUrl: 'https://x/router.jpg' },
      ])],
    });

    const comment = await uc.execute({ taskId: 't1', order: o, attachmentUrls: ['https://x/firma.jpg'] });

    expect(comment).not.toBeNull();
    expect(comment!.authorName).toBe(ICLASS_SYSTEM_AUTHOR);
    expect(comment!.body).toContain('OS 4013');
    expect(comment!.body).toContain('Técnico: TEC DEMO');
    expect(comment!.body).toContain('Motivo: Instalacion Completa Wireless');
    expect(comment!.body).toContain('MATERIALES: utp 30');
    // attachments: checklist photo + signature; the Foto question is NOT in the Q&A body
    expect(comment!.attachments.map(a => a.url)).toEqual(['https://x/router.jpg', 'https://x/firma.jpg']);
    expect(comment!.body).not.toContain('FOTO ROUTER');
  });

  it('SCEN-PC-2: idempotent — a second run does not double-post', async () => {
    const repo = new InMemoryTaskCommentRepository();
    const uc = new PostClosureComment(repo);
    const o = order({ resultCodeName: 'X' });

    const first = await uc.execute({ taskId: 't1', order: o });
    const second = await uc.execute({ taskId: 't1', order: o });

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(await repo.listByTask('t1')).toHaveLength(1);
  });

  it('SCEN-PC-3: OS with no text answers still posts a minimal comment, no throw', async () => {
    const repo = new InMemoryTaskCommentRepository();
    const uc = new PostClosureComment(repo);

    const comment = await uc.execute({ taskId: 't1', order: order({ resultCodeName: 'Tarea No Factible' }) });

    expect(comment).not.toBeNull();
    expect(comment!.body).toContain('Motivo: Tarea No Factible');
    expect(comment!.attachments).toEqual([]);
  });
});

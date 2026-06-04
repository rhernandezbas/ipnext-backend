import { PostClosureComment, ICLASS_SYSTEM_AUTHOR } from '@application/use-cases/PostClosureComment';
import { InMemoryTaskCommentRepository } from '@infrastructure/adapters/in-memory/InMemoryTaskCommentRepository';
import { ClosedServiceOrder, SoChecklist } from '@domain/entities/iclass-closed-order';

function order(over: Partial<ClosedServiceOrder> = {}): ClosedServiceOrder {
  return {
    iclassId: '900',
    iclassCodigo: '4013',
    clusterName: 'IPNEXT INTERNET',
    thirdPartyCode: null, nodeCode: null, soTypeId: null, soTypeDescription: null,
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
      teamTechnicianName: 'TEC DEMO',
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

describe('PostClosureComment — técnico (F1)', () => {
  const run = async (over: Partial<ClosedServiceOrder>): Promise<string> => {
    const repo = new InMemoryTaskCommentRepository();
    const c = await new PostClosureComment(repo).execute({ taskId: 't1', order: order(over) });
    return c!.body;
  };

  it('muestra al técnico de campo (teamTechnicianName) y "Cerró" cuando difieren', async () => {
    const b = await run({ teamTechnicianName: 'Rodrigo', closedByName: 'luis Sarcos' });
    expect(b).toContain('Técnico: Rodrigo');
    expect(b).toContain('Cerró: luis Sarcos');
  });

  it('solo técnico de campo → muestra Técnico sin "Cerró"', async () => {
    const b = await run({ teamTechnicianName: 'Rodrigo' });
    expect(b).toContain('Técnico: Rodrigo');
    expect(b).not.toContain('Cerró:');
  });

  it('misma persona cerró y ejecutó → omite "Cerró"', async () => {
    const b = await run({ teamTechnicianName: 'Rodrigo', closedByName: 'Rodrigo' });
    expect(b).toContain('Técnico: Rodrigo');
    expect(b).not.toContain('Cerró:');
  });

  it('sin técnico de campo → cae a "Cerró" con el que cerró', async () => {
    const b = await run({ closedByName: 'luis Sarcos' });
    expect(b).toContain('Cerró: luis Sarcos');
    expect(b).not.toContain('Técnico:');
  });

  it('sin ninguno → no emite línea de técnico', async () => {
    const b = await run({});
    expect(b).not.toContain('Técnico:');
    expect(b).not.toContain('Cerró:');
  });
});

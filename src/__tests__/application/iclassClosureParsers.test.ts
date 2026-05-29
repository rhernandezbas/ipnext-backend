import {
  parseServiceOrderSummary,
  parseHistoryEntry,
  parseChecklist,
  parseResultCode,
  parseIClassDate,
  isRateLimited,
  formatListDate,
} from '@infrastructure/adapters/iclass/IClassClient';

// Real payloads captured live from IClass v2 on 2026-05-29 (install SO codigo 4013).
const REAL_SO = {
  id: 101040413533,
  codigo: '4013',
  contrato: { codigo: '204382', nomeTitular: 'ARZOBISPADO DE MERCEDES-LUJAN' },
  endereco: { id: 990185693, codigo: '204382', logradouro: '22 745, Mercedes, 6600', cidade: 'Mercedes', pais: 'AR', latitude: -34.65159, longitude: -59.43312 },
  node: { codigo: 'Mercedes', descricao: 'Mercedes' },
  equipe: { login: 'IPNXRODRIGOS', tecnico: 'Rodrigo Sosa', fone1: '+541128183852', email: 'bebososa02@gmail.com' },
  status: { id: 7, descricao: 'Concluida' },
  criadoPor: { nome: 'IPNXAPI - IClass', login: 'IPNXAPI', data: '30-04-2026 11:00:11' },
  alteradoPor: { nome: 'luis Sarcos', login: 'IPNXLUISS', data: '21-05-2026 14:49:12' },
  coordenadasFechamento: {},
  tipoOs: { descricao: 'INSTALACION FIBRA-PADRON-PADRON-PADRON', resumoTipoOs: 'INSTALACION FIBRA' },
  motivoFechamento: 'Instalacion Completa Fibra',
  obs: 'INSTALACION A REALIZAR EN OFICINA',
  obsEquipe: 'ok',
  comentario: '[IPNXLUISS - 11/05/2026 03:00:47 America/Buenos_Aires]: PENDIENTE',
  valorCobranca: 0,
  dataAgendamento: '21-05-2026 00:00:00',
  dataSolicitacao: '30-04-2026 11:00:11',
  dataDisponibilidade: '21-05-2026 11:30:00',
};

const REAL_HISTORY = {
  osStatusId: 15407886502,
  data: '21-05-2026 14:49:11',
  equipeDTO: { login: 'IPNXRODRIGOS', tecnico: 'Rodrigo Sosa' },
  statusOS: { codigo: '7', descricao: 'ENCERRADO' },
  tempoStatus: 0,
};

const REAL_CHECKLIST = {
  pesquisaId: 243692190673731070,
  dataPesquisa: '2026-05-08T16:31:10.000+00:00',
  perguntas: [
    { pesqPerguntaId: 33673693, pergunta: 'DESCRIBA LOS MATERIALES', resposta: { ordem: 0, resposta: 'drop 70 mts\n', tipoPergunta: 'Texto' } },
    { pesqPerguntaId: 33673999, pergunta: 'SAQUE FOTO DE LA ANTENA', resposta: { ordem: 2, tipoPergunta: 'Foto' } },
  ],
};

describe('parseIClassDate', () => {
  it('parses dd-MM-yyyy HH:mm:ss as Buenos Aires (-03:00)', () => {
    expect(parseIClassDate('21-05-2026 14:49:11')).toBe('2026-05-21T17:49:11.000Z');
  });
  it('passes through an ISO input', () => {
    expect(parseIClassDate('2026-05-08T16:31:10.000+00:00')).toBe('2026-05-08T16:31:10.000Z');
  });
  it('returns null for empty/garbage', () => {
    expect(parseIClassDate('')).toBeNull();
    expect(parseIClassDate(undefined)).toBeNull();
    expect(parseIClassDate('not a date')).toBeNull();
  });
});

describe('parseServiceOrderSummary', () => {
  const s = parseServiceOrderSummary(REAL_SO, 'IPNEXT INTERNET');
  it('keeps iclassId as string and codigo (our sequenceNumber)', () => {
    expect(s.iclassId).toBe('101040413533');
    expect(s.iclassCodigo).toBe('4013');
  });
  it('injects clusterName (not present in the payload)', () => {
    expect(s.clusterName).toBe('IPNEXT INTERNET');
  });
  it('maps customer, address and node', () => {
    expect(s.customerCode).toBe('204382');
    expect(s.customerName).toBe('ARZOBISPADO DE MERCEDES-LUJAN');
    expect(s.addressLine).toBe('22 745, Mercedes, 6600');
    expect(s.addressCity).toBe('Mercedes');
    expect(s.addressLat).toBe(-34.65159);
    expect(s.nodeCode).toBe('Mercedes');
  });
  it('maps status, result code and team', () => {
    expect(s.statusCode).toBe('7');
    expect(s.resultCodeName).toBe('Instalacion Completa Fibra');
    expect(s.teamLogin).toBe('IPNXRODRIGOS');
    expect(s.teamTechnicianName).toBe('Rodrigo Sosa');
  });
  it('maps notes and uses alteradoPor as the idempotency watermark', () => {
    expect(s.technicianNote).toBe('ok');
    expect(s.internalNote).toContain('INSTALACION');
    expect(s.iclassUpdatedAt).toBe('2026-05-21T17:49:12.000Z');
  });
  it('maps an empty coordenadasFechamento to null close GPS', () => {
    expect(s.closeLatitude).toBeNull();
    expect(s.closeGpsAt).toBeNull();
  });
  it('keeps the raw payload', () => {
    expect(s.rawDetail).toBe(REAL_SO);
  });
});

describe('parseHistoryEntry', () => {
  const h = parseHistoryEntry(REAL_HISTORY);
  it('maps the status code (7) and team login from equipeDTO', () => {
    expect(h.iclassOsStatusId).toBe('15407886502');
    expect(h.statusCode).toBe('7');
    expect(h.teamLogin).toBe('IPNXRODRIGOS');
    expect(h.occurredAt).toBe('2026-05-21T17:49:11.000Z');
  });
});

describe('parseChecklist', () => {
  const c = parseChecklist(REAL_CHECKLIST);
  it('preserves the huge survey id as a string', () => {
    expect(c.iclassSurveyId).toBe('243692190673731070');
  });
  it('maps a text answer', () => {
    const txt = c.answers[0];
    expect(txt.questionType).toBe('Texto');
    expect(txt.answerText).toContain('drop 70');
    expect(txt.photoMissing).toBe(false);
  });
  it('flags a photo answer as photoMissing with null text', () => {
    const photo = c.answers[1];
    expect(photo.questionType).toBe('Foto');
    expect(photo.answerText).toBeNull();
    expect(photo.photoMissing).toBe(true);
    expect(photo.answerOrder).toBe(2);
  });
});

describe('parseResultCode', () => {
  it('maps codigo→code and tipo→type', () => {
    const rc = parseResultCode({ codigo: 'Instalacion Completa Fibra', tipo: 'Sucesso' }, '37092001');
    expect(rc).toEqual({ soTypeId: '37092001', code: 'Instalacion Completa Fibra', type: 'Sucesso' });
  });
});

describe('helpers', () => {
  it('formatListDate uses dd-MM-yyyy HH:mm', () => {
    expect(formatListDate(new Date('2026-05-21T14:05:00-03:00'))).toMatch(/^21-05-2026 \d{2}:\d{2}$/);
  });
  it('isRateLimited detects the textual notice', () => {
    expect(isRateLimited('Espere um pouco antes de fazer outra requisição')).toBe(true);
    expect(isRateLimited({ objects: [] })).toBe(false);
  });
});

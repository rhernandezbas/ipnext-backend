/**
 * bulk-csv-recipients (B1.2/B2.3, CSV-1..CSV-6) — `resolveCombinedRecipients`
 * extendido a 3 fuentes (segmento, manualClientIds, manualContacts) +
 * `normalizeManualContacts`. Molde `CreateCampaign.test.ts`/
 * `PreviewCampaignSegment.test.ts` (fakes inline, T3.2/T3.3 pattern).
 */
import {
  resolveCombinedRecipients,
  normalizeManualContacts,
  MAX_MANUAL_CONTACTS,
  MAX_TASK_STATE_RECIPIENTS,
} from '@application/use-cases/messaging/resolveCombinedRecipients';
import { TooManyManualContactsError, TooManyTaskStateRecipientsError } from '@domain/errors/messaging-bulk';
import type { CampaignSegmentSource, CampaignRecipientCandidate, CampaignSegmentFilter, ManualRecipientSource } from '@domain/ports/CustomerRepository';
import type { TaskRecipientSource } from '@domain/ports/TaskRecipientSource';

function makeCandidate(overrides: Partial<CampaignRecipientCandidate> = {}): CampaignRecipientCandidate {
  return {
    clientId: 'c-default',
    name: 'Default',
    phone: '3364000000',
    balanceDue: 1000,
    whatsappOptOutAt: null,
    status: 'active',
    ...overrides,
  };
}

function makeSegmentSource(universe: CampaignRecipientCandidate[]): CampaignSegmentSource {
  return {
    listSegmentRecipients: async (segment: CampaignSegmentFilter) => {
      if (segment.statuses.length === 0) return universe; // escape hatch OPT-2 (D3) o "sin criterio"
      return universe.filter((c) => segment.statuses.includes(c.status ?? ''));
    },
  };
}

function makeManualSource(candidates: CampaignRecipientCandidate[]): ManualRecipientSource {
  return {
    findRecipientCandidatesByIds: async (ids: string[]) => candidates.filter((c) => ids.includes(c.clientId)),
  };
}

/**
 * bulk-task-recipients (B5.2) — fake narrow del 5to dominio "Tarea". El
 * DISTINCT/isClosed/customerId-null ya está garantizado por el PORT (tested
 * en `InMemoryTaskRecipientSource`, B2.4) — acá alcanza con devolver
 * directamente el resultado YA distinct que el port prometería.
 */
function makeTaskSource(clientIds: string[], noCustomerCount = 0): TaskRecipientSource {
  return {
    listClientIdsByOpenTaskStages: jest.fn(async () => clientIds),
    countOpenTasksWithoutCustomer: jest.fn(async () => noCustomerCount),
  };
}

describe('normalizeManualContacts (B1.2)', () => {
  it('trim de name/phone', () => {
    expect(normalizeManualContacts([{ name: '  Ana  ', phone: ' 11234 ' }])).toEqual([
      { name: 'Ana', phone: '11234' },
    ]);
  });

  it('descarta items con AMBOS vacíos post-trim (ruido de parseo)', () => {
    expect(normalizeManualContacts([{ name: '   ', phone: '  ' }, { name: 'Ana', phone: '11234' }])).toEqual([
      { name: 'Ana', phone: '11234' },
    ]);
  });

  it('preserva items con SOLO uno de los dos vacío (fila inválida real, no ruido)', () => {
    expect(normalizeManualContacts([{ name: '', phone: '11234' }, { name: 'Ana', phone: '' }])).toEqual([
      { name: '', phone: '11234' },
      { name: 'Ana', phone: '' },
    ]);
  });

  it('preserva el ORDEN del archivo', () => {
    const input = [
      { name: 'C', phone: '3' },
      { name: 'A', phone: '1' },
      { name: 'B', phone: '2' },
    ];
    expect(normalizeManualContacts(input)).toEqual(input);
  });

  it('undefined → []', () => {
    expect(normalizeManualContacts(undefined)).toEqual([]);
  });
});

describe('resolveCombinedRecipients — 4to dominio (manualContacts, CSV-1..CSV-6)', () => {
  it('CSV-5: manualContacts NORMALIZADO > MAX_MANUAL_CONTACTS → TooManyManualContactsError ANTES de tocar la fuente', async () => {
    const source = makeSegmentSource([]);
    const listSpy = jest.spyOn(source, 'listSegmentRecipients');
    const contacts = Array.from({ length: MAX_MANUAL_CONTACTS + 1 }, (_, i) => ({ name: `n${i}`, phone: `n${i}` }));

    await expect(
      resolveCombinedRecipients({ segment: { statuses: [] }, manualClientIds: [], manualContacts: contacts, segmentSource: source }),
    ).rejects.toBeInstanceOf(TooManyManualContactsError);
    expect(listSpy).not.toHaveBeenCalled();
  });

  it('CSV-1: solo contactos CSV (sin match) → 2 resueltos con clientId null, source csv, status no_cliente', async () => {
    const source = makeSegmentSource([]); // ningún Client existente
    const result = await resolveCombinedRecipients({
      segment: { statuses: [] },
      manualClientIds: [],
      manualContacts: [
        { name: 'Ana', phone: '11 2345-6789' },
        { name: 'Beto', phone: '011 15-3456-7890' },
      ],
      segmentSource: source,
    });

    expect(result.resolved).toHaveLength(2);
    expect(result.resolved.every((r) => r.clientId === null)).toBe(true);
    expect(result.resolved.every((r) => r.source === 'csv')).toBe(true);
    expect(result.resolved.map((r) => r.name).sort()).toEqual(['Ana', 'Beto']);
    expect(result.statusCounts).toEqual({ no_cliente: 2 });
  });

  it('CSV-1: segmento + manual + CSV (unión de las 3 fuentes, sin overlap) → 3 resueltos', async () => {
    const source = makeSegmentSource([
      makeCandidate({ clientId: 'c1', phone: '3364111111', status: 'late' }),
    ]);
    const manualSource = makeManualSource([makeCandidate({ clientId: 'c2', phone: '3364222222' })]);

    const result = await resolveCombinedRecipients({
      segment: { statuses: ['late'] },
      manualClientIds: ['c2'],
      manualContacts: [{ name: 'Crudo', phone: '3364333333' }],
      segmentSource: source,
      manualRecipientSource: manualSource,
    });

    expect(result.resolved).toHaveLength(3);
    expect(result.resolved.map((r) => r.source).sort()).toEqual(['csv', 'manual', 'segment']);
  });

  // ── CSV-2: vínculo por teléfono, opt-out, baja, ambigüedad ────────────────────
  it('CSV-2: contacto matchea cliente activo → vinculado (clientId del Client, source csv)', async () => {
    const client = makeCandidate({ clientId: 'k1', phone: '3364111111', status: 'active' });
    const source = makeSegmentSource([client]);

    const result = await resolveCombinedRecipients({
      segment: { statuses: [] },
      manualClientIds: [],
      manualContacts: [{ name: 'Ana', phone: '3364111111' }],
      segmentSource: source,
    });

    expect(result.resolved).toEqual([
      { clientId: 'k1', name: 'Default', phoneNormalized: '3364111111', phoneE164: '+5493364111111', balanceDue: 1000, status: 'active', source: 'csv' },
    ]);
  });

  it('CSV-2: contacto matchea cliente CON opt-out → excluido (reason opt_out), NUNCA materializado', async () => {
    const client = makeCandidate({ clientId: 'k1', phone: '3364111111', whatsappOptOutAt: '2026-01-01T00:00:00.000Z' });
    const source = makeSegmentSource([client]);

    const result = await resolveCombinedRecipients({
      segment: { statuses: [] },
      manualClientIds: [],
      manualContacts: [{ name: 'Ana', phone: '3364111111' }],
      segmentSource: source,
    });

    expect(result.resolved).toHaveLength(0);
    expect(result.csvSkipped.optedOut).toBe(1);
    expect(result.excludedDetail).toEqual([
      { name: 'Default', phone: '3364111111', reason: 'opt_out', source: 'csv', clientId: 'k1', status: 'active' },
    ]);
  });

  it('CSV-2: contacto matchea cliente `baja` (sin opt-out) → ADMITIDO, status baja (flag no-excluyente)', async () => {
    const client = makeCandidate({ clientId: 'k1', phone: '3364111111', status: 'baja' });
    const source = makeSegmentSource([client]);

    const result = await resolveCombinedRecipients({
      segment: { statuses: [] },
      manualClientIds: [],
      manualContacts: [{ name: 'Ana', phone: '3364111111' }],
      segmentSource: source,
    });

    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0]!.status).toBe('baja');
    expect(result.statusCounts).toEqual({ baja: 1 });
  });

  it('CSV-2: ambigüedad activo vs baja → vincula con el ACTIVO', async () => {
    const source = makeSegmentSource([
      makeCandidate({ clientId: 'zz', phone: '3364111111', status: 'baja' }),
      makeCandidate({ clientId: 'aa', phone: '3364111111', status: 'active' }),
    ]);

    const result = await resolveCombinedRecipients({
      segment: { statuses: [] },
      manualClientIds: [],
      manualContacts: [{ name: 'Ana', phone: '3364111111' }],
      segmentSource: source,
    });

    expect(result.resolved[0]!.clientId).toBe('aa');
  });

  it('M1 (review fix wave): contacto crudo SIN match exacto pero que coincide por SUFIJO con un opt-out → excluido opt_out (NO vinculado — sin clientId/status, ownership sigue exact-match)', async () => {
    const optedOutClient = makeCandidate({ clientId: 'k1', phone: '3364123456', whatsappOptOutAt: '2026-01-01T00:00:00.000Z' });
    const source = makeSegmentSource([optedOutClient]);

    const result = await resolveCombinedRecipients({
      segment: { statuses: [] },
      manualClientIds: [],
      manualContacts: [{ name: 'Ana', phone: '03364-15-123456' }],
      segmentSource: source,
    });

    expect(result.resolved).toHaveLength(0);
    expect(result.csvSkipped.optedOut).toBe(1);
    expect(result.csvSkipped.invalidPhone).toBe(0);
    expect(result.excludedDetail).toEqual([
      { name: 'Ana', phone: '03364-15-123456', reason: 'opt_out', source: 'csv' },
    ]);
  });

  // ── CSV-4: dedup cross-source con precedencia ─────────────────────────────────
  it('CSV-4: contacto duplica teléfono del segmento → 1 solo recipient (el del segmento), CSV excluido "duplicado"', async () => {
    const source = makeSegmentSource([makeCandidate({ clientId: 'c1', phone: '3364111111', status: 'late' })]);

    const result = await resolveCombinedRecipients({
      segment: { statuses: ['late'] },
      manualClientIds: [],
      manualContacts: [{ name: 'Duplicado', phone: '3364111111' }],
      segmentSource: source,
    });

    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0]!.source).toBe('segment');
    expect(result.csvSkipped.duplicatePhone).toBe(1);
    expect(result.excludedDetail.find((e) => e.reason === 'duplicado')).toMatchObject({ source: 'csv' });
  });

  it('CSV-4: duplicado INTERNO del CSV (dos filas normalizan igual) → entra la PRIMERA, la 2da excluida "duplicado"', async () => {
    const source = makeSegmentSource([]); // sin match, ambas quedan crudas
    const result = await resolveCombinedRecipients({
      segment: { statuses: [] },
      manualClientIds: [],
      manualContacts: [
        { name: 'Primera', phone: '3364111111' },
        { name: 'Segunda', phone: '+5493364111111' }, // normaliza igual
      ],
      segmentSource: source,
    });

    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0]!.name).toBe('Primera');
    expect(result.csvSkipped.duplicatePhone).toBe(1);
  });

  it('CSV-4: contacto cuyo teléfono vincula a un clientId YA presente en manualClientIds → duplicado', async () => {
    const client = makeCandidate({ clientId: 'k1', phone: '3364111111' });
    const source = makeSegmentSource([client]);
    const manualSource = makeManualSource([client]);

    const result = await resolveCombinedRecipients({
      segment: { statuses: [] },
      manualClientIds: ['k1'],
      manualContacts: [{ name: 'Ana', phone: '3364111111' }],
      segmentSource: source,
      manualRecipientSource: manualSource,
    });

    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0]!.source).toBe('manual');
    expect(result.csvSkipped.duplicatePhone).toBe(1);
  });

  // ── CSV-5: fila inválida no bloquea el resto, queda visible en excludedDetail ──
  it('CSV-5: fila con teléfono basura NO bloquea el resto — entra 1, la basura queda telefono_invalido', async () => {
    const source = makeSegmentSource([]);
    const result = await resolveCombinedRecipients({
      segment: { statuses: [] },
      manualClientIds: [],
      manualContacts: [
        { name: 'Ana', phone: '11 2345-6789' },
        { name: 'Beto', phone: 'no-es-numero' },
      ],
      segmentSource: source,
    });

    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0]!.name).toBe('Ana');
    expect(result.excludedDetail).toEqual([{ name: 'Beto', phone: 'no-es-numero', reason: 'telefono_invalido', source: 'csv' }]);
    expect(result.csvSkipped.invalidPhone).toBe(1);
  });

  // ── CSV-6: preview solo-CSV — invariante count + Σskipped ─────────────────────
  it('CSV-6: 3 contactos (1 válido no-cliente, 1 inválido, 1 vinculado a opt-out) → count 1, invalidPhone 1, optedOut 1, no_cliente 1', async () => {
    const optOutClient = makeCandidate({ clientId: 'k1', phone: '3364999999', whatsappOptOutAt: '2026-01-01T00:00:00.000Z' });
    const source = makeSegmentSource([optOutClient]);

    const result = await resolveCombinedRecipients({
      segment: { statuses: [] },
      manualClientIds: [],
      manualContacts: [
        { name: 'ValidoNoCliente', phone: '3364111111' },
        { name: 'Basura', phone: 'xxx' },
        { name: 'VinculadoOptOut', phone: '3364999999' },
      ],
      segmentSource: source,
    });

    expect(result.resolved).toHaveLength(1);
    expect(result.csvSkipped.invalidPhone).toBe(1);
    expect(result.csvSkipped.optedOut).toBe(1);
    expect(result.statusCounts).toEqual({ no_cliente: 1 });
    const totalSkipped = result.csvSkipped.optedOut + result.csvSkipped.duplicatePhone + result.csvSkipped.invalidPhone;
    expect(result.resolved.length + totalSkipped).toBe(3); // invariante: count + Σskipped = considerados
  });

  // ── L4 (review fix wave): orden determinístico de excludedDetail (pagina estable) ──
  it('L4: excludedDetail sale ORDENADO determinísticamente por clientId (molde sortResolved), NO por orden de inserción — pagina estable aunque la fuente no garantice orden (sin ORDER BY, PrismaCustomerRepository.ts:429-438)', async () => {
    const clientZ = makeCandidate({ clientId: 'z9', phone: '3364222222', whatsappOptOutAt: '2026-01-01T00:00:00.000Z', name: 'ContactoZ' });
    const clientA = makeCandidate({ clientId: 'a1', phone: '3364111111', whatsappOptOutAt: '2026-01-01T00:00:00.000Z', name: 'ContactoA' });
    const source = makeSegmentSource([clientZ, clientA]);

    const result = await resolveCombinedRecipients({
      segment: { statuses: [] },
      manualClientIds: [],
      manualContacts: [
        { name: 'ContactoZ', phone: '3364222222' }, // matchea z9 PRIMERO (orden de inserción del CSV)
        { name: 'ContactoA', phone: '3364111111' }, // matchea a1 DESPUÉS
      ],
      segmentSource: source,
    });

    // Sin el sort, saldría ['z9', 'a1'] (orden de inserción). Con el sort, ['a1', 'z9'].
    expect(result.excludedDetail.map((e) => e.clientId)).toEqual(['a1', 'z9']);
  });

  it('sin manualContacts (array vacío) → NO llama listSegmentRecipients con statuses:[] extra (no-regresión de queries)', async () => {
    const source = makeSegmentSource([makeCandidate({ clientId: 'c1', phone: '3364111111', status: 'late' })]);
    const listSpy = jest.spyOn(source, 'listSegmentRecipients');

    await resolveCombinedRecipients({
      segment: { statuses: ['late'] },
      manualClientIds: [],
      manualContacts: [],
      segmentSource: source,
    });

    // UNA sola llamada — la del segmento (statuses:['late']); manualContacts vacío no dispara la 2da (universo).
    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(listSpy).toHaveBeenCalledWith({ statuses: ['late'], balanceMin: undefined, balanceMax: undefined });
  });
});

/**
 * bulk-task-recipients (B5.2, TASK-1..TASK-9, D3/D4) — branch `task`, 5to
 * dominio de destinatarios. APPEND al final de la unión (segmento > manual >
 * csv > task) — corre DESPUÉS de los 3 loops de unión existentes (necesita
 * `byClientId`/`seenPhones` YA poblados para el overlap/dedup cross-source).
 */
describe('resolveCombinedRecipients — 5to dominio (taskStageIds, TASK-1..TASK-9)', () => {
  it('TASK-1 (no-regresión): omitir taskStageIds/taskRecipientSource → comportamiento BYTE-IDÉNTICO a antes (sin llamar ningún task source)', async () => {
    const source = makeSegmentSource([makeCandidate({ clientId: 'c1', phone: '3364111111', status: 'late' })]);

    const result = await resolveCombinedRecipients({
      segment: { statuses: ['late'] },
      manualClientIds: [],
      manualContacts: [],
      segmentSource: source,
    });

    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0]!.source).toBe('segment');
    expect(result.taskSkipped).toEqual({ optedOut: 0, duplicatePhone: 0, invalidPhone: 0 });
    expect(result.noCustomerCount).toBe(0);
  });

  it('TASK-3 escenario 1: el port devuelve el clientId YA distinct → aparece UNA vez en resolved con source:"task"', async () => {
    const segmentSource = makeSegmentSource([]);
    const manualSource = makeManualSource([makeCandidate({ clientId: 'c1', phone: '3364111111', status: 'active' })]);
    const taskSource = makeTaskSource(['c1']);

    const result = await resolveCombinedRecipients({
      segment: { statuses: [] },
      manualClientIds: [],
      manualContacts: [],
      taskStageIds: ['stageA', 'stageB'],
      segmentSource,
      manualRecipientSource: manualSource,
      taskRecipientSource: taskSource,
    });

    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0]).toMatchObject({ clientId: 'c1', source: 'task' });
    expect(taskSource.listClientIdsByOpenTaskStages).toHaveBeenCalledWith(['stageA', 'stageB']);
  });

  it('TASK-3 escenario 2: stage mapeado sin tareas abiertas (port devuelve []) → 0 por ese origen, sin error', async () => {
    const segmentSource = makeSegmentSource([]);
    const taskSource = makeTaskSource([]);

    const result = await resolveCombinedRecipients({
      segment: { statuses: [] },
      manualClientIds: [],
      manualContacts: [],
      taskStageIds: ['stageC'],
      segmentSource,
      taskRecipientSource: taskSource,
    });

    expect(result.resolved).toHaveLength(0);
  });

  it('TASK-3 escenario 3: tareas de red sin cliente (excluidas por el port) → noCustomerCount refleja el conteo exacto, sin generar recipient', async () => {
    const segmentSource = makeSegmentSource([]);
    const taskSource = makeTaskSource([], 3);

    const result = await resolveCombinedRecipients({
      segment: { statuses: [] },
      manualClientIds: [],
      manualContacts: [],
      taskStageIds: ['stageA'],
      segmentSource,
      taskRecipientSource: taskSource,
    });

    expect(result.resolved).toHaveLength(0);
    expect(result.noCustomerCount).toBe(3);
    expect(taskSource.countOpenTasksWithoutCustomer).toHaveBeenCalledWith(['stageA']);
  });

  it('TASK-3 escenario 4: tarea cerrada (filtrada por el port) → el cliente NO entra por el dominio tarea', async () => {
    const segmentSource = makeSegmentSource([]);
    const taskSource = makeTaskSource([]); // la única tarea del cliente está cerrada → el port ya no la incluye

    const result = await resolveCombinedRecipients({
      segment: { statuses: [] },
      manualClientIds: [],
      manualContacts: [],
      taskStageIds: ['stageA'],
      segmentSource,
      taskRecipientSource: taskSource,
    });

    expect(result.resolved).toHaveLength(0);
  });

  it('TASK-4: distinct > MAX_TASK_STATE_RECIPIENTS → TooManyTaskStateRecipientsError ANTES de hidratar (nunca llama manualRecipientSource)', async () => {
    const segmentSource = makeSegmentSource([]);
    const manualSource = makeManualSource([]);
    const hydrateSpy = jest.spyOn(manualSource, 'findRecipientCandidatesByIds');
    const ids = Array.from({ length: MAX_TASK_STATE_RECIPIENTS + 1 }, (_, i) => `c${i}`);
    const taskSource = makeTaskSource(ids);

    await expect(
      resolveCombinedRecipients({
        segment: { statuses: [] },
        manualClientIds: [],
        manualContacts: [],
        taskStageIds: ['stageA'],
        segmentSource,
        manualRecipientSource: manualSource,
        taskRecipientSource: taskSource,
      }),
    ).rejects.toBeInstanceOf(TooManyTaskStateRecipientsError);
    expect(hydrateSpy).not.toHaveBeenCalled();
  });

  it('TASK-5 escenario 1: cliente resuelto por tarea sin teléfono válido → excluido, taskExcludedDetail con telefono_invalido', async () => {
    const segmentSource = makeSegmentSource([]);
    const manualSource = makeManualSource([makeCandidate({ clientId: 'c1', phone: 'no-es-numero' })]);
    const taskSource = makeTaskSource(['c1']);

    const result = await resolveCombinedRecipients({
      segment: { statuses: [] },
      manualClientIds: [],
      manualContacts: [],
      taskStageIds: ['stageA'],
      segmentSource,
      manualRecipientSource: manualSource,
      taskRecipientSource: taskSource,
    });

    expect(result.resolved).toHaveLength(0);
    expect(result.taskSkipped.invalidPhone).toBe(1);
    expect(result.excludedDetail).toEqual([
      expect.objectContaining({ clientId: 'c1', reason: 'telefono_invalido', source: 'task' }),
    ]);
  });

  it('TASK-5 escenario 2: cliente opt-out resuelto por tarea → excluido con opt_out', async () => {
    const segmentSource = makeSegmentSource([]);
    const manualSource = makeManualSource([
      makeCandidate({ clientId: 'c1', phone: '3364111111', whatsappOptOutAt: '2026-01-01T00:00:00.000Z' }),
    ]);
    const taskSource = makeTaskSource(['c1']);

    const result = await resolveCombinedRecipients({
      segment: { statuses: [] },
      manualClientIds: [],
      manualContacts: [],
      taskStageIds: ['stageA'],
      segmentSource,
      manualRecipientSource: manualSource,
      taskRecipientSource: taskSource,
    });

    expect(result.resolved).toHaveLength(0);
    expect(result.taskSkipped.optedOut).toBe(1);
    expect(result.excludedDetail).toEqual([
      expect.objectContaining({ clientId: 'c1', reason: 'opt_out', source: 'task' }),
    ]);
  });

  it('TASK-6 escenario 1: cliente en segmento Y con tarea en stage tildado → UNA vez con source:"segment" (task NO lo posee)', async () => {
    const segmentSource = makeSegmentSource([makeCandidate({ clientId: 'c1', phone: '3364111111', status: 'late' })]);
    const manualSource = makeManualSource([makeCandidate({ clientId: 'c1', phone: '3364111111', status: 'late' })]);
    const taskSource = makeTaskSource(['c1']);

    const result = await resolveCombinedRecipients({
      segment: { statuses: ['late'] },
      manualClientIds: [],
      manualContacts: [],
      taskStageIds: ['stageA'],
      segmentSource,
      manualRecipientSource: manualSource,
      taskRecipientSource: taskSource,
    });

    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0]).toMatchObject({ clientId: 'c1', source: 'segment' });
  });

  it('TASK-6 escenario 2: cliente ÚNICAMENTE por tarea → source:"task"', async () => {
    const segmentSource = makeSegmentSource([]);
    const manualSource = makeManualSource([makeCandidate({ clientId: 'c9', phone: '3364999999', status: 'active' })]);
    const taskSource = makeTaskSource(['c9']);

    const result = await resolveCombinedRecipients({
      segment: { statuses: [] },
      manualClientIds: [],
      manualContacts: [],
      taskStageIds: ['stageA'],
      segmentSource,
      manualRecipientSource: manualSource,
      taskRecipientSource: taskSource,
    });

    expect(result.resolved).toEqual([
      expect.objectContaining({ clientId: 'c9', source: 'task' }),
    ]);
  });

  it('cross-source: teléfono de un resuelto-por-tarea YA visto por otra fuente → duplicado (taskSkipped.duplicatePhone), NO se materializa 2 veces', async () => {
    const segmentSource = makeSegmentSource([makeCandidate({ clientId: 'c1', phone: '3364111111', status: 'late' })]);
    // c2 es un clientId DISTINTO pero con el MISMO teléfono normalizado que c1 (dedup cross-source por teléfono, molde CSV-4).
    const manualSource = makeManualSource([makeCandidate({ clientId: 'c2', phone: '3364111111', status: 'active' })]);
    const taskSource = makeTaskSource(['c2']);

    const result = await resolveCombinedRecipients({
      segment: { statuses: ['late'] },
      manualClientIds: [],
      manualContacts: [],
      taskStageIds: ['stageA'],
      segmentSource,
      manualRecipientSource: manualSource,
      taskRecipientSource: taskSource,
    });

    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0]).toMatchObject({ clientId: 'c1', source: 'segment' });
    expect(result.taskSkipped.duplicatePhone).toBe(1);
  });

  it('TASK-7: preview con 2 válidos + 1 opt-out (tarea) + tareas de red sin cliente → count 2, taskSkipped.optedOut:1, noCustomerCount:3', async () => {
    const segmentSource = makeSegmentSource([]);
    const manualSource = makeManualSource([
      makeCandidate({ clientId: 'c1', phone: '3364111111', status: 'active' }),
      makeCandidate({ clientId: 'c2', phone: '3364222222', status: 'late' }),
      makeCandidate({ clientId: 'c3', phone: '3364333333', whatsappOptOutAt: '2026-01-01T00:00:00.000Z' }),
    ]);
    const taskSource = makeTaskSource(['c1', 'c2', 'c3'], 3);

    const result = await resolveCombinedRecipients({
      segment: { statuses: [] },
      manualClientIds: [],
      manualContacts: [],
      taskStageIds: ['stageA', 'stageB'],
      segmentSource,
      manualRecipientSource: manualSource,
      taskRecipientSource: taskSource,
    });

    expect(result.resolved).toHaveLength(2);
    expect(result.resolved.every((r) => r.source === 'task')).toBe(true);
    expect(result.taskSkipped.optedOut).toBe(1);
    expect(result.noCustomerCount).toBe(3);
  });
});

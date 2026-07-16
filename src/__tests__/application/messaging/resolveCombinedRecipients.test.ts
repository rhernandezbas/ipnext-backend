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
} from '@application/use-cases/messaging/resolveCombinedRecipients';
import { TooManyManualContactsError } from '@domain/errors/messaging-bulk';
import type { CampaignSegmentSource, CampaignRecipientCandidate, CampaignSegmentFilter, ManualRecipientSource } from '@domain/ports/CustomerRepository';

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

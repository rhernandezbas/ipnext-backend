/**
 * messaging-bulk (F2, T3.6) — PreviewCampaignSegment a.k.a. CountRecipients.
 * Un caso por escenario SEG-1..SEG-5. Usa `resolveRecipients` (T3.5) +
 * `FakeCustomerRepository.listSegmentRecipients` (stub inline, T3.3 — la
 * implementación Prisma real recién llega en Batch 6, acá el fake alcanza).
 * RBAC gate `messaging.bulk` se testea en la ruta (Batch 7), no acá.
 */
import { PreviewCampaignSegment } from '@application/use-cases/messaging/PreviewCampaignSegment';
import { MAX_MANUAL_RECIPIENTS } from '@application/use-cases/messaging/resolveCombinedRecipients';
import { UnfilteredSegmentError, ManualRecipientsNotFoundError, TooManyManualRecipientsError, TaskStageNotEligibleError } from '@domain/errors/messaging-bulk';
import type { CampaignSegmentSource, CampaignRecipientCandidate, CampaignSegmentFilter, ManualRecipientSource } from '@domain/ports/CustomerRepository';
import type { TaskRecipientSource } from '@domain/ports/TaskRecipientSource';
import type { TaskStageRecipientConfigRepository } from '@domain/ports/TaskStageRecipientConfigRepository';

interface FakeClientRow extends CampaignRecipientCandidate {
  status: string;
}

/** manual-recipients (MAN-5) — fake del port narrow para la lista manual del preview. */
function makeManualSource(rows: FakeClientRow[]): ManualRecipientSource {
  return {
    findRecipientCandidatesByIds: async (ids: string[]) => {
      const wanted = new Set(ids);
      return rows.filter((r) => wanted.has(r.clientId));
    },
  };
}

/**
 * Fake mínimo (T3.3): simula lo que la query Prisma real (Batch 6, T6.3) va a
 * resolver — filtra por `statuses` (vacío = sin filtro) + rango de
 * `balanceDue`. Deliberadamente NO filtra `whatsappOptOutAt` acá (eso lo hace
 * la query real a nivel DB, design §4.2) — el enforcement bajo test en este
 * use case es el defensivo en memoria (SEG-2, vía `resolveRecipients`).
 *
 * v1.1 (statusCounts) — el `status` de cada fila YA NO se descarta antes de
 * devolver: la query Prisma real (`toCampaignRecipientCandidate`) lo incluye
 * SIEMPRE en `listSegmentRecipients`, y `resolveRecipients` lo necesita para
 * `statusCounts` + el `status` del sample.
 */
function makeSegmentSource(rows: FakeClientRow[]): CampaignSegmentSource {
  return {
    listSegmentRecipients: async (segment: CampaignSegmentFilter): Promise<CampaignRecipientCandidate[]> => {
      return rows
        .filter((r) => segment.statuses.length === 0 || segment.statuses.includes(r.status))
        .filter((r) => segment.balanceMin == null || (r.balanceDue ?? 0) >= segment.balanceMin)
        .filter((r) => segment.balanceMax == null || (r.balanceDue ?? 0) <= segment.balanceMax);
    },
  };
}

/** bulk-task-recipients (B5.3) — fake narrow del 5to dominio "Tarea" (resolución). */
function makeTaskSource(clientIds: string[], noCustomerCount = 0): TaskRecipientSource {
  return {
    listClientIdsByOpenTaskStages: async () => clientIds,
    listOpenTasksByStages: async () => clientIds.map((c: string, i: number) => ({ taskId: `t-${i}-${c}`, clientId: c, fromStageId: 'stageA' })),
    countOpenTasksWithoutCustomer: async () => noCustomerCount,
  };
}

/** bulk-task-recipients (B5.3) — fake narrow de la config de elegibilidad. */
function makeTaskStageConfigRepo(mapped: string[]): TaskStageRecipientConfigRepository {
  return {
    listMappedStageIds: async () => mapped,
    getMappedStages: async () => [],
    replaceMappedStages: async () => undefined,
  };
}

function makeRow(overrides: Partial<FakeClientRow> = {}): FakeClientRow {
  return {
    clientId: 'c-default',
    name: 'Default',
    phone: '3364000000',
    balanceDue: 0,
    whatsappOptOutAt: null,
    status: 'active',
    ...overrides,
  };
}

describe('PreviewCampaignSegment', () => {
  it('SEG-1 (un solo status): solo los clientes late entran en el conteo/preview', async () => {
    const source = makeSegmentSource([
      makeRow({ clientId: 'c1', phone: '3364111111', status: 'active' }),
      makeRow({ clientId: 'c2', phone: '3364222222', status: 'late' }),
      makeRow({ clientId: 'c3', phone: '3364333333', status: 'blocked' }),
    ]);
    const uc = new PreviewCampaignSegment(source);

    const result = await uc.execute({ statuses: ['late'] });

    expect(result.count).toBe(1);
    expect(result.sample.map((s) => s.clientId)).toEqual(['c2']);
  });

  it('SEG-1 (multi-status, unión): entran late Y blocked, pero NO baja', async () => {
    const source = makeSegmentSource([
      makeRow({ clientId: 'c1', phone: '3364111111', status: 'late' }),
      makeRow({ clientId: 'c2', phone: '3364222222', status: 'blocked' }),
      makeRow({ clientId: 'c3', phone: '3364333333', status: 'baja' }),
    ]);
    const uc = new PreviewCampaignSegment(source);

    const result = await uc.execute({ statuses: ['late', 'blocked'] });

    expect(result.count).toBe(2);
    expect(result.sample.map((s) => s.clientId).sort()).toEqual(['c1', 'c2']);
  });

  it('SEG-1 (rango de balanceDue combinado con status): AND entre status y rango, no OR', async () => {
    const source = makeSegmentSource([
      makeRow({ clientId: 'c1', phone: '3364111111', status: 'late', balanceDue: 5000 }),
      makeRow({ clientId: 'c2', phone: '3364222222', status: 'late', balanceDue: 50000 }),
    ]);
    const uc = new PreviewCampaignSegment(source);

    const result = await uc.execute({ statuses: ['late'], balanceMin: 10000 });

    expect(result.count).toBe(1);
    expect(result.sample[0].clientId).toBe('c2');
  });

  it('SEG-1 (rango sin status): statuses vacío = sin filtro de status, solo importa el balanceDue', async () => {
    const source = makeSegmentSource([
      makeRow({ clientId: 'c1', phone: '3364111111', status: 'active', balanceDue: 5000 }),
      makeRow({ clientId: 'c2', phone: '3364222222', status: 'blocked', balanceDue: 50000 }),
      makeRow({ clientId: 'c3', phone: '3364333333', status: 'late', balanceDue: 200000 }),
    ]);
    const uc = new PreviewCampaignSegment(source);

    const result = await uc.execute({ statuses: [], balanceMin: 1000, balanceMax: 100000 });

    expect(result.count).toBe(2);
    expect(result.sample.map((s) => s.clientId).sort()).toEqual(['c1', 'c2']);
  });

  it('SEG-1 (filtro sin matches): responde count:0, sample:[] sin error', async () => {
    const source = makeSegmentSource([makeRow({ clientId: 'c1', status: 'active' })]);
    const uc = new PreviewCampaignSegment(source);

    const result = await uc.execute({ statuses: ['late'] });

    expect(result.count).toBe(0);
    expect(result.sample).toEqual([]);
  });

  it('SEG-2: cliente opt-out dentro del segmento se excluye del count/sample y se contabiliza en skipped.optedOut', async () => {
    const source = makeSegmentSource([
      makeRow({ clientId: 'c1', phone: '3364111111', status: 'late', whatsappOptOutAt: '2026-01-01T00:00:00.000Z' }),
      makeRow({ clientId: 'c2', phone: '3364222222', status: 'late', whatsappOptOutAt: null }),
    ]);
    const uc = new PreviewCampaignSegment(source);

    const result = await uc.execute({ statuses: ['late'] });

    expect(result.count).toBe(1);
    expect(result.sample.map((s) => s.clientId)).toEqual(['c2']);
    expect(result.skipped.optedOut).toBe(1);
  });

  it('SEG-3: dos clientes con el mismo teléfono normalizado cuentan como 1, el 2do en skipped.duplicatePhone', async () => {
    const source = makeSegmentSource([
      makeRow({ clientId: 'c2', phone: '+5493364123456', status: 'late' }),
      makeRow({ clientId: 'c1', phone: '3364123456', status: 'late' }),
    ]);
    const uc = new PreviewCampaignSegment(source);

    const result = await uc.execute({ statuses: ['late'] });

    expect(result.count).toBe(1);
    expect(result.sample.map((s) => s.clientId)).toEqual(['c1']); // determinístico: gana el id menor
    expect(result.skipped.duplicatePhone).toBe(1);
  });

  it('SEG-4: teléfono con menos de 6 dígitos significativos se excluye y contabiliza en skipped.invalidPhone', async () => {
    const source = makeSegmentSource([
      makeRow({ clientId: 'c1', phone: '123', status: 'late' }),
      makeRow({ clientId: 'c2', phone: '3364222222', status: 'late' }),
    ]);
    const uc = new PreviewCampaignSegment(source);

    const result = await uc.execute({ statuses: ['late'] });

    expect(result.count).toBe(1);
    expect(result.skipped.invalidPhone).toBe(1);
  });

  // ── FIX-8: segmento SIN criterio no debe apuntar a toda la base ──────────────
  it('FIX-8: statuses vacío sin balance → UnfilteredSegmentError (no resuelve toda la base)', async () => {
    const source = makeSegmentSource([makeRow({ clientId: 'c1', status: 'active' })]);
    const listSpy = jest.spyOn(source, 'listSegmentRecipients');
    const uc = new PreviewCampaignSegment(source);

    await expect(uc.execute({ statuses: [] })).rejects.toBeInstanceOf(UnfilteredSegmentError);
    expect(listSpy).not.toHaveBeenCalled(); // rechaza ANTES de tocar la fuente
  });

  it('FIX-8: statuses vacío + balanceMin:0 → UnfilteredSegmentError (piso 0 = todos con FIX-12)', async () => {
    const source = makeSegmentSource([makeRow({ clientId: 'c1', status: 'active' })]);
    const uc = new PreviewCampaignSegment(source);

    await expect(uc.execute({ statuses: [], balanceMin: 0 })).rejects.toBeInstanceOf(UnfilteredSegmentError);
  });

  it('FIX-8: statuses no vacío → OK (criterio presente)', async () => {
    const source = makeSegmentSource([makeRow({ clientId: 'c1', status: 'late' })]);
    const uc = new PreviewCampaignSegment(source);

    const result = await uc.execute({ statuses: ['late'] });
    expect(result.count).toBe(1);
  });

  it('FIX-8: statuses vacío + balanceMin>0 → OK (piso de deuda real es criterio)', async () => {
    const source = makeSegmentSource([makeRow({ clientId: 'c1', status: 'active', balanceDue: 5000 })]);
    const uc = new PreviewCampaignSegment(source);

    const result = await uc.execute({ statuses: [], balanceMin: 1000 });
    expect(result.count).toBe(1);
  });

  // ── FIX-8-edge: `balanceMax<=0` NO es un techo real ─────────────────────────
  // Con FIX-12, `balanceMax:0` sin piso ni statuses resuelve a `balanceDue<=0 OR
  // null` ≈ toda la base de null-balance. Un techo solo cuenta como criterio si
  // es > 0.
  it('FIX-8-edge: statuses vacío + balanceMax:0 → UnfilteredSegmentError (techo 0 no filtra efectivo)', async () => {
    const source = makeSegmentSource([makeRow({ clientId: 'c1', status: 'active' })]);
    const listSpy = jest.spyOn(source, 'listSegmentRecipients');
    const uc = new PreviewCampaignSegment(source);

    await expect(uc.execute({ statuses: [], balanceMax: 0 })).rejects.toBeInstanceOf(UnfilteredSegmentError);
    expect(listSpy).not.toHaveBeenCalled(); // rechaza ANTES de tocar la fuente
  });

  it('FIX-8-edge: statuses vacío + balanceMax negativo → UnfilteredSegmentError', async () => {
    const source = makeSegmentSource([makeRow({ clientId: 'c1', status: 'active' })]);
    const uc = new PreviewCampaignSegment(source);

    await expect(uc.execute({ statuses: [], balanceMax: -100 })).rejects.toBeInstanceOf(UnfilteredSegmentError);
  });

  it('FIX-8-edge: statuses vacío + balanceMax>0 → OK (techo de deuda real es criterio)', async () => {
    const source = makeSegmentSource([makeRow({ clientId: 'c1', status: 'active', balanceDue: 0 })]);
    const uc = new PreviewCampaignSegment(source);

    const result = await uc.execute({ statuses: [], balanceMax: 5000 });
    expect(result.count).toBe(1);
  });

  it('FIX-8-edge: statuses no vacío + balanceMax:0 → OK (el status ya es criterio)', async () => {
    const source = makeSegmentSource([makeRow({ clientId: 'c1', status: 'late', balanceDue: 0 })]);
    const uc = new PreviewCampaignSegment(source);

    const result = await uc.execute({ statuses: ['late'], balanceMax: 0 });
    expect(result.count).toBe(1);
  });

  // ── messaging-bulk v1.1 (preview modal) — statusCounts + status por-destinatario ──
  it('v1.1: 2 estados distintos → statusCounts cuenta los RECEPTORES por status + cada item del sample trae su status', async () => {
    const source = makeSegmentSource([
      makeRow({ clientId: 'c1', phone: '3364111111', status: 'late' }),
      makeRow({ clientId: 'c2', phone: '3364222222', status: 'late' }),
      makeRow({ clientId: 'c3', phone: '3364333333', status: 'blocked' }),
    ]);
    const uc = new PreviewCampaignSegment(source);

    const result = await uc.execute({ statuses: ['late', 'blocked'] });

    expect(result.count).toBe(3);
    expect(result.statusCounts).toEqual({ late: 2, blocked: 1 });
    const c1 = result.sample.find((s) => s.clientId === 'c1');
    const c3 = result.sample.find((s) => s.clientId === 'c3');
    expect(c1?.status).toBe('late');
    expect(c3?.status).toBe('blocked');
  });

  it('v1.1: statusCounts NO cuenta a los excluidos por opt-out (solo receptores reales)', async () => {
    const source = makeSegmentSource([
      makeRow({ clientId: 'c1', phone: '3364111111', status: 'late', whatsappOptOutAt: '2026-01-01T00:00:00.000Z' }),
      makeRow({ clientId: 'c2', phone: '3364222222', status: 'late' }),
    ]);
    const uc = new PreviewCampaignSegment(source);

    const result = await uc.execute({ statuses: ['late'] });

    expect(result.statusCounts).toEqual({ late: 1 });
  });

  // ── manual-recipients (MAN-5): el preview cuenta la unión sin doble-contar ────
  it('MAN-5: overlap segmento∩manual → count = unión (3), NO doble-cuenta el que ya cae en el segmento', async () => {
    const source = makeSegmentSource([
      makeRow({ clientId: 'c1', phone: '3364111111', status: 'late' }),
      makeRow({ clientId: 'c2', phone: '3364222222', status: 'late' }),
    ]);
    const manualSource = makeManualSource([
      makeRow({ clientId: 'c2', phone: '3364222222', status: 'late' }), // ya está en el segmento
      makeRow({ clientId: 'c3', phone: '3364333333', status: 'blocked' }), // nuevo
    ]);
    const uc = new PreviewCampaignSegment(source, manualSource);

    const result = await uc.execute({ statuses: ['late'], manualClientIds: ['c2', 'c3'] });

    expect(result.count).toBe(3);
    expect(result.sample.map((s) => s.clientId).sort()).toEqual(['c1', 'c2', 'c3']);
  });

  it('MAN-5: solo lista manual (segmento sin criterio) → count = manuales, sin UnfilteredSegmentError', async () => {
    const source = makeSegmentSource([]);
    const listSpy = jest.spyOn(source, 'listSegmentRecipients');
    const manualSource = makeManualSource([
      makeRow({ clientId: 'c1', phone: '3364111111', status: 'active' }),
    ]);
    const uc = new PreviewCampaignSegment(source, manualSource);

    const result = await uc.execute({ statuses: [], manualClientIds: ['c1'] });

    expect(result.count).toBe(1);
    expect(listSpy).not.toHaveBeenCalled(); // segmento sin criterio → no toca la fuente
  });

  it('MAN-5/MAN-3: manualClientId inexistente en el preview → ManualRecipientsNotFoundError', async () => {
    const source = makeSegmentSource([makeRow({ clientId: 'c1', status: 'late' })]);
    const manualSource = makeManualSource([]); // no existe ningún id manual
    const uc = new PreviewCampaignSegment(source, manualSource);

    await expect(
      uc.execute({ statuses: ['late'], manualClientIds: ['no-existe'] }),
    ).rejects.toBeInstanceOf(ManualRecipientsNotFoundError);
  });

  // ── FIX-2: el preview RECONCILIA las exclusiones de los MANUALES ─────────────
  // `skipped` ahora suma segmentSkipped + manualSkipped SIN doble-contar el
  // overlap (un cliente en ambos sets no cuenta dos veces). Invariante:
  // count (enviables) + total_excluidos = destinatarios únicos considerados.
  describe('FIX-2: reconciliación del skipped con la lista manual', () => {
    it('FIX-2 (a): solo-manual con un opt-out → count=2, skipped.optedOut cuenta el manual (reconcilia 3 = 2 + 1)', async () => {
      const source = makeSegmentSource([]);
      const manualSource = makeManualSource([
        makeRow({ clientId: 'c1', phone: '3364111111', status: 'active' }),
        makeRow({ clientId: 'c2', phone: '3364222222', status: 'active', whatsappOptOutAt: '2026-01-01T00:00:00.000Z' }),
        makeRow({ clientId: 'c3', phone: '3364333333', status: 'active' }),
      ]);
      const uc = new PreviewCampaignSegment(source, manualSource);

      const result = await uc.execute({ statuses: [], manualClientIds: ['c1', 'c2', 'c3'] });

      expect(result.count).toBe(2);
      expect(result.skipped.optedOut).toBe(1);
      const totalSkipped = result.skipped.optedOut + result.skipped.duplicatePhone + result.skipped.invalidPhone;
      expect(result.count + totalSkipped).toBe(3); // reconciliación: 3 considerados = 2 + 1
    });

    it('FIX-2 (b): manual con teléfono inválido → skipped.invalidPhone lo cuenta (reconcilia)', async () => {
      const source = makeSegmentSource([]);
      const manualSource = makeManualSource([
        makeRow({ clientId: 'c1', phone: '3364111111', status: 'active' }),
        makeRow({ clientId: 'c2', phone: '123', status: 'active' }), // basura (< 6 díg significativos)
      ]);
      const uc = new PreviewCampaignSegment(source, manualSource);

      const result = await uc.execute({ statuses: [], manualClientIds: ['c1', 'c2'] });

      expect(result.count).toBe(1);
      expect(result.skipped.invalidPhone).toBe(1);
      expect(result.count + result.skipped.invalidPhone).toBe(2);
    });

    it('FIX-2 (c)/FIX-1: manual cuyo teléfono colisiona con el segmento → skipped.duplicatePhone (cross-set)', async () => {
      const source = makeSegmentSource([
        makeRow({ clientId: 'A', phone: '3364111111', status: 'late' }),
      ]);
      const manualSource = makeManualSource([
        makeRow({ clientId: 'B', phone: '3364111111', status: 'active' }), // mismo teléfono que A, distinto clientId
      ]);
      const uc = new PreviewCampaignSegment(source, manualSource);

      const result = await uc.execute({ statuses: ['late'], manualClientIds: ['B'] });

      expect(result.count).toBe(1); // solo A
      expect(result.sample.map((s) => s.clientId)).toEqual(['A']);
      expect(result.skipped.duplicatePhone).toBe(1); // B colapsado por teléfono
      expect(result.count + result.skipped.duplicatePhone).toBe(2); // considerados: A + B
    });

    it('FIX-2 (d) no-regresión: preview segment-only reporta EXACTAMENTE el mismo skipped que antes', async () => {
      const source = makeSegmentSource([
        makeRow({ clientId: 'c1', phone: '3364111111', status: 'late', whatsappOptOutAt: '2026-01-01T00:00:00.000Z' }),
        makeRow({ clientId: 'c2', phone: '3364222222', status: 'late' }),
        makeRow({ clientId: 'c3', phone: '123', status: 'late' }), // teléfono inválido
      ]);
      const uc = new PreviewCampaignSegment(source); // sin manual source, sin manualClientIds

      const result = await uc.execute({ statuses: ['late'] });

      expect(result.count).toBe(1);
      expect(result.skipped).toEqual({ optedOut: 1, duplicatePhone: 0, invalidPhone: 1 });
    });

    // ── Pin del invariante de NO doble-conteo (overlap por clientId con un EXCLUIDO
    // del segmento). Éste es el ÚNICO escenario donde `segmentCandidateIds` (set
    // COMPLETO de candidatos, incl. excluidos) difiere de `segmentResolved`: un
    // cliente que es candidato del segmento PERO excluido (opt-out/teléfono-inválido)
    // y que además viaja en manualClientIds. Debe contarse UNA sola vez (vía el
    // segmento). Si alguien simplificara `segmentCandidateIds`→`segmentResolved`,
    // estos tests darían `2` y fallarían — esa es la red que protegen. ──────────────
    it('FIX-2 pin (opt-out en ambos sets): candidato del segmento EXCLUIDO por opt-out + en manualClientIds → optedOut cuenta 1, NO 2', async () => {
      // X es candidato del segmento (status late) pero opt-out → está en S, NO en segmentResolved.
      const source = makeSegmentSource([
        makeRow({ clientId: 'X', phone: '3364111111', status: 'late', whatsappOptOutAt: '2026-01-01T00:00:00.000Z' }),
        makeRow({ clientId: 'c1', phone: '3364222222', status: 'late' }),
      ]);
      // X también en la lista manual; c2 es un manual nuevo válido.
      const manualSource = makeManualSource([
        makeRow({ clientId: 'X', phone: '3364111111', status: 'late', whatsappOptOutAt: '2026-01-01T00:00:00.000Z' }),
        makeRow({ clientId: 'c2', phone: '3364333333', status: 'active' }),
      ]);
      const uc = new PreviewCampaignSegment(source, manualSource);

      const result = await uc.execute({ statuses: ['late'], manualClientIds: ['X', 'c2'] });

      expect(result.skipped.optedOut).toBe(1); // X contado UNA vez (vía el segmento), no 2
      expect(result.count).toBe(2); // c1 (segmento) + c2 (manual)
      // reconciliación: considerados únicos = |S|(X,c1)=2 + |M\S|(c2)=1 = 3 = count(2) + optedOut(1)
      const totalSkipped = result.skipped.optedOut + result.skipped.duplicatePhone + result.skipped.invalidPhone;
      expect(result.count + totalSkipped).toBe(3);
    });

    it('FIX-2 pin (invalid-phone en ambos sets): candidato del segmento EXCLUIDO por teléfono inválido + en manualClientIds → invalidPhone cuenta 1, NO 2', async () => {
      const source = makeSegmentSource([
        makeRow({ clientId: 'Y', phone: '123', status: 'late' }), // teléfono inválido → excluido del segmento
        makeRow({ clientId: 'c1', phone: '3364222222', status: 'late' }),
      ]);
      const manualSource = makeManualSource([
        makeRow({ clientId: 'Y', phone: '123', status: 'late' }),
        makeRow({ clientId: 'c2', phone: '3364333333', status: 'active' }),
      ]);
      const uc = new PreviewCampaignSegment(source, manualSource);

      const result = await uc.execute({ statuses: ['late'], manualClientIds: ['Y', 'c2'] });

      expect(result.skipped.invalidPhone).toBe(1); // Y contado UNA vez, no 2
      expect(result.count).toBe(2); // c1 (segmento) + c2 (manual)
      const totalSkipped = result.skipped.optedOut + result.skipped.duplicatePhone + result.skipped.invalidPhone;
      expect(result.count + totalSkipped).toBe(3);
    });
  });

  // ── FIX-3: cota superior de manualClientIds (protege el límite de bind params) ─
  describe('FIX-3: cota superior de manualClientIds', () => {
    it('FIX-3 (a): MAX+1 ids → TooManyManualRecipientsError (rechazo limpio, no 500)', async () => {
      const source = makeSegmentSource([]);
      const manualSource = makeManualSource([]); // no llega a resolver: rechaza por la cota antes
      const uc = new PreviewCampaignSegment(source, manualSource);

      const ids = Array.from({ length: MAX_MANUAL_RECIPIENTS + 1 }, (_, i) => `c${i}`);

      await expect(uc.execute({ statuses: [], manualClientIds: ids })).rejects.toBeInstanceOf(TooManyManualRecipientsError);
    });

    it('FIX-3 (b): exactamente MAX ids → NO rechaza por la cota (pasa)', async () => {
      const rows = Array.from({ length: MAX_MANUAL_RECIPIENTS }, (_, i) =>
        makeRow({ clientId: `c${i}`, phone: `3364${String(i).padStart(6, '0')}`, status: 'active' }),
      );
      const source = makeSegmentSource([]);
      const manualSource = makeManualSource(rows);
      const uc = new PreviewCampaignSegment(source, manualSource);

      const result = await uc.execute({ statuses: [], manualClientIds: rows.map((r) => r.clientId) });

      expect(result.count).toBe(MAX_MANUAL_RECIPIENTS);
    });
  });

  it('SEG-5: el preview es de solo lectura — dos llamadas seguidas dan el mismo resultado', async () => {
    const source = makeSegmentSource([
      makeRow({ clientId: 'c1', phone: '3364111111', status: 'late' }),
    ]);
    const uc = new PreviewCampaignSegment(source);

    const first = await uc.execute({ statuses: ['late'] });
    const second = await uc.execute({ statuses: ['late'] });

    expect(first).toEqual(second);
  });

  // ── bulk-task-recipients (TASK-1, TASK-2): 5to dominio taskStageIds ──────────
  describe('bulk-task-recipients (TASK-1, TASK-2): taskStageIds', () => {
    it('TASK-2: taskStageIds NO mapeado → TaskStageNotEligibleError propagado (seam completo, 422 ANTES de resolver clientes)', async () => {
      const source = makeSegmentSource([]);
      const listSpy = jest.spyOn(source, 'listSegmentRecipients');
      const taskConfigRepo = makeTaskStageConfigRepo(['stageA']);
      const uc = new PreviewCampaignSegment(source, undefined, undefined, taskConfigRepo);

      await expect(
        uc.execute({ statuses: [], taskStageIds: ['stageA', 'stageB'] }),
      ).rejects.toBeInstanceOf(TaskStageNotEligibleError);
      expect(listSpy).not.toHaveBeenCalled();
    });

    it('TASK-1: combinación con manual — manualClientIds:["c1"] + taskStageIds:["stageA"] (mapeado, c2 con tarea abierta) → 2 recipients: c1 manual, c2 task', async () => {
      const source = makeSegmentSource([]);
      const manualSource = makeManualSource([
        makeRow({ clientId: 'c1', phone: '3364111111', status: 'active' }),
        makeRow({ clientId: 'c2', phone: '3364222222', status: 'active' }),
      ]);
      const taskConfigRepo = makeTaskStageConfigRepo(['stageA']);
      const taskSource = makeTaskSource(['c2']);
      const uc = new PreviewCampaignSegment(source, manualSource, taskSource, taskConfigRepo);

      const result = await uc.execute({ statuses: [], manualClientIds: ['c1'], taskStageIds: ['stageA'] });

      expect(result.count).toBe(2);
    });

    it('noCustomerCount: expone el chip agregado de tareas de red sin cliente', async () => {
      const source = makeSegmentSource([]);
      const taskConfigRepo = makeTaskStageConfigRepo(['stageA']);
      const taskSource = makeTaskSource([], 4);
      const uc = new PreviewCampaignSegment(source, undefined, taskSource, taskConfigRepo);

      const result = await uc.execute({ statuses: [], taskStageIds: ['stageA'] });

      expect(result.noCustomerCount).toBe(4);
    });

    it('taskSkipped se SUMA a skipped de salida (opt-out resuelto por tarea)', async () => {
      const source = makeSegmentSource([]);
      const manualSource = makeManualSource([
        makeRow({ clientId: 'c1', phone: '3364111111', status: 'active', whatsappOptOutAt: '2026-01-01T00:00:00.000Z' }),
      ]);
      const taskConfigRepo = makeTaskStageConfigRepo(['stageA']);
      const taskSource = makeTaskSource(['c1']);
      const uc = new PreviewCampaignSegment(source, manualSource, taskSource, taskConfigRepo);

      const result = await uc.execute({ statuses: [], taskStageIds: ['stageA'] });

      expect(result.count).toBe(0);
      expect(result.skipped.optedOut).toBe(1);
    });

    it('no-regresión: sin taskStageIds → noCustomerCount:0, taskSkipped no afecta skipped (byte-idéntico)', async () => {
      const source = makeSegmentSource([
        makeRow({ clientId: 'c1', phone: '3364111111', status: 'late', whatsappOptOutAt: '2026-01-01T00:00:00.000Z' }),
        makeRow({ clientId: 'c2', phone: '3364222222', status: 'late' }),
      ]);
      const uc = new PreviewCampaignSegment(source);

      const result = await uc.execute({ statuses: ['late'] });

      expect(result.count).toBe(1);
      expect(result.skipped).toEqual({ optedOut: 1, duplicatePhone: 0, invalidPhone: 0 });
      expect(result.noCustomerCount).toBe(0);
    });
  });
});

describe('PreviewCampaignSegment — taskWillTransitionCount (bulk-task-stage-transition, TRANS-6)', () => {
  it('2 tareas de un cliente + destino configurado → count 2 y taskWillTransitionCount 2', async () => {
    const segmentSource = { listSegmentRecipients: async () => [] };
    const manualSource = { findRecipientCandidatesByIds: async (ids: string[]) => ids.map((clientId) => ({ clientId, name: 'C', phone: '3364111111', balanceDue: 0, whatsappOptOutAt: null, status: 'active' })) };
    const taskSource = {
      listClientIdsByOpenTaskStages: async () => ['c1'],
      listOpenTasksByStages: async () => [
        { taskId: 't10', clientId: 'c1', fromStageId: 'sA' },
        { taskId: 't11', clientId: 'c1', fromStageId: 'sA' },
      ],
      countOpenTasksWithoutCustomer: async () => 0,
    };
    const transitionConfig = { getResultingStageId: async () => 'sB', getResultingStage: async () => null, setResultingStageId: async () => {} };
    const stageConfig = { listMappedStageIds: async () => ['sA'], getMappedStages: async () => [], replaceMappedStages: async () => {} };

    const uc = new PreviewCampaignSegment(segmentSource as any, manualSource as any, taskSource as any, stageConfig as any, transitionConfig as any);
    const out = await uc.execute({ statuses: [], taskStageIds: ['sA'] } as any);

    expect(out.count).toBe(2);
    expect(out.taskWillTransitionCount).toBe(2);
  });

  it('sin destino configurado → taskWillTransitionCount 0 (solo se envía)', async () => {
    const segmentSource = { listSegmentRecipients: async () => [] };
    const manualSource = { findRecipientCandidatesByIds: async (ids: string[]) => ids.map((clientId) => ({ clientId, name: 'C', phone: '3364111111', balanceDue: 0, whatsappOptOutAt: null, status: 'active' })) };
    const taskSource = {
      listClientIdsByOpenTaskStages: async () => ['c1'],
      listOpenTasksByStages: async () => [{ taskId: 't10', clientId: 'c1', fromStageId: 'sA' }],
      countOpenTasksWithoutCustomer: async () => 0,
    };
    const transitionConfig = { getResultingStageId: async () => null, getResultingStage: async () => null, setResultingStageId: async () => {} };
    const stageConfig = { listMappedStageIds: async () => ['sA'], getMappedStages: async () => [], replaceMappedStages: async () => {} };

    const uc = new PreviewCampaignSegment(segmentSource as any, manualSource as any, taskSource as any, stageConfig as any, transitionConfig as any);
    const out = await uc.execute({ statuses: [], taskStageIds: ['sA'] } as any);

    expect(out.count).toBe(1);
    expect(out.taskWillTransitionCount).toBe(0);
  });
});

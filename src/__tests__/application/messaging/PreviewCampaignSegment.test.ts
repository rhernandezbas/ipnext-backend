/**
 * messaging-bulk (F2, T3.6) — PreviewCampaignSegment a.k.a. CountRecipients.
 * Un caso por escenario SEG-1..SEG-5. Usa `resolveRecipients` (T3.5) +
 * `FakeCustomerRepository.listSegmentRecipients` (stub inline, T3.3 — la
 * implementación Prisma real recién llega en Batch 6, acá el fake alcanza).
 * RBAC gate `messaging.bulk` se testea en la ruta (Batch 7), no acá.
 */
import { PreviewCampaignSegment } from '@application/use-cases/messaging/PreviewCampaignSegment';
import { UnfilteredSegmentError } from '@domain/errors/messaging-bulk';
import type { CampaignSegmentSource, CampaignRecipientCandidate, CampaignSegmentFilter } from '@domain/ports/CustomerRepository';

interface FakeClientRow extends CampaignRecipientCandidate {
  status: string;
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

  it('SEG-5: el preview es de solo lectura — dos llamadas seguidas dan el mismo resultado', async () => {
    const source = makeSegmentSource([
      makeRow({ clientId: 'c1', phone: '3364111111', status: 'late' }),
    ]);
    const uc = new PreviewCampaignSegment(source);

    const first = await uc.execute({ statuses: ['late'] });
    const second = await uc.execute({ statuses: ['late'] });

    expect(first).toEqual(second);
  });
});

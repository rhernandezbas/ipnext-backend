/**
 * messaging-bulk v1.1 (preview modal paginado) — ListSegmentRecipients.
 * Reusa la MISMA resolución que `PreviewCampaignSegment` (`resolveRecipients`
 * + `assertSegmentIsFiltered`) sobre `CampaignSegmentSource.listSegmentRecipients`,
 * pero en vez de una `sample` acotada, PAGINA el set `resolved` completo — el
 * segmento NO está persistido, se re-resuelve en cada llamada (on-the-fly,
 * SEG-5 de solo lectura, mismo criterio que el preview).
 */
import { ListSegmentRecipients } from '@application/use-cases/messaging/ListSegmentRecipients';
import { UnfilteredSegmentError } from '@domain/errors/messaging-bulk';
import type { CampaignSegmentSource, CampaignRecipientCandidate, CampaignSegmentFilter } from '@domain/ports/CustomerRepository';

interface FakeClientRow extends CampaignRecipientCandidate {
  status: string;
}

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

describe('ListSegmentRecipients', () => {
  it('resuelve el mismo segmento que el preview (statuses + balance) y devuelve los destinatarios paginados', async () => {
    const source = makeSegmentSource([
      makeRow({ clientId: 'c1', phone: '3364111111', status: 'late' }),
      makeRow({ clientId: 'c2', phone: '3364222222', status: 'active' }),
      makeRow({ clientId: 'c3', phone: '3364333333', status: 'late' }),
    ]);
    const uc = new ListSegmentRecipients(source);

    const result = await uc.execute({ statuses: ['late'] });

    expect(result.total).toBe(2);
    expect(result.data.map((r) => r.clientId)).toEqual(['c1', 'c3']);
    expect(result.data.every((r) => r.status === 'late')).toBe(true);
  });

  it('default page:1/limit:25 cuando no vienen', async () => {
    const source = makeSegmentSource([makeRow({ clientId: 'c1', phone: '3364111111', status: 'late' })]);
    const uc = new ListSegmentRecipients(source);

    const result = await uc.execute({ statuses: ['late'] });

    expect(result.page).toBe(1);
    expect(result.limit).toBe(25);
  });

  it('pagina el set RESUELTO (post-filtro), page 2 con limit 2 devuelve el resto determinístico por clientId', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => makeRow({ clientId: `c${i + 1}`, phone: `336400000${i}`, status: 'late' }));
    const source = makeSegmentSource(rows);
    const uc = new ListSegmentRecipients(source);

    const page1 = await uc.execute({ statuses: ['late'], page: 1, limit: 2 });
    const page2 = await uc.execute({ statuses: ['late'], page: 2, limit: 2 });

    expect(page1.data.map((r) => r.clientId)).toEqual(['c1', 'c2']);
    expect(page2.data.map((r) => r.clientId)).toEqual(['c3', 'c4']);
    expect(page1.total).toBe(5);
    expect(page2.total).toBe(5);
  });

  it('página fuera de rango → data vacío, total correcto (no explota)', async () => {
    const source = makeSegmentSource([makeRow({ clientId: 'c1', phone: '3364111111', status: 'late' })]);
    const uc = new ListSegmentRecipients(source);

    const result = await uc.execute({ statuses: ['late'], page: 5, limit: 10 });

    expect(result.data).toEqual([]);
    expect(result.total).toBe(1);
  });

  it('propaga skipped (opt-out/dedup/inválido) — mismo criterio que el preview', async () => {
    const source = makeSegmentSource([
      makeRow({ clientId: 'c1', phone: '3364111111', status: 'late', whatsappOptOutAt: '2026-01-01T00:00:00.000Z' }),
      makeRow({ clientId: 'c2', phone: '123', status: 'late' }), // teléfono inválido
      makeRow({ clientId: 'c3', phone: '3364333333', status: 'late' }),
    ]);
    const uc = new ListSegmentRecipients(source);

    const result = await uc.execute({ statuses: ['late'] });

    expect(result.skipped).toEqual({ optedOut: 1, duplicatePhone: 0, invalidPhone: 1 });
    expect(result.total).toBe(1);
  });

  it('propaga statusCounts sobre el set resuelto (post-filtro), agrupado por status', async () => {
    const source = makeSegmentSource([
      makeRow({ clientId: 'c1', phone: '3364111111', status: 'late' }),
      makeRow({ clientId: 'c2', phone: '3364222222', status: 'blocked' }),
    ]);
    const uc = new ListSegmentRecipients(source);

    const result = await uc.execute({ statuses: ['late', 'blocked'] });

    expect(result.statusCounts).toEqual({ late: 1, blocked: 1 });
  });

  it('segmento sin criterio → UnfilteredSegmentError, rechaza ANTES de tocar la fuente (mismo guard que el preview)', async () => {
    const source = makeSegmentSource([makeRow({ clientId: 'c1', status: 'active' })]);
    const listSpy = jest.spyOn(source, 'listSegmentRecipients');
    const uc = new ListSegmentRecipients(source);

    await expect(uc.execute({ statuses: [] })).rejects.toBeInstanceOf(UnfilteredSegmentError);
    expect(listSpy).not.toHaveBeenCalled();
  });

  it('de solo lectura — dos llamadas seguidas con el mismo input dan el mismo resultado (on-the-fly, no persiste nada)', async () => {
    const source = makeSegmentSource([makeRow({ clientId: 'c1', phone: '3364111111', status: 'late' })]);
    const uc = new ListSegmentRecipients(source);

    const first = await uc.execute({ statuses: ['late'] });
    const second = await uc.execute({ statuses: ['late'] });

    expect(first).toEqual(second);
  });
});

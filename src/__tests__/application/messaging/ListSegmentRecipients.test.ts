/**
 * messaging-bulk v1.1 (preview modal paginado) — ListSegmentRecipients.
 * Reusa la MISMA resolución que `PreviewCampaignSegment` (`resolveRecipients`
 * + `assertSegmentIsFiltered`) sobre `CampaignSegmentSource.listSegmentRecipients`,
 * pero en vez de una `sample` acotada, PAGINA el set `resolved` completo — el
 * segmento NO está persistido, se re-resuelve en cada llamada (on-the-fly,
 * SEG-5 de solo lectura, mismo criterio que el preview).
 */
import { ListSegmentRecipients } from '@application/use-cases/messaging/ListSegmentRecipients';
import { UnfilteredSegmentError, TaskStageNotEligibleError } from '@domain/errors/messaging-bulk';
import type { CampaignSegmentSource, CampaignRecipientCandidate, CampaignSegmentFilter, ManualRecipientSource } from '@domain/ports/CustomerRepository';
import type { TaskRecipientSource } from '@domain/ports/TaskRecipientSource';
import type { TaskStageRecipientConfigRepository } from '@domain/ports/TaskStageRecipientConfigRepository';

function makeManualSource(rows: FakeClientRow[]): ManualRecipientSource {
  return {
    findRecipientCandidatesByIds: async (ids: string[]) => {
      const wanted = new Set(ids);
      return rows.filter((r) => wanted.has(r.clientId));
    },
  };
}

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

/** bulk-task-recipients (B5.3) — fake narrow del 5to dominio "Tarea" (resolución). */
function makeTaskSource(clientIds: string[], noCustomerCount = 0): TaskRecipientSource {
  return {
    listClientIdsByOpenTaskStages: async () => clientIds,
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

  // ── bulk-csv-recipients (DET-1..DET-3, D11): unión completa + vista excluded ──
  describe('bulk-csv-recipients (DET-1..DET-3): manualClientIds/manualContacts/view', () => {
    it('DET-1: solo-manual (segmento sin criterio) → 200, cierra la deuda F4 (antes 400 UNFILTERED_SEGMENT)', async () => {
      const source = makeSegmentSource([]);
      const manualSource = makeManualSource([makeRow({ clientId: 'c1', phone: '3364111111', status: 'active' })]);
      const uc = new ListSegmentRecipients(source, manualSource);

      const result = await uc.execute({ statuses: [], manualClientIds: ['c1'] });

      expect(result.total).toBe(1);
      expect(result.data[0]).toMatchObject({ clientId: 'c1', source: 'manual' });
    });

    it('DET-1: unión mixta segmento+manual+CSV — cada item trae SU source', async () => {
      const source = makeSegmentSource([makeRow({ clientId: 'c1', phone: '3364111111', status: 'late' })]);
      const manualSource = makeManualSource([makeRow({ clientId: 'c2', phone: '3364222222', status: 'active' })]);
      const uc = new ListSegmentRecipients(source, manualSource);

      const result = await uc.execute({
        statuses: ['late'],
        manualClientIds: ['c2'],
        manualContacts: [{ name: 'Crudo', phone: '3364333333' }],
      });

      expect(result.total).toBe(3);
      const bySource = new Map(result.data.map((r: any) => [r.source, r]));
      expect(bySource.get('segment')).toMatchObject({ clientId: 'c1' });
      expect(bySource.get('manual')).toMatchObject({ clientId: 'c2' });
      expect(bySource.get('csv')).toMatchObject({ clientId: null, status: 'no_cliente' });
    });

    it("view:'excluded' — detalle paginado con reason por persona", async () => {
      const source = makeSegmentSource([makeRow({ clientId: 'c1', phone: '3364111111', status: 'late' })]);
      const uc = new ListSegmentRecipients(source);

      const result = await uc.execute({
        statuses: ['late'],
        manualContacts: [
          { name: '', phone: '3364999999' }, // sin_nombre
          { name: 'Beto', phone: 'no-es-numero' }, // telefono_invalido
          { name: 'Dup', phone: '3364111111' }, // duplicado del segmento
        ],
        view: 'excluded',
      });

      expect(result.data).toHaveLength(3);
      const reasons = (result.data as any[]).map((d) => d.reason).sort();
      expect(reasons).toEqual(['duplicado', 'sin_nombre', 'telefono_invalido']);
    });

    it("view:'excluded' — paginado (30 exclusiones, page 2/limit 20 → 10)", async () => {
      const source = makeSegmentSource([]);
      const uc = new ListSegmentRecipients(source);
      const contacts = Array.from({ length: 30 }, () => ({ name: '', phone: '11111' })); // todas sin_nombre

      const page2 = await uc.execute({ statuses: [], manualContacts: contacts, view: 'excluded', page: 2, limit: 20 });

      expect(page2.data).toHaveLength(10);
      expect(page2.total).toBe(30);
      expect(page2.page).toBe(2);
    });

    it('no-regresión: body SIN view/manualClientIds/manualContacts (solo segmento) → shape y valores EXACTOS de antes', async () => {
      const source = makeSegmentSource([
        makeRow({ clientId: 'c1', phone: '3364111111', status: 'late' }),
        makeRow({ clientId: 'c2', phone: '3364222222', status: 'active' }),
      ]);
      const uc = new ListSegmentRecipients(source);

      const result = await uc.execute({ statuses: ['late'] });

      expect(result.total).toBe(1);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(25);
      expect(result.skipped).toEqual({ optedOut: 0, duplicatePhone: 0, invalidPhone: 0 });
      expect(result.data.map((r: any) => r.clientId)).toEqual(['c1']);
    });
  });

  // ── bulk-task-recipients (TASK-1, TASK-2): 5to dominio taskStageIds ──────────
  describe('bulk-task-recipients (TASK-1, TASK-2): taskStageIds', () => {
    it('TASK-2: taskStageIds NO mapeado → TaskStageNotEligibleError, rechaza ANTES de tocar la fuente', async () => {
      const source = makeSegmentSource([]);
      const listSpy = jest.spyOn(source, 'listSegmentRecipients');
      const taskConfigRepo = makeTaskStageConfigRepo(['stageA']);
      const uc = new ListSegmentRecipients(source, undefined, undefined, taskConfigRepo);

      await expect(
        uc.execute({ statuses: [], taskStageIds: ['stageA', 'stageB'] }),
      ).rejects.toBeInstanceOf(TaskStageNotEligibleError);
      expect(listSpy).not.toHaveBeenCalled();
    });

    it('TASK-1: solo-tarea (segmento sin criterio) → 200 con el destinatario resuelto por tarea, source:"task"', async () => {
      const source = makeSegmentSource([]);
      const manualSource = makeManualSource([makeRow({ clientId: 'c1', phone: '3364111111', status: 'active' })]);
      const taskConfigRepo = makeTaskStageConfigRepo(['stageA']);
      const taskSource = makeTaskSource(['c1']);
      const uc = new ListSegmentRecipients(source, manualSource, taskSource, taskConfigRepo);

      const result = await uc.execute({ statuses: [], taskStageIds: ['stageA'] });

      expect(result.total).toBe(1);
      expect(result.data[0]).toMatchObject({ clientId: 'c1', source: 'task' });
    });

    it('noCustomerCount: expone el chip agregado de tareas de red sin cliente', async () => {
      const source = makeSegmentSource([]);
      const taskConfigRepo = makeTaskStageConfigRepo(['stageA']);
      const taskSource = makeTaskSource([], 5);
      const uc = new ListSegmentRecipients(source, undefined, taskSource, taskConfigRepo);

      const result = await uc.execute({ statuses: [], taskStageIds: ['stageA'] });

      expect(result.noCustomerCount).toBe(5);
    });
  });
});

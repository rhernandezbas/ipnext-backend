/**
 * messaging-bulk (F2, T3.8) — ListCampaigns. Paginado, orden createdAt DESC,
 * vacío → {data:[]} (HIST-1). Seam completo: use case REAL +
 * InMemoryCampaignRepository REAL (T3.1).
 */
import { ListCampaigns } from '@application/use-cases/messaging/ListCampaigns';
import { InMemoryCampaignRepository } from '@infrastructure/adapters/in-memory/InMemoryCampaignRepository';

describe('ListCampaigns', () => {
  it('HIST-1: listado con campañas de distinto estado, más reciente primero, con contadores', async () => {
    let tick = 0;
    const repo = new InMemoryCampaignRepository({ now: () => new Date(2026, 0, 1 + tick++) });
    const pending = await repo.create({
      name: 'Pending camp',
      templateRef: 'HXabc',
      segment: { statuses: [] },
      variableSpec: {},
      total: 1,
      createdById: 'user-1',
    });
    const running = await repo.create({
      name: 'Running camp',
      templateRef: 'HXabc',
      segment: { statuses: [] },
      variableSpec: {},
      total: 2,
      createdById: 'user-1',
    });
    await repo.update(running.id, { status: 'running', sentCount: 1 });
    const done = await repo.create({
      name: 'Done camp',
      templateRef: 'HXabc',
      segment: { statuses: [] },
      variableSpec: {},
      total: 3,
      createdById: 'user-1',
    });
    await repo.update(done.id, { status: 'done', sentCount: 3 });
    const uc = new ListCampaigns(repo);

    const result = await uc.execute({});

    expect(result.data).toHaveLength(3);
    // más reciente primero (createdAt DESC)
    expect(result.data.map((c) => c.id)).toEqual([done.id, running.id, pending.id]);
    expect(result.data.map((c) => c.status)).toEqual(['done', 'running', 'pending']);
  });

  // ── FIX-6-v2: la LISTA no debe mostrar 0 durante el envío (consistente con GetCampaign) ──
  it('FIX-6-v2: una campaña `running` refleja el progreso REAL en la lista, no 0 (aunque el header siga en 0)', async () => {
    const repo = new InMemoryCampaignRepository();
    const created = await repo.create({
      name: 'Camp en vuelo',
      templateRef: 'HXabc',
      segment: { statuses: ['late'] },
      variableSpec: {},
      total: 3,
      createdById: 'user-1',
    });
    const rows = await repo.bulkCreateRecipients(created.id, [
      { clientId: 'c1', phoneNormalized: '111', phoneE164: '+549111' },
      { clientId: 'c2', phoneNormalized: '222', phoneE164: '+549222' },
      { clientId: 'c3', phoneNormalized: '333', phoneE164: '+549333' },
    ]);
    // El worker avanzó (1 sent, 1 failed) pero AÚN NO hizo finalize → header en 0.
    await repo.update(created.id, { status: 'running' });
    await repo.updateRecipient(rows[0].id, { status: 'sent', sentAt: '2026-07-13T00:00:00.000Z' });
    await repo.updateRecipient(rows[1].id, { status: 'failed', error: 'boom' });

    const header = await repo.findById(created.id);
    expect(header?.sentCount).toBe(0); // el snapshot del header sigue en 0 (aún no finalize)

    const uc = new ListCampaigns(repo);
    const result = await uc.execute({});

    const camp = result.data.find((c) => c.id === created.id)!;
    // …pero la LISTA muestra el avance real, igual que GetCampaign (FIX-6).
    expect(camp.sentCount).toBe(1);
    expect(camp.failedCount).toBe(1);
    expect(camp.skippedCount).toBe(0);
    expect(camp.optedOutCount).toBe(0);
  });

  it('HIST-1: sin campañas → {data: []}', async () => {
    const repo = new InMemoryCampaignRepository();
    const uc = new ListCampaigns(repo);

    const result = await uc.execute({});

    expect(result.data).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('HIST-1: respeta paginación (page/limit)', async () => {
    let tick = 0;
    const repo = new InMemoryCampaignRepository({ now: () => new Date(2026, 0, 1 + tick++) });
    for (const name of ['A', 'B', 'C']) {
      await repo.create({
        name,
        templateRef: 'HXabc',
        segment: { statuses: [] },
        variableSpec: {},
        total: 1,
        createdById: 'user-1',
      });
    }
    const uc = new ListCampaigns(repo);

    const firstPage = await uc.execute({ page: 1, limit: 2 });
    const secondPage = await uc.execute({ page: 2, limit: 2 });

    expect(firstPage.data).toHaveLength(2);
    expect(secondPage.data).toHaveLength(1);
    expect(firstPage.total).toBe(3);
  });
});

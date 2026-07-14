/**
 * messaging-bulk (F2, T3.8) — GetCampaign. Header+contadores, recipients
 * paginados opcionales filtrables por status, CAMPAIGN_NOT_FOUND en id
 * inexistente (HIST-2). Seam completo: use case REAL + InMemoryCampaignRepository
 * REAL (T3.1) — no se mockea el repo.
 */
import { GetCampaign } from '@application/use-cases/messaging/GetCampaign';
import { InMemoryCampaignRepository } from '@infrastructure/adapters/in-memory/InMemoryCampaignRepository';
import { CampaignNotFoundError } from '@domain/errors/messaging-bulk';

describe('GetCampaign', () => {
  it('HIST-2: devuelve el header + contadores de la campaña', async () => {
    const repo = new InMemoryCampaignRepository();
    const created = await repo.create({
      name: 'Recordatorio deuda julio',
      templateRef: 'HXabc',
      templateName: 'recordatorio_deuda',
      segment: { statuses: ['late'] },
      variableSpec: {},
      total: 2,
      createdById: 'user-1',
    });
    const rows = await repo.bulkCreateRecipients(created.id, [
      { clientId: 'c1', phoneNormalized: '111', phoneE164: '+549111' },
      { clientId: 'c2', phoneNormalized: '222', phoneE164: '+549222' },
    ]);
    await repo.update(created.id, { status: 'running' });
    await repo.updateRecipient(rows[0].id, { status: 'sent', sentAt: '2026-07-13T00:00:00.000Z' });
    const uc = new GetCampaign(repo);

    const result = await uc.execute({ campaignId: created.id });

    expect(result.campaign.id).toBe(created.id);
    expect(result.campaign.status).toBe('running');
    expect(result.campaign.sentCount).toBe(1); // derivado EN VIVO de los recipients (FIX-6)
    expect(result.campaign.total).toBe(2);
    expect(result.recipients).toBeUndefined(); // includeRecipients no pedido
  });

  // ── FIX-6: contadores EN VIVO durante el envío (no 0 hasta finalize) ───────
  it('FIX-6: durante `running`, GetCampaign refleja el progreso REAL aunque el header siga en 0', async () => {
    const repo = new InMemoryCampaignRepository();
    const created = await repo.create({
      name: 'Camp en vuelo',
      templateRef: 'HXabc',
      segment: { statuses: [] },
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

    const uc = new GetCampaign(repo);
    const result = await uc.execute({ campaignId: created.id });

    // …pero GetCampaign muestra el avance real (1 sent, 1 failed, 1 queued sin contar).
    expect(result.campaign.sentCount).toBe(1);
    expect(result.campaign.failedCount).toBe(1);
    expect(result.campaign.skippedCount).toBe(0);
    expect(result.campaign.optedOutCount).toBe(0);
  });

  it('HIST-2: detalle durante el envío — recipients paginados, filtrables por status', async () => {
    const repo = new InMemoryCampaignRepository();
    const created = await repo.create({
      name: 'Camp',
      templateRef: 'HXabc',
      segment: { statuses: [] },
      variableSpec: {},
      total: 3,
      createdById: 'user-1',
    });
    const rows = await repo.bulkCreateRecipients(created.id, [
      { clientId: 'c1', phoneNormalized: '111', phoneE164: '+549111' },
      { clientId: 'c2', phoneNormalized: '222', phoneE164: '+549222' },
      { clientId: 'c3', phoneNormalized: '333', phoneE164: '+549333' },
    ]);
    await repo.updateRecipient(rows[0].id, { status: 'sent', sentAt: '2026-07-13T00:00:00.000Z' });
    await repo.updateRecipient(rows[1].id, { status: 'failed', error: 'boom' });
    const uc = new GetCampaign(repo);

    const all = await uc.execute({ campaignId: created.id, includeRecipients: true });
    const onlySent = await uc.execute({ campaignId: created.id, includeRecipients: true, status: 'sent' });

    expect(all.recipients?.total).toBe(3);
    expect(onlySent.recipients?.total).toBe(1);
    expect(onlySent.recipients?.data[0].clientId).toBe('c1');
    expect(onlySent.recipients?.data[0].status).toBe('sent');
  });

  it('HIST-2: campaña inexistente → CAMPAIGN_NOT_FOUND', async () => {
    const repo = new InMemoryCampaignRepository();
    const uc = new GetCampaign(repo);

    await expect(uc.execute({ campaignId: 'does-not-exist' })).rejects.toThrow(CampaignNotFoundError);
  });

  it('HIST-3: el recipient expone SOLO un error saneado (string), nunca el objeto crudo del proveedor', async () => {
    const repo = new InMemoryCampaignRepository();
    const created = await repo.create({
      name: 'Camp',
      templateRef: 'HXabc',
      segment: { statuses: [] },
      variableSpec: {},
      total: 1,
      createdById: 'user-1',
    });
    const [row] = await repo.bulkCreateRecipients(created.id, [
      { clientId: 'c1', phoneNormalized: '111', phoneE164: '+549111' },
    ]);
    // el use case NUNCA sanea — el saneo ocurre en el WRITER (SendCampaign, Batch 4)
    // antes de persistir. Acá solo verificamos que el DTO expone `error` como
    // string plano (lo que sea que esté persistido), nunca un objeto anidado.
    await repo.updateRecipient(row.id, { status: 'failed', error: 'Provider rejected the message' });
    const uc = new GetCampaign(repo);

    const result = await uc.execute({ campaignId: created.id, includeRecipients: true });

    expect(typeof result.recipients?.data[0].error).toBe('string');
    expect(result.recipients?.data[0].error).toBe('Provider rejected the message');
  });
});

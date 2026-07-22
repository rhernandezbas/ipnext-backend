/**
 * messaging-bulk (F2, T3.1) — InMemoryCampaignRepository. Molde
 * InMemoryServiceCutBatchRepository (Map-based) + soporte de recipients.
 */
import { InMemoryCampaignRepository } from '@infrastructure/adapters/in-memory/InMemoryCampaignRepository';
import type { CampaignCreateData } from '@domain/ports/CampaignRepository';

function makeCreateData(overrides: Partial<CampaignCreateData> = {}): CampaignCreateData {
  return {
    name: 'Recordatorio deuda julio',
    templateRef: 'HXabc123',
    templateName: 'recordatorio_deuda',
    segment: { statuses: ['late'] },
    variableSpec: { '1': { source: 'name' } },
    total: 2,
    createdById: 'user-1',
    ...overrides,
  };
}

describe('InMemoryCampaignRepository', () => {
  it('create persiste el header en pending con los contadores en 0', async () => {
    const repo = new InMemoryCampaignRepository();
    const campaign = await repo.create(makeCreateData());

    expect(campaign.status).toBe('pending');
    expect(campaign.total).toBe(2);
    expect(campaign.sentCount).toBe(0);
    expect(campaign.failedCount).toBe(0);
    expect(campaign.skippedCount).toBe(0);
    expect(campaign.optedOutCount).toBe(0);
    expect(campaign.id).toEqual(expect.any(String));
  });

  // ── campaign-chatwoot-label (CLBL-6): campo aditivo pass-through ──
  it('create persiste chatwootLabel tal cual (pass-through, sin catálogo); ausente queda null', async () => {
    const repo = new InMemoryCampaignRepository();

    const withLabel = await repo.create(makeCreateData({ chatwootLabel: 'promo-julio' }));
    const withoutLabel = await repo.create(makeCreateData());

    expect(withLabel.chatwootLabel).toBe('promo-julio');
    expect(withoutLabel.chatwootLabel).toBeNull();
  });

  it('findById devuelve la campaña creada; null para un id inexistente', async () => {
    const repo = new InMemoryCampaignRepository();
    const created = await repo.create(makeCreateData());

    const found = await repo.findById(created.id);
    const missing = await repo.findById('does-not-exist');

    expect(found).toEqual(created);
    expect(missing).toBeNull();
  });

  it('update aplica un patch PARCIAL sin tocar los campos no provistos', async () => {
    const repo = new InMemoryCampaignRepository();
    const created = await repo.create(makeCreateData());

    const updated = await repo.update(created.id, { status: 'running', sentCount: 1 });

    expect(updated.status).toBe('running');
    expect(updated.sentCount).toBe(1);
    // no tocados por el patch — deben conservar su valor original
    expect(updated.failedCount).toBe(0);
    expect(updated.total).toBe(2);
    expect(updated.templateRef).toBe('HXabc123');
  });

  it('list devuelve paginado, más reciente primero', async () => {
    let tick = 0;
    const clock = () => new Date(2026, 0, 1 + tick++);
    const repo = new InMemoryCampaignRepository({ now: clock });

    const older = await repo.create(makeCreateData({ name: 'Vieja' }));
    const newer = await repo.create(makeCreateData({ name: 'Nueva' }));

    const page = await repo.list({ page: 1, limit: 25 });

    expect(page.total).toBe(2);
    expect(page.data[0].id).toBe(newer.id);
    expect(page.data[1].id).toBe(older.id);
  });

  it('list respeta page/limit (segunda página trae el resto)', async () => {
    let tick = 0;
    const clock = () => new Date(2026, 0, 1 + tick++);
    const repo = new InMemoryCampaignRepository({ now: clock });
    await repo.create(makeCreateData({ name: 'A' }));
    await repo.create(makeCreateData({ name: 'B' }));
    await repo.create(makeCreateData({ name: 'C' }));

    const firstPage = await repo.list({ page: 1, limit: 2 });
    const secondPage = await repo.list({ page: 2, limit: 2 });

    expect(firstPage.data).toHaveLength(2);
    expect(secondPage.data).toHaveLength(1);
    expect(firstPage.total).toBe(3);
    expect(secondPage.total).toBe(3);
  });

  it('bulkCreateRecipients crea N filas en queued, respeta @@unique[campaignId,clientId] (idempotente)', async () => {
    const repo = new InMemoryCampaignRepository();
    const campaign = await repo.create(makeCreateData());

    const firstBatch = await repo.bulkCreateRecipients(campaign.id, [
      { clientId: 'c1', phoneNormalized: '111', phoneE164: '+5491111' },
      { clientId: 'c2', phoneNormalized: '222', phoneE164: '+5492222' },
    ]);
    // llamar de nuevo con el MISMO clientId no debe duplicar la fila
    const secondBatch = await repo.bulkCreateRecipients(campaign.id, [
      { clientId: 'c1', phoneNormalized: '111', phoneE164: '+5491111' },
    ]);

    expect(firstBatch).toHaveLength(2);
    expect(firstBatch.every((r) => r.status === 'queued')).toBe(true);
    expect(secondBatch).toHaveLength(1);
    expect(secondBatch[0].id).toBe(firstBatch[0].id); // misma fila, no una nueva

    const listed = await repo.listRecipients(campaign.id);
    expect(listed.total).toBe(2); // sigue habiendo solo 2, no 3
  });

  it('updateRecipient aplica un patch parcial sobre UN recipient', async () => {
    const repo = new InMemoryCampaignRepository();
    const campaign = await repo.create(makeCreateData());
    const [recipient] = await repo.bulkCreateRecipients(campaign.id, [
      { clientId: 'c1', phoneNormalized: '111', phoneE164: '+5491111' },
    ]);

    const updated = await repo.updateRecipient(recipient.id, {
      status: 'sent',
      providerId: 'SM123',
      sentAt: '2026-07-13T00:00:00.000Z',
    });

    expect(updated.status).toBe('sent');
    expect(updated.providerId).toBe('SM123');
    expect(updated.sentAt).toBe('2026-07-13T00:00:00.000Z');
  });

  // ── bulk-csv-recipients (D2/PER-2): idempotencia de filas contact (clientId null) ──
  describe('bulk-csv-recipients (PER-2): filas contact (clientId null)', () => {
    it('idempotencia de una fila contact: llamar DOS veces con la MISMA fila (clientId null) no duplica (dedup por phoneNormalized)', async () => {
      const repo = new InMemoryCampaignRepository();
      const campaign = await repo.create(makeCreateData());

      const first = await repo.bulkCreateRecipients(campaign.id, [
        { clientId: null, contactName: 'Ana', phoneNormalized: '3364111111', phoneE164: '+5493364111111' },
      ]);
      const second = await repo.bulkCreateRecipients(campaign.id, [
        { clientId: null, contactName: 'Ana', phoneNormalized: '3364111111', phoneE164: '+5493364111111' },
      ]);

      expect(first).toHaveLength(1);
      expect(second).toHaveLength(1);
      expect(second[0].id).toBe(first[0].id); // misma fila, no una nueva

      const listed = await repo.listRecipients(campaign.id);
      expect(listed.total).toBe(1);
    });

    it('mezcla vinculadas + crudas: bulkCreateRecipients con AMBOS tipos en el mismo batch devuelve las dos, con sus campos', async () => {
      const repo = new InMemoryCampaignRepository();
      const campaign = await repo.create(makeCreateData());

      const rows = await repo.bulkCreateRecipients(campaign.id, [
        { clientId: 'c1', phoneNormalized: '3364111111', phoneE164: '+5493364111111' },
        { clientId: null, contactName: 'Ana', phoneNormalized: '3364222222', phoneE164: '+5493364222222' },
      ]);

      expect(rows).toHaveLength(2);
      const linked = rows.find((r) => r.clientId === 'c1');
      const contact = rows.find((r) => r.clientId === null);
      expect(linked?.contactName).toBeNull();
      expect(contact?.contactName).toBe('Ana');
      expect(contact?.status).toBe('queued');
    });
  });

  it('listRecipients filtra por statusIn', async () => {
    const repo = new InMemoryCampaignRepository();
    const campaign = await repo.create(makeCreateData());
    const rows = await repo.bulkCreateRecipients(campaign.id, [
      { clientId: 'c1', phoneNormalized: '111', phoneE164: '+5491111' },
      { clientId: 'c2', phoneNormalized: '222', phoneE164: '+5492222' },
      { clientId: 'c3', phoneNormalized: '333', phoneE164: '+5493333' },
    ]);
    await repo.updateRecipient(rows[0].id, { status: 'sent' });
    await repo.updateRecipient(rows[1].id, { status: 'failed' });
    // rows[2] queda queued

    const onlyQueued = await repo.listRecipients(campaign.id, { statusIn: ['queued'] });
    const sentOrFailed = await repo.listRecipients(campaign.id, { statusIn: ['sent', 'failed'] });

    expect(onlyQueued.total).toBe(1);
    expect(onlyQueued.data[0].clientId).toBe('c3');
    expect(sentOrFailed.total).toBe(2);
    expect(sentOrFailed.data.map((r) => r.clientId).sort()).toEqual(['c1', 'c2']);
  });
});

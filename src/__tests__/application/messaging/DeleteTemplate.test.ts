/**
 * Change 3 (templates CRUD, T3) — DeleteTemplate con GUARD de campañas activas.
 * Antes de borrar (irreversible: toca Meta/WABA), consulta `ActiveCampaignLookup`:
 * si hay una campaña `pending`/`running` que usa ese `contentSid` como
 * `templateRef`, NO borra y lanza `TemplateInUseByCampaignError`. Se ejercita con
 * el `InMemoryCampaignRepository` real (implementa el lookup) + el fake del port.
 */
import { DeleteTemplate } from '@application/use-cases/messaging/DeleteTemplate';
import { TemplateInUseByCampaignError } from '@domain/errors/messaging-bulk';
import { InMemoryTemplateMessagingGateway } from '@infrastructure/adapters/in-memory/InMemoryTemplateMessagingGateway';
import { InMemoryCampaignRepository } from '@infrastructure/adapters/in-memory/InMemoryCampaignRepository';
import type { TemplateDto } from '@domain/ports/TemplateMessagingPort';

const SEED: TemplateDto = {
  contentSid: 'HXdel',
  friendlyName: 'd',
  language: 'es',
  variables: {},
  approvalStatus: 'approved',
  body: 'x',
};

function seedTemplate() {
  return new InMemoryTemplateMessagingGateway({ templates: [SEED] });
}

describe('DeleteTemplate (T3, guard campañas activas)', () => {
  it('sin campañas activas → borra con deleteInWaba=true', async () => {
    const gw = seedTemplate();
    const repo = new InMemoryCampaignRepository();

    await new DeleteTemplate(gw, repo).execute('HXdel');

    expect(gw.deleteCalls).toEqual([{ contentSid: 'HXdel', deleteInWaba: true }]);
  });

  it('con campaña pending usando ese contentSid → NO borra, TemplateInUseByCampaignError', async () => {
    const gw = seedTemplate();
    const repo = new InMemoryCampaignRepository();
    await repo.create({ name: 'c', templateRef: 'HXdel', segment: { statuses: ['late'] }, variableSpec: {}, total: 1, createdById: 'u' });

    await expect(new DeleteTemplate(gw, repo).execute('HXdel')).rejects.toBeInstanceOf(TemplateInUseByCampaignError);
    expect(gw.deleteCalls).toHaveLength(0);
  });

  it('con campaña running → NO borra', async () => {
    const gw = seedTemplate();
    const repo = new InMemoryCampaignRepository();
    const c = await repo.create({ name: 'c', templateRef: 'HXdel', segment: { statuses: ['late'] }, variableSpec: {}, total: 1, createdById: 'u' });
    await repo.update(c.id, { status: 'running' });

    await expect(new DeleteTemplate(gw, repo).execute('HXdel')).rejects.toBeInstanceOf(TemplateInUseByCampaignError);
    expect(gw.deleteCalls).toHaveLength(0);
  });

  // Fix wave (review adversarial 🟡#1) — `paused` es EN-VUELO (deriveLiveCounters
  // `isInFlight = running || paused`, ListCampaigns lo trata igual), NO terminal:
  // una campaña pausada puede reanudarse y volver a enviar el template.
  it('con campaña `paused` (en vuelo) → NO borra', async () => {
    const gw = seedTemplate();
    const repo = new InMemoryCampaignRepository();
    const c = await repo.create({ name: 'c', templateRef: 'HXdel', segment: { statuses: ['late'] }, variableSpec: {}, total: 1, createdById: 'u' });
    await repo.update(c.id, { status: 'paused' });

    await expect(new DeleteTemplate(gw, repo).execute('HXdel')).rejects.toBeInstanceOf(TemplateInUseByCampaignError);
    expect(gw.deleteCalls).toHaveLength(0);
  });

  it('campaña `done` con ese contentSid → NO bloquea (borra igual)', async () => {
    const gw = seedTemplate();
    const repo = new InMemoryCampaignRepository();
    const c = await repo.create({ name: 'c', templateRef: 'HXdel', segment: { statuses: ['late'] }, variableSpec: {}, total: 1, createdById: 'u' });
    await repo.update(c.id, { status: 'done' });

    await new DeleteTemplate(gw, repo).execute('HXdel');

    expect(gw.deleteCalls).toHaveLength(1);
  });

  it('campaña activa pero de OTRO template → borra', async () => {
    const gw = seedTemplate();
    const repo = new InMemoryCampaignRepository();
    await repo.create({ name: 'c', templateRef: 'HXother', segment: { statuses: ['late'] }, variableSpec: {}, total: 1, createdById: 'u' });

    await new DeleteTemplate(gw, repo).execute('HXdel');

    expect(gw.deleteCalls).toHaveLength(1);
  });
});

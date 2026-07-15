/**
 * Change 3 (templates CRUD, T1) — los 4 métodos de administración (create/get/
 * delete/submit) agregados a `InMemoryTemplateMessagingGateway` (ahora también
 * implementa `TemplateAdminPort`). Fake in-memory para TDD — NO se mockea axios.
 * El fake sostiene un store por `contentSid` (seedeable desde el ctor) para que
 * create→get→delete/submit sean coherentes entre sí.
 */
import { InMemoryTemplateMessagingGateway } from '@infrastructure/adapters/in-memory/InMemoryTemplateMessagingGateway';
import { TemplateNotFoundError } from '@domain/errors/messaging-bulk';
import type { TemplateDto } from '@domain/ports/TemplateMessagingPort';

const SEED: TemplateDto = {
  contentSid: 'HXseed',
  friendlyName: 'seed',
  language: 'es',
  variables: { '1': 'nombre' },
  approvalStatus: 'approved',
  category: 'UTILITY',
  body: 'Hola {{1}}',
};

describe('InMemoryTemplateMessagingGateway — admin (Change 3, T1)', () => {
  it('createTemplate: registra la llamada, genera contentSid HX*, devuelve DTO unsubmitted y queda consultable', async () => {
    const gw = new InMemoryTemplateMessagingGateway();

    const dto = await gw.createTemplate({ friendlyName: 'promo', language: 'es', variables: { '1': '1' }, body: 'Hola {{1}}' });

    expect(dto.contentSid).toMatch(/^HX/);
    expect(dto.friendlyName).toBe('promo');
    expect(dto.approvalStatus).toBe('unsubmitted');
    expect(dto.body).toBe('Hola {{1}}');
    expect(dto.variables).toEqual({ '1': '1' });
    expect(gw.createCalls).toEqual([{ friendlyName: 'promo', language: 'es', variables: { '1': '1' }, body: 'Hola {{1}}' }]);
    await expect(gw.getTemplate(dto.contentSid)).resolves.toMatchObject({ contentSid: dto.contentSid });
  });

  it('getTemplate: sid existente (seed) → DTO; inexistente → TemplateNotFoundError', async () => {
    const gw = new InMemoryTemplateMessagingGateway({ templates: [SEED] });

    await expect(gw.getTemplate('HXseed')).resolves.toMatchObject({ contentSid: 'HXseed', approvalStatus: 'approved' });
    await expect(gw.getTemplate('HXnope')).rejects.toBeInstanceOf(TemplateNotFoundError);
  });

  it('deleteTemplate: borra del store + registra deleteInWaba; luego getTemplate lanza NotFound', async () => {
    const gw = new InMemoryTemplateMessagingGateway({ templates: [SEED] });

    await gw.deleteTemplate('HXseed', true);

    expect(gw.deleteCalls).toEqual([{ contentSid: 'HXseed', deleteInWaba: true }]);
    await expect(gw.getTemplate('HXseed')).rejects.toBeInstanceOf(TemplateNotFoundError);
  });

  it('deleteTemplate: sid inexistente → TemplateNotFoundError', async () => {
    const gw = new InMemoryTemplateMessagingGateway();

    await expect(gw.deleteTemplate('HXnope')).rejects.toBeInstanceOf(TemplateNotFoundError);
  });

  it('submitForApproval: pasa a pending + setea category; registra la llamada', async () => {
    const gw = new InMemoryTemplateMessagingGateway({
      templates: [{ ...SEED, contentSid: 'HXsub', approvalStatus: 'unsubmitted' }],
    });

    await gw.submitForApproval('HXsub', 'promo_julio', 'MARKETING');

    expect(gw.submitCalls).toEqual([{ contentSid: 'HXsub', name: 'promo_julio', category: 'MARKETING' }]);
    const dto = await gw.getTemplate('HXsub');
    expect(dto.approvalStatus).toBe('pending');
    expect(dto.category).toBe('MARKETING');
  });

  it('submitForApproval: sid inexistente → TemplateNotFoundError', async () => {
    const gw = new InMemoryTemplateMessagingGateway();

    await expect(gw.submitForApproval('HXnope', 'x', 'UTILITY')).rejects.toBeInstanceOf(TemplateNotFoundError);
  });

  it('listTemplates refleja los templates creados (store-backed)', async () => {
    const gw = new InMemoryTemplateMessagingGateway({ templates: [SEED] });
    await gw.createTemplate({ friendlyName: 'nuevo', language: 'es', variables: {}, body: 'x' });

    const all = await gw.listTemplates();

    expect(all.map((t) => t.friendlyName).sort()).toEqual(['nuevo', 'seed']);
  });
});

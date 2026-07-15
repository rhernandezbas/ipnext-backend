/**
 * Change 3 (templates CRUD, T3) — GetTemplate ("ver ficha"). Delega en el port,
 * mapea a DTO curado. sid inexistente → TemplateNotFoundError (que la ruta mapea
 * a 404). Fake in-memory del port (NO axios).
 */
import { GetTemplate } from '@application/use-cases/messaging/GetTemplate';
import { TemplateNotFoundError } from '@domain/errors/messaging-bulk';
import { InMemoryTemplateMessagingGateway } from '@infrastructure/adapters/in-memory/InMemoryTemplateMessagingGateway';
import type { TemplateDto } from '@domain/ports/TemplateMessagingPort';

const SEED: TemplateDto = {
  contentSid: 'HXg',
  friendlyName: 'g',
  language: 'es',
  variables: { '1': 'nombre' },
  approvalStatus: 'approved',
  category: 'UTILITY',
  body: 'Hola {{1}}',
};

describe('GetTemplate (T3)', () => {
  it('sid existe → DTO curado (variables como nombres, sendable por approvalStatus)', async () => {
    const gw = new InMemoryTemplateMessagingGateway({ templates: [SEED] });

    const dto = await new GetTemplate(gw).execute('HXg');

    expect(dto).toEqual({
      contentSid: 'HXg',
      friendlyName: 'g',
      language: 'es',
      variables: ['1'],
      approvalStatus: 'approved',
      category: 'UTILITY',
      sendable: true,
      body: 'Hola {{1}}',
    });
  });

  it('sid inexistente → TemplateNotFoundError', async () => {
    const gw = new InMemoryTemplateMessagingGateway();

    await expect(new GetTemplate(gw).execute('HXnope')).rejects.toBeInstanceOf(TemplateNotFoundError);
  });
});

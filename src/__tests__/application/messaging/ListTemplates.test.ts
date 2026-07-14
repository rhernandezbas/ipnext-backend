/**
 * messaging-bulk (F2, T3.4) — ListTemplates (TPL-1/TPL-2). Delega en
 * TemplateMessagingPort.listTemplates(), NUNCA filtra (devuelve TODOS, mixed
 * approved/pending/rejected) — marca `sendable` per-template. Fake port
 * mínimo inline (no se reusa InMemoryTemplateMessagingGateway porque ese fake
 * no soporta "listTemplates lanza" — T3.3, patrón GetClientContextByPhone.test.ts).
 */
import { ListTemplates } from '@application/use-cases/messaging/ListTemplates';
import { TemplateProviderUnavailableError } from '@domain/errors/messaging-bulk';
import type { TemplateMessagingPort, TemplateDto } from '@domain/ports/TemplateMessagingPort';

function makeTemplatePort(templates: TemplateDto[]): TemplateMessagingPort {
  return {
    listTemplates: jest.fn().mockResolvedValue(templates),
    sendTemplate: jest.fn(),
  };
}

function makeTemplate(overrides: Partial<TemplateDto> = {}): TemplateDto {
  return {
    contentSid: 'HXdefault',
    friendlyName: 'default_template',
    language: 'es',
    variables: { '1': 'nombre' },
    approvalStatus: 'approved',
    ...overrides,
  };
}

describe('ListTemplates', () => {
  it('TPL-1: listado mixto approved/pending — los 3 vienen, sendable correcto por cada uno', async () => {
    const templates = [
      makeTemplate({ contentSid: 'HX1', approvalStatus: 'approved' }),
      makeTemplate({ contentSid: 'HX2', approvalStatus: 'approved' }),
      makeTemplate({ contentSid: 'HX3', approvalStatus: 'pending' }),
    ];
    const port = makeTemplatePort(templates);
    const uc = new ListTemplates(port);

    const result = await uc.execute();

    expect(result).toHaveLength(3);
    expect(result.filter((t) => t.sendable)).toHaveLength(2);
    const pendingOne = result.find((t) => t.contentSid === 'HX3');
    expect(pendingOne?.approvalStatus).toBe('pending');
    expect(pendingOne?.sendable).toBe(false);
  });

  it('TPL-1/TPL-2: template rejected → sendable false, señalizando al FE que no se puede seleccionar', async () => {
    const port = makeTemplatePort([makeTemplate({ contentSid: 'HXrej', approvalStatus: 'rejected' })]);
    const uc = new ListTemplates(port);

    const [result] = await uc.execute();

    expect(result.approvalStatus).toBe('rejected');
    expect(result.sendable).toBe(false);
  });

  it('mapea `variables` a los NOMBRES declarados (keys), nunca el objeto crudo del proveedor', async () => {
    const port = makeTemplatePort([
      makeTemplate({ variables: { '1': 'nombre', '2': 'monto_deuda' } }),
    ]);
    const uc = new ListTemplates(port);

    const [result] = await uc.execute();

    expect(result.variables.sort()).toEqual(['1', '2']);
    expect(result).not.toHaveProperty('sample');
  });

  it('el proveedor no responde (timeout/5xx) → propaga TemplateProviderUnavailableError sin colgar', async () => {
    const port: TemplateMessagingPort = {
      listTemplates: jest.fn().mockRejectedValue(new TemplateProviderUnavailableError()),
      sendTemplate: jest.fn(),
    };
    const uc = new ListTemplates(port);

    await expect(uc.execute()).rejects.toThrow(TemplateProviderUnavailableError);
  });

  it('sin templates cargados → []', async () => {
    const port = makeTemplatePort([]);
    const uc = new ListTemplates(port);

    const result = await uc.execute();

    expect(result).toEqual([]);
  });
});

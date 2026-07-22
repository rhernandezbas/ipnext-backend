/**
 * campaign-chatwoot-label (5.3, CLBL-2) — `CreateChatwootLabel`: validación
 * LOCAL barata (title no-vacío, color hex) ANTES de tocar el gateway — NO
 * re-consulta el catálogo (D5.a, distinta de la Decisión D que aplica al PICK
 * en `CreateCampaign`). Válido → delega en `chatwootGateway.createAccountLabel`.
 *
 * Nota (5.3, dato verificado del orquestador 2026-07-22 sobre Chatwoot v4.13
 * `app/models/label.rb`): `title` se downcasea automáticamente vía
 * `before_validation` + formato `UNICODE_CHARACTER_NUMBER_HYPHEN_UNDERSCORE`
 * (sin espacios) + unicidad por cuenta. Este use case pasa-through el `title`
 * TAL CUAL — NO normaliza, NO valida charset (deja que Chatwoot downcasee/
 * rechace del lado servidor); un `title` con espacios/mayúsculas llega ÍNTEGRO
 * al adapter, no es un 422 local por eso. La normalización visible es
 * responsabilidad del FE (mini-modal, tarea FE.3).
 */
import { CreateChatwootLabel } from '@application/use-cases/messaging/CreateChatwootLabel';
import { InvalidChatwootLabelError } from '@domain/errors/messaging-bulk';
import { ChatwootUnavailableError } from '@domain/errors/messaging';
import type { ChatwootGateway, ChatwootLabelDto } from '@domain/ports/ChatwootGateway';

function makeGateway(overrides: Partial<ChatwootGateway> = {}): ChatwootGateway {
  return {
    listConversations: jest.fn(),
    getConversation: jest.fn(),
    listMessages: jest.fn(),
    sendMessage: jest.fn(),
    searchContact: jest.fn(),
    registerWebhook: jest.fn(),
    setStatus: jest.fn(),
    downloadAttachment: jest.fn(),
    sendTemplateMessage: jest.fn(),
    createConversationWithTemplate: jest.fn(),
    listAccountLabels: jest.fn(),
    createAccountLabel: jest.fn().mockImplementation(
      async (params: { title: string; color: string }): Promise<ChatwootLabelDto> => ({ ...params }),
    ),
    addConversationLabels: jest.fn(),
    ...overrides,
  };
}

describe('CreateChatwootLabel', () => {
  it('CLBL-2: título+color válidos → delega en chatwootGateway.createAccountLabel y retorna el DTO', async () => {
    const gateway = makeGateway();
    const uc = new CreateChatwootLabel(gateway);

    const result = await uc.execute({ title: 'promo-julio', color: '#FF0000' });

    expect(result).toEqual({ title: 'promo-julio', color: '#FF0000' });
    expect(gateway.createAccountLabel).toHaveBeenCalledWith({ title: 'promo-julio', color: '#FF0000' });
  });

  it('title vacío → InvalidChatwootLabelError, NO llama al gateway', async () => {
    const gateway = makeGateway();
    const uc = new CreateChatwootLabel(gateway);

    await expect(uc.execute({ title: '', color: '#FF0000' })).rejects.toBeInstanceOf(InvalidChatwootLabelError);
    expect(gateway.createAccountLabel).not.toHaveBeenCalled();
  });

  it('title solo whitespace → InvalidChatwootLabelError, NO llama al gateway', async () => {
    const gateway = makeGateway();
    const uc = new CreateChatwootLabel(gateway);

    await expect(uc.execute({ title: '   ', color: '#FF0000' })).rejects.toBeInstanceOf(InvalidChatwootLabelError);
    expect(gateway.createAccountLabel).not.toHaveBeenCalled();
  });

  it('color no-hex → InvalidChatwootLabelError, NO llama al gateway', async () => {
    const gateway = makeGateway();
    const uc = new CreateChatwootLabel(gateway);

    await expect(uc.execute({ title: 'promo-julio', color: 'rojo' })).rejects.toBeInstanceOf(InvalidChatwootLabelError);
    expect(gateway.createAccountLabel).not.toHaveBeenCalled();
  });

  it('color hex de 3 dígitos (#RGB) también es válido', async () => {
    const gateway = makeGateway();
    const uc = new CreateChatwootLabel(gateway);

    const result = await uc.execute({ title: 'vip', color: '#f00' });

    expect(result).toEqual({ title: 'vip', color: '#f00' });
  });

  it('título con espacios/mayúsculas pasa-through ÍNTEGRO (NO normaliza, NO 422 local — nota 5.3)', async () => {
    const gateway = makeGateway();
    const uc = new CreateChatwootLabel(gateway);

    await uc.execute({ title: 'Promo Julio', color: '#FF0000' });

    expect(gateway.createAccountLabel).toHaveBeenCalledWith({ title: 'Promo Julio', color: '#FF0000' });
  });

  it('título rechazado por Chatwoot (duplicado) → propaga ChatwootUnavailableError sin persistir nada', async () => {
    const gateway = makeGateway({
      createAccountLabel: jest.fn().mockRejectedValue(new ChatwootUnavailableError()),
    });
    const uc = new CreateChatwootLabel(gateway);

    await expect(uc.execute({ title: 'promo-julio', color: '#FF0000' })).rejects.toBeInstanceOf(ChatwootUnavailableError);
  });
});

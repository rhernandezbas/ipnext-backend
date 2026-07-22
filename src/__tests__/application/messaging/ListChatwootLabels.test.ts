/**
 * campaign-chatwoot-label (5.2, CLBL-1, molde `ListTemplates.test.ts`) —
 * `ListChatwootLabels` delega EN EL PORT, retorna tal cual (sin filtrar/mapear).
 * Fake mínimo inline del `ChatwootGateway` (solo los métodos que este use case
 * toca) — molde `makeTemplatePort` de `ListTemplates.test.ts`.
 */
import { ListChatwootLabels } from '@application/use-cases/messaging/ListChatwootLabels';
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
    listAccountLabels: jest.fn().mockResolvedValue([]),
    createAccountLabel: jest.fn(),
    addConversationLabels: jest.fn(),
    ...overrides,
  };
}

describe('ListChatwootLabels', () => {
  it('CLBL-1: delega en chatwootGateway.listAccountLabels() y retorna el catálogo TAL CUAL', async () => {
    const labels: ChatwootLabelDto[] = [
      { title: 'promo-julio', color: '#FF0000' },
      { title: 'cobranzas', color: '#00FF00' },
    ];
    const gateway = makeGateway({ listAccountLabels: jest.fn().mockResolvedValue(labels) });
    const uc = new ListChatwootLabels(gateway);

    const result = await uc.execute();

    expect(result).toEqual(labels);
    expect(gateway.listAccountLabels).toHaveBeenCalledTimes(1);
  });

  it('catálogo vacío → []', async () => {
    const gateway = makeGateway({ listAccountLabels: jest.fn().mockResolvedValue([]) });
    const uc = new ListChatwootLabels(gateway);

    const result = await uc.execute();

    expect(result).toEqual([]);
  });

  it('el gateway falla (Chatwoot caído) → propaga ChatwootUnavailableError sin colgar', async () => {
    const gateway = makeGateway({ listAccountLabels: jest.fn().mockRejectedValue(new ChatwootUnavailableError()) });
    const uc = new ListChatwootLabels(gateway);

    await expect(uc.execute()).rejects.toThrow(ChatwootUnavailableError);
  });
});

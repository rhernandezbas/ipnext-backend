import { ChatwootAssistantConversationGateway } from '@infrastructure/adapters/assistant/ChatwootAssistantConversationGateway';
import type { ConversationRepository } from '@domain/ports/ConversationRepository';
import type { ChatwootGateway } from '@domain/ports/ChatwootGateway';
import type { AssignConversation } from '@application/use-cases/messaging/AssignConversation';
import type { SendMessage } from '@application/use-cases/messaging/SendMessage';
import type { SetConversationArea } from '@application/use-cases/messaging/SetConversationArea';
import type { SetConversationStatus } from '@application/use-cases/messaging/SetConversationStatus';

/**
 * ai-assistant-cobranzas (4.10 / D10 / ACT-4) — `unassign` desasigna en LOS DOS LADOS.
 *
 * ⚠️ El gotcha verificado que puede hundir R3: `AssignConversation` toca
 * `Conversation.assigneeId`, que es campo LOCAL del espejo — **nunca llama a Chatwoot**. Pero
 * los agentes trabajan EN Chatwoot, y la guarda SEC-6 lee `conversation.meta.assignee` del
 * payload de Chatwoot. Desasignar sólo del lado local deja al agente viéndola como suya y la
 * regla no cumple ningún fin; desasignar sólo en Chatwoot deja al inbox de Prominense con un
 * dueño fantasma. Los dos, o no cumple.
 *
 * Y los dos son BEST-EFFORT: esto corre DESPUÉS de que el mensaje ya salió (D10, orden
 * acción → labels → unassign). Un fallo acá no puede tumbar una respuesta ya enviada (RUN-1).
 */
describe('ChatwootAssistantConversationGateway.unassign (ACT-4)', () => {
  function build(over: {
    chatwootConversationId?: number | null;
    assignFails?: boolean;
    chatwootFails?: boolean;
  } = {}) {
    const localCalls: Array<[string, string | null, string | null | undefined]> = [];
    const chatwootCalls: number[] = [];

    const conversations = {
      findById: async () => ({
        id: 'conv-1',
        chatwootConversationId:
          over.chatwootConversationId === undefined ? 77 : over.chatwootConversationId,
      }),
    } as unknown as ConversationRepository;

    const assign = {
      execute: async (id: string, assigneeId: string | null, actorId?: string | null) => {
        localCalls.push([id, assigneeId, actorId]);
        if (over.assignFails) throw new Error('la base tosió');
        return {} as never;
      },
    } as unknown as AssignConversation;

    const chatwoot = {
      addConversationLabels: async () => {},
      unassignConversation: async (id: number) => {
        chatwootCalls.push(id);
        if (over.chatwootFails) throw new Error('Chatwoot caído');
      },
    } as unknown as ChatwootGateway;

    const gateway = new ChatwootAssistantConversationGateway(
      conversations,
      {} as unknown as SendMessage,
      {} as unknown as SetConversationArea,
      {} as unknown as SetConversationStatus,
      chatwoot,
      assign,
    );

    return { gateway, localCalls, chatwootCalls };
  }

  it('ACT-4 — desasigna en el espejo LOCAL y en Chatwoot', async () => {
    const { gateway, localCalls, chatwootCalls } = build();

    await gateway.unassign('conv-1');

    expect(localCalls).toEqual([['conv-1', null, null]]); // actorId null: el bot no es un usuario RBAC
    expect(chatwootCalls).toEqual([77]);
  });

  it('ACT-4 — si falla el LOCAL, igual se desasigna en Chatwoot y no lanza', async () => {
    const { gateway, chatwootCalls } = build({ assignFails: true });

    await expect(gateway.unassign('conv-1')).resolves.toBeUndefined();
    // El lado que importa para el agente humano NO puede quedar sin intentar por culpa del otro.
    expect(chatwootCalls).toEqual([77]);
  });

  it('ACT-4 — si falla CHATWOOT, el local ya se hizo y tampoco lanza', async () => {
    const { gateway, localCalls } = build({ chatwootFails: true });

    await expect(gateway.unassign('conv-1')).resolves.toBeUndefined();
    expect(localCalls).toHaveLength(1);
  });

  it('conversación aún no adoptada por Chatwoot ⇒ sólo el local, sin romper', async () => {
    const { gateway, localCalls, chatwootCalls } = build({ chatwootConversationId: null });

    await gateway.unassign('conv-1');

    expect(localCalls).toHaveLength(1);
    expect(chatwootCalls).toEqual([]);
  });
});

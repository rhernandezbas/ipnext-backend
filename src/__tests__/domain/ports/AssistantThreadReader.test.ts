/**
 * ai-assistant-cobranzas (2.2 / D4 / SEC-6) — RED: `readRecentTurns` pasa a devolver
 * `AssistantThreadMessage { role, text, generatedByAssistant }`.
 *
 * Compilation-only + shape test (molde `domain/ports/rbac-contracts.test.ts`): un stub
 * tipado como el puerto es el propio test — si la interfaz no expone
 * `AssistantThreadMessage` o `readRecentTurns` sigue devolviendo el shape viejo
 * (`AssistantThreadTurn`, sin `generatedByAssistant`), `ts-jest` no compila este archivo.
 *
 * El flag NUNCA debe llegar al prompt del modelo — eso lo garantiza el mapeo en
 * `ReplyWithAssistant.ts` (3.4/5.2), no este puerto. Acá sólo se fija el CONTRATO de lectura.
 */
import type {
  AssistantThreadReader,
  AssistantThreadMessage,
} from '../../../domain/ports/AssistantThreadReader';

function makeReader(messages: AssistantThreadMessage[]): AssistantThreadReader {
  return {
    readRecentTurns: async () => messages,
  };
}

describe('AssistantThreadReader — AssistantThreadMessage (D4)', () => {
  it('un turno de cliente no lleva generatedByAssistant implícito en true', async () => {
    const reader = makeReader([
      { role: 'customer', text: 'ya pagué y no tengo internet', generatedByAssistant: false, attachmentFilenames: [] },
    ]);

    const turns = await reader.readRecentTurns('conv-1', 10);

    expect(turns).toEqual([
      { role: 'customer', text: 'ya pagué y no tengo internet', generatedByAssistant: false, attachmentFilenames: [] },
    ]);
  });

  it('SEC-6: distingue un turno de agente HUMANO (generatedByAssistant:false) del bot', async () => {
    const reader = makeReader([
      { role: 'customer', text: '¿cuánto debo?', generatedByAssistant: false, attachmentFilenames: [] },
      { role: 'agent', text: 'ya te ayudo yo', generatedByAssistant: false, attachmentFilenames: [] },
    ]);

    const turns = await reader.readRecentTurns('conv-1', 10);

    expect(turns[1]).toMatchObject({ role: 'agent', generatedByAssistant: false });
  });

  it('un turno del propio bot lleva generatedByAssistant:true', async () => {
    const reader = makeReader([
      { role: 'agent', text: 'tu saldo es $45.000', generatedByAssistant: true, attachmentFilenames: [] },
    ]);

    const turns = await reader.readRecentTurns('conv-1', 10);

    expect(turns[0].generatedByAssistant).toBe(true);
  });

  it('2.8/DAT-4: un turno con adjunto expone attachmentFilenames', async () => {
    const reader = makeReader([
      {
        role: 'customer',
        text: 'ahí te mando el comprobante',
        generatedByAssistant: false,
        attachmentFilenames: ['comprobante_177332834792.pdf'],
      },
    ]);

    const turns = await reader.readRecentTurns('conv-1', 10);

    expect(turns[0].attachmentFilenames).toEqual(['comprobante_177332834792.pdf']);
  });

  it('2.8: un turno sin adjuntos expone attachmentFilenames vacío', async () => {
    const reader = makeReader([
      { role: 'customer', text: 'hola', generatedByAssistant: false, attachmentFilenames: [] },
    ]);

    const turns = await reader.readRecentTurns('conv-1', 10);

    expect(turns[0].attachmentFilenames).toEqual([]);
  });
});

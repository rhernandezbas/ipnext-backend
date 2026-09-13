import { fetchLastBotpressMessages, LAST_MESSAGES_LIMIT } from '@infrastructure/adapters/suricata/botpressMessages';
import type { SuricataBrowserSession } from '@infrastructure/adapters/suricata/PlaywrightSuricataScraper';

/**
 * suricata-tickets-mirror -- hallazgo en vivo 2026-09-13: el hilo real vive
 * en Botpress (`api.botpress.cloud`), alcanzable vía un PAT que
 * `backend.suricata.chat/metadata-merchant` expone (ver el disclaimer de
 * seguridad en el archivo bajo test). Estos tests fijan el CONTRATO de la
 * integración con fakes -- no pegan a la red real.
 */
function makeFakeSession(overrides: Partial<Record<string, jest.Mock>> = {}): SuricataBrowserSession {
  const fetchJson = jest.fn();
  return {
    isAuthenticated: jest.fn().mockResolvedValue(true),
    login: jest.fn().mockResolvedValue(undefined),
    fetchHtml: jest.fn().mockResolvedValue(''),
    fetchBinary: jest.fn().mockResolvedValue({ buffer: Buffer.from(''), mimeType: 'text/plain' }),
    fetchJson,
    ...overrides,
  } as unknown as SuricataBrowserSession;
}

describe('fetchLastBotpressMessages', () => {
  it('walks metadata-merchant -> metadata-ticket -> Botpress messages, maps and caps to the limit, oldest-first', async () => {
    const fetchJson = jest
      .fn()
      .mockResolvedValueOnce({ settingsAll: [{ token_pa: 'bp_pat_x', bot_id: 'bot-1' }] }) // metadata-merchant
      .mockResolvedValueOnce({ conversation_id: 'conv_1' }) // metadata-ticket
      .mockResolvedValueOnce({
        messages: [
          { id: 'm3', createdAt: '2026-09-13T02:26:06.000Z', direction: 'incoming', payload: { text: 'tercero' } },
          { id: 'm2', createdAt: '2026-09-13T02:25:00.000Z', direction: 'outgoing', payload: { text: 'segundo' } },
          { id: 'm1', createdAt: '2026-09-13T02:24:00.000Z', direction: 'incoming', payload: { text: 'primero' } },
        ],
      }); // Botpress -- newest first, como lo devuelve la API real

    const session = makeFakeSession({ fetchJson });
    const messages = await fetchLastBotpressMessages(session, 'ipnext', '18917');

    expect(fetchJson).toHaveBeenNthCalledWith(
      1,
      'https://backend.suricata.chat/metadata-merchant',
      expect.objectContaining({ method: 'POST', body: { merchant: 'ipnext' } }),
    );
    expect(fetchJson).toHaveBeenNthCalledWith(
      2,
      'https://backend.suricata.chat/metadata-ticket',
      expect.objectContaining({ method: 'POST', body: { merchant: 'ipnext', ticketId: '18917' } }),
    );
    expect(fetchJson).toHaveBeenNthCalledWith(
      3,
      'https://api.botpress.cloud/v1/chat/messages?conversationId=conv_1',
      expect.objectContaining({ headers: { Authorization: 'Bearer bp_pat_x', 'x-bot-id': 'bot-1' } }),
    );

    // reordenado a cronologico (mas viejo primero)
    expect(messages.map((m) => m.externalId)).toEqual(['m1', 'm2', 'm3']);
    expect(messages[0]).toMatchObject({ author: 'Cliente', authorKind: 'customer', body: 'primero' });
    expect(messages[1]).toMatchObject({ author: 'Agente', authorKind: 'agent', body: 'segundo' });
  });

  it('caps to LAST_MESSAGES_LIMIT even if Botpress returns more', async () => {
    const many = Array.from({ length: LAST_MESSAGES_LIMIT + 5 }, (_, i) => ({
      id: `m${i}`,
      createdAt: `2026-09-13T02:${String(i).padStart(2, '0')}:00.000Z`,
      direction: 'incoming' as const,
      payload: { text: `msg ${i}` },
    }));
    const fetchJson = jest
      .fn()
      .mockResolvedValueOnce({ settingsAll: [{ token_pa: 'bp_pat_x', bot_id: 'bot-1' }] })
      .mockResolvedValueOnce({ conversation_id: 'conv_1' })
      .mockResolvedValueOnce({ messages: many });

    const session = makeFakeSession({ fetchJson });
    const messages = await fetchLastBotpressMessages(session, 'ipnext', '1');

    expect(messages).toHaveLength(LAST_MESSAGES_LIMIT);
  });

  it('degrades to [] without throwing when the merchant has no Botpress config', async () => {
    const fetchJson = jest.fn().mockResolvedValueOnce({ settingsAll: [] });
    const session = makeFakeSession({ fetchJson });

    await expect(fetchLastBotpressMessages(session, 'ipnext', '1')).resolves.toEqual([]);
    expect(fetchJson).toHaveBeenCalledTimes(1); // never bothers with metadata-ticket/Botpress
  });

  it('degrades to [] without throwing when the ticket has no conversation_id', async () => {
    const fetchJson = jest
      .fn()
      .mockResolvedValueOnce({ settingsAll: [{ token_pa: 'bp_pat_x', bot_id: 'bot-1' }] })
      .mockResolvedValueOnce({ conversation_id: null });
    const session = makeFakeSession({ fetchJson });

    await expect(fetchLastBotpressMessages(session, 'ipnext', '1')).resolves.toEqual([]);
    expect(fetchJson).toHaveBeenCalledTimes(2); // never reaches Botpress
  });

  it('degrades to [] without throwing when any call rejects (network/HTTP error)', async () => {
    const fetchJson = jest.fn().mockRejectedValueOnce(new Error('status 500'));
    const session = makeFakeSession({ fetchJson });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(fetchLastBotpressMessages(session, 'ipnext', '1')).resolves.toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('never attaches media -- attachment URLs point at a third-party host outside the SSRF allowlist', async () => {
    const fetchJson = jest
      .fn()
      .mockResolvedValueOnce({ settingsAll: [{ token_pa: 'bp_pat_x', bot_id: 'bot-1' }] })
      .mockResolvedValueOnce({ conversation_id: 'conv_1' })
      .mockResolvedValueOnce({
        messages: [
          {
            id: 'm1',
            createdAt: '2026-09-13T02:24:00.000Z',
            direction: 'incoming',
            payload: { imageUrl: 'https://suricata-spaces.sfo3.cdn.digitaloceanspaces.com/x.jpg' },
          },
        ],
      });
    const session = makeFakeSession({ fetchJson });

    const messages = await fetchLastBotpressMessages(session, 'ipnext', '1');
    expect(messages[0]?.attachments).toEqual([]);
  });
});

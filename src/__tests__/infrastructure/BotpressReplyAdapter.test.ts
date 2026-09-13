import { BotpressReplyAdapter } from '@infrastructure/adapters/suricata/BotpressReplyAdapter';
import type { SuricataBrowserSession } from '@infrastructure/adapters/suricata/PlaywrightSuricataScraper';
import { SuricataActionNotAppliedError } from '@domain/errors/suricata';

/**
 * suricata-bot-autonomous-actions (Phase G, task G.2, design D3.b CORRECTED
 * 2026-09-13, spec EXTREPLY threat matrix) — contract tests, molde
 * `botpressMessages.test.ts` (fakes only, never the real network) AND
 * `PlaywrightBrowserSession.test.ts`'s "assert the exact call args" style.
 * No `SuricataSession`/mutex involved -- `BotpressReplyAdapter` only ever
 * calls `session.fetchJson` directly.
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

describe('BotpressReplyAdapter.getConversationId', () => {
  it('resolves externalId -> conversation_id via the SAME metadata-ticket lookup botpressMessages.ts makes', async () => {
    const fetchJson = jest.fn().mockResolvedValueOnce({ conversation_id: 'conv_42' });
    const session = makeFakeSession({ fetchJson });
    const adapter = new BotpressReplyAdapter(session, 'ipnext');

    const conversationId = await adapter.getConversationId('18923');

    expect(conversationId).toBe('conv_42');
    expect(fetchJson).toHaveBeenCalledWith(
      'https://backend.suricata.chat/metadata-ticket',
      expect.objectContaining({ method: 'POST', body: { merchant: 'ipnext', ticketId: '18923' } }),
    );
  });

  it('returns null when the ticket has no linked conversation, never throws', async () => {
    const fetchJson = jest.fn().mockResolvedValueOnce({ conversation_id: null });
    const session = makeFakeSession({ fetchJson });
    const adapter = new BotpressReplyAdapter(session, 'ipnext');

    await expect(adapter.getConversationId('18923')).resolves.toBeNull();
  });
});

describe('BotpressReplyAdapter.sendReply', () => {
  it('walks metadata-merchant then POSTs to the Botpress Chat API with the exact verified shape', async () => {
    const fetchJson = jest
      .fn()
      .mockResolvedValueOnce({ settingsAll: [{ token_pa: 'bp_pat_x', bot_id: 'bot-1' }] }) // metadata-merchant
      .mockResolvedValueOnce({ message: { id: 'msg_1', tags: { 'whatsapp:id': 'wamid.abc' } } }); // Botpress send
    const session = makeFakeSession({ fetchJson });
    const adapter = new BotpressReplyAdapter(session, 'ipnext');

    const result = await adapter.sendReply('conv_42', 'Hola, ya reactivamos tu servicio');

    expect(fetchJson).toHaveBeenNthCalledWith(
      1,
      'https://backend.suricata.chat/metadata-merchant',
      expect.objectContaining({ method: 'POST', body: { merchant: 'ipnext' } }),
    );
    expect(fetchJson).toHaveBeenNthCalledWith(2, 'https://api.botpress.cloud/v1/chat/messages', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer bp_pat_x',
        'x-bot-id': 'bot-1',
        'Content-Type': 'application/json',
      },
      body: {
        conversationId: 'conv_42',
        userId: 'user_01JY3XV69J36PGGZ01T47QK324',
        type: 'text',
        tags: {},
        payload: { text: 'Hola, ya reactivamos tu servicio' },
      },
    });
    expect(result).toEqual({ whatsappId: 'wamid.abc' });
  });

  it('Threat Matrix — the reply body reaches the JSON body verbatim, NEVER interpolated into the URL', async () => {
    const fetchJson = jest
      .fn()
      .mockResolvedValueOnce({ settingsAll: [{ token_pa: 'bp_pat_x', bot_id: 'bot-1' }] })
      .mockResolvedValueOnce({ message: { id: 'msg_1' } });
    const session = makeFakeSession({ fetchJson });
    const adapter = new BotpressReplyAdapter(session, 'ipnext');

    const hostileBody = '"] ; DROP TABLE tickets; -- ?conversationId=evil&x=1';
    await adapter.sendReply('conv_42', hostileBody);

    const [url, opts] = fetchJson.mock.calls[1] as [string, { body: { payload: { text: string } } }];
    expect(url).toBe('https://api.botpress.cloud/v1/chat/messages');
    expect(url).not.toContain(hostileBody);
    expect(opts.body.payload.text).toBe(hostileBody);
  });

  it('throws SuricataActionNotAppliedError when Botpress has no config for the merchant', async () => {
    const fetchJson = jest.fn().mockResolvedValueOnce({ settingsAll: [] });
    const session = makeFakeSession({ fetchJson });
    const adapter = new BotpressReplyAdapter(session, 'ipnext');

    await expect(adapter.sendReply('conv_42', 'hola')).rejects.toThrow(SuricataActionNotAppliedError);
    expect(fetchJson).toHaveBeenCalledTimes(1); // never reaches the Botpress API without a token
  });

  it('throws SuricataActionNotAppliedError when the response carries no message.id (malformed/unconfirmed send)', async () => {
    const fetchJson = jest
      .fn()
      .mockResolvedValueOnce({ settingsAll: [{ token_pa: 'bp_pat_x', bot_id: 'bot-1' }] })
      .mockResolvedValueOnce({});
    const session = makeFakeSession({ fetchJson });
    const adapter = new BotpressReplyAdapter(session, 'ipnext');

    await expect(adapter.sendReply('conv_42', 'hola')).rejects.toThrow(SuricataActionNotAppliedError);
  });

  it('propagates a fetchJson rejection (non-2xx/network) without swallowing it', async () => {
    const fetchJson = jest
      .fn()
      .mockResolvedValueOnce({ settingsAll: [{ token_pa: 'bp_pat_x', bot_id: 'bot-1' }] })
      .mockRejectedValueOnce(new Error('Suricata request to https://api.botpress.cloud/v1/chat/messages failed with status 400'));
    const session = makeFakeSession({ fetchJson });
    const adapter = new BotpressReplyAdapter(session, 'ipnext');

    await expect(adapter.sendReply('conv_42', 'hola')).rejects.toThrow('failed with status 400');
  });

  it('resolves tokenPa/botId FRESH on every call, never caches the PAT across sends', async () => {
    const fetchJson = jest
      .fn()
      .mockResolvedValueOnce({ settingsAll: [{ token_pa: 'bp_pat_first', bot_id: 'bot-1' }] })
      .mockResolvedValueOnce({ message: { id: 'msg_1' } })
      .mockResolvedValueOnce({ settingsAll: [{ token_pa: 'bp_pat_second', bot_id: 'bot-1' }] })
      .mockResolvedValueOnce({ message: { id: 'msg_2' } });
    const session = makeFakeSession({ fetchJson });
    const adapter = new BotpressReplyAdapter(session, 'ipnext');

    await adapter.sendReply('conv_42', 'primero');
    await adapter.sendReply('conv_42', 'segundo');

    expect(fetchJson).toHaveBeenNthCalledWith(
      2,
      'https://api.botpress.cloud/v1/chat/messages',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer bp_pat_first' }) }),
    );
    expect(fetchJson).toHaveBeenNthCalledWith(
      4,
      'https://api.botpress.cloud/v1/chat/messages',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer bp_pat_second' }) }),
    );
  });
});

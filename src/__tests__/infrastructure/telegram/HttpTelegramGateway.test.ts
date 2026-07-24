import { AxiosInstance } from 'axios';
import { HttpTelegramGateway } from '@infrastructure/adapters/telegram/TelegramGateway';

/** Fake AxiosInstance — same injectable-`http` pattern as TwilioContentGateway.test.ts, no real HTTP. */
function fakeHttp(postImpl: (url: string, body: unknown, opts?: unknown) => Promise<{ data: unknown }>): AxiosInstance {
  return { post: jest.fn(postImpl) } as unknown as AxiosInstance;
}

describe('HttpTelegramGateway (real adapter, axios inyectable — sin red)', () => {
  it('sendMessage() postea a .../sendMessage con chat_id/text/reply_markup y mapea la Message resultante', async () => {
    const http = fakeHttp(async (url) => {
      expect(url).toBe('https://api.telegram.org/bot123:ABC/sendMessage');
      return { data: { ok: true, result: { message_id: 555, chat: { id: 42 } } } };
    });
    const gateway = new HttpTelegramGateway({ botToken: '123:ABC', http });

    const result = await gateway.sendMessage('42', 'hola', [{ text: '✋ Lo tomo', callback_data: 'ack:alert-1' }]);

    expect(result).toEqual({ chatId: '42', messageId: '555' });
    expect(http.post).toHaveBeenCalledWith(
      'https://api.telegram.org/bot123:ABC/sendMessage',
      expect.objectContaining({
        chat_id: '42',
        text: 'hola',
        reply_markup: { inline_keyboard: [[{ text: '✋ Lo tomo', callback_data: 'ack:alert-1' }]] },
      }),
      expect.anything(),
    );
  });

  it('editMessageText() postea a .../editMessageText con chat_id/message_id numérico', async () => {
    const http = fakeHttp(async () => ({ data: { ok: true, result: { message_id: 555, chat: { id: 42 } } } }));
    const gateway = new HttpTelegramGateway({ botToken: '123:ABC', http });

    await gateway.editMessageText('42', '555', 'editado');

    expect(http.post).toHaveBeenCalledWith(
      'https://api.telegram.org/bot123:ABC/editMessageText',
      expect.objectContaining({ chat_id: '42', message_id: 555, text: 'editado' }),
      expect.anything(),
    );
  });

  it('answerCallbackQuery() postea a .../answerCallbackQuery con el callback_query_id', async () => {
    const http = fakeHttp(async () => ({ data: { ok: true, result: true } }));
    const gateway = new HttpTelegramGateway({ botToken: '123:ABC', http });

    await gateway.answerCallbackQuery('cbq-1', 'Tomado');

    expect(http.post).toHaveBeenCalledWith(
      'https://api.telegram.org/bot123:ABC/answerCallbackQuery',
      { callback_query_id: 'cbq-1', text: 'Tomado' },
      expect.anything(),
    );
  });

  it('sendMessage() sin result en la respuesta → tira (propagado, best-effort lo maneja TelegramBotGateway arriba)', async () => {
    const http = fakeHttp(async () => ({ data: { ok: false, description: 'Unauthorized' } }));
    const gateway = new HttpTelegramGateway({ botToken: 'bad-token', http });

    await expect(gateway.sendMessage('42', 'hola')).rejects.toThrow(/Unauthorized/);
  });
});

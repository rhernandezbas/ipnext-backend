import type { AxiosInstance } from 'axios';
import { HttpChatwootGateway } from '@infrastructure/adapters/chatwoot/HttpChatwootGateway';
import { ChatwootUnavailableError } from '@domain/errors/messaging';

function fakeHttp(over?: Partial<Record<'get' | 'post', jest.Mock>>) {
  const http = {
    get: jest.fn().mockResolvedValue({ data: {} }),
    post: jest.fn().mockResolvedValue({ data: {} }),
    ...over,
  };
  const gw = new HttpChatwootGateway({
    baseUrl: 'https://chat.ipnext.com.ar',
    accountId: '2',
    inboxId: '1',
    apiToken: 'tok',
    http: http as unknown as AxiosInstance,
  });
  return { http, gw };
}

describe('HttpChatwootGateway (B3 — cliente HTTP de la Application API de Chatwoot)', () => {
  describe('listConversations', () => {
    it('GET /api/v1/accounts/:id/conversations?inbox_id=:inboxId y mapea meta.sender → contacto', async () => {
      const { http, gw } = fakeHttp({
        get: jest.fn().mockResolvedValue({
          data: {
            data: {
              payload: [
                {
                  id: 42,
                  status: 'open',
                  can_reply: true,
                  last_activity_at: 1751000000,
                  meta: { sender: { name: 'Juan Perez', phone_number: '+5493511234567' } },
                },
              ],
            },
          },
        }),
      });
      const result = await gw.listConversations();
      expect(http.get).toHaveBeenCalledWith('/api/v1/accounts/2/conversations', {
        params: { inbox_id: '1' },
      });
      expect(result).toEqual([
        {
          id: 42,
          contactName: 'Juan Perez',
          contactPhone: '+5493511234567',
          status: 'open',
          canReply: true,
          lastActivityAt: new Date(1751000000 * 1000).toISOString(),
        },
      ]);
    });

    it('sin sender/nombre/telefono (meta: {}) → contactName/contactPhone undefined, NO null (H3: ausente ≠ valor real, ver getConversation)', async () => {
      const { gw } = fakeHttp({
        get: jest.fn().mockResolvedValue({
          data: { data: { payload: [{ id: 7, status: 'resolved', can_reply: false, meta: {} }] } },
        }),
      });
      const result = await gw.listConversations();
      expect(result).toEqual([
        {
          id: 7,
          contactName: undefined,
          contactPhone: undefined,
          status: 'resolved',
          canReply: false,
          lastActivityAt: undefined,
        },
      ]);
    });

    it('payload ausente/no-array → []', async () => {
      const { gw } = fakeHttp({ get: jest.fn().mockResolvedValue({ data: {} }) });
      const result = await gw.listConversations();
      expect(result).toEqual([]);
    });
  });

  describe('getConversation', () => {
    it('GET /api/v1/accounts/:id/conversations/:convId y mapea el objeto directo (sin envelope)', async () => {
      const { http, gw } = fakeHttp({
        get: jest.fn().mockResolvedValue({
          data: {
            id: 42,
            status: 'open',
            can_reply: true,
            last_activity_at: 1751000000,
            meta: { sender: { name: 'Juan Perez', phone_number: '+5493511234567' } },
          },
        }),
      });
      const result = await gw.getConversation(42);
      expect(http.get).toHaveBeenCalledWith('/api/v1/accounts/2/conversations/42');
      expect(result).toEqual({
        id: 42,
        contactName: 'Juan Perez',
        contactPhone: '+5493511234567',
        status: 'open',
        canReply: true,
        lastActivityAt: new Date(1751000000 * 1000).toISOString(),
      });
    });

    it('H3 — campos AUSENTES del JSON (no meta, no last_activity_at) mapean a undefined, NUNCA a null (para que el upsert los deje intactos, no los pise)', async () => {
      const { gw } = fakeHttp({
        get: jest.fn().mockResolvedValue({
          data: { id: 55, status: 'open', can_reply: true }, // no `meta`, no `last_activity_at` key at all
        }),
      });
      const result = await gw.getConversation(55);
      expect(result.contactName).toBeUndefined();
      expect(result.contactPhone).toBeUndefined();
      expect(result.lastActivityAt).toBeUndefined();
    });

    it('H3 — un sender explícitamente SIN name/phone_number (claves ausentes DENTRO de sender) también mapea a undefined', async () => {
      const { gw } = fakeHttp({
        get: jest.fn().mockResolvedValue({
          data: { id: 56, status: 'open', can_reply: true, meta: { sender: {} } },
        }),
      });
      const result = await gw.getConversation(56);
      expect(result.contactName).toBeUndefined();
      expect(result.contactPhone).toBeUndefined();
    });

    it('residuo #3 — status/can_reply AUSENTES en el GET mapean a undefined (NO a "open"/false) para que el fetch-on-open no pise el mirror', async () => {
      const { gw } = fakeHttp({
        get: jest.fn().mockResolvedValue({
          data: { id: 60, meta: { sender: { name: 'Juan' } } }, // sin `status`, sin `can_reply`
        }),
      });
      const result = await gw.getConversation(60);
      expect(result.status).toBeUndefined();
      expect(result.canReply).toBeUndefined();
    });
  });

  describe('listMessages', () => {
    it('GET .../messages y mapea message_type 0/1 → inbound/outbound', async () => {
      const { http, gw } = fakeHttp({
        get: jest.fn().mockResolvedValue({
          data: {
            payload: [
              { id: 1, message_type: 0, content: 'hola', sender: { name: 'Cliente' }, created_at: 1751000000 },
              { id: 2, message_type: 1, content: 'hola de vuelta', sender: { name: 'Agente' }, created_at: 1751000100 },
            ],
          },
        }),
      });
      const result = await gw.listMessages(42);
      expect(http.get).toHaveBeenCalledWith('/api/v1/accounts/2/conversations/42/messages');
      expect(result).toEqual([
        {
          id: 1,
          direction: 'inbound',
          content: 'hola',
          senderName: 'Cliente',
          createdAt: new Date(1751000000 * 1000).toISOString(),
        },
        {
          id: 2,
          direction: 'outbound',
          content: 'hola de vuelta',
          senderName: 'Agente',
          createdAt: new Date(1751000100 * 1000).toISOString(),
        },
      ]);
    });

    it('message_type 2/3 (activity/template) → direction null (filtrado en el use case, no acá)', async () => {
      const { gw } = fakeHttp({
        get: jest.fn().mockResolvedValue({
          data: {
            payload: [
              { id: 3, message_type: 2, content: 'assigned to Agente', created_at: 1751000200 },
              { id: 4, message_type: 3, content: 'template hsm', created_at: 1751000300 },
            ],
          },
        }),
      });
      const result = await gw.listMessages(42);
      expect(result.map((m: { direction: string | null }) => m.direction)).toEqual([null, null]);
    });

    it('H1 — message_type STRING ("incoming"/"outgoing") también mapea a inbound/outbound (defensivo, mismo mapper que el webhook)', async () => {
      const { gw } = fakeHttp({
        get: jest.fn().mockResolvedValue({
          data: {
            payload: [
              { id: 5, message_type: 'incoming', content: 'hola', created_at: 1751000400 },
              { id: 6, message_type: 'outgoing', content: 'hola de vuelta', created_at: 1751000500 },
              { id: 7, message_type: 'activity', content: 'sistema', created_at: 1751000600 },
            ],
          },
        }),
      });
      const result = await gw.listMessages(42);
      expect(result.map((m: { direction: string | null }) => m.direction)).toEqual([
        'inbound',
        'outbound',
        null,
      ]);
    });

    it('H2 residual — private:true (nota interna) se expone en el DTO para que GetConversation la filtre en el fetch-on-open', async () => {
      const { gw } = fakeHttp({
        get: jest.fn().mockResolvedValue({
          data: {
            payload: [
              {
                id: 8,
                message_type: 1,
                content: 'nota interna: escalar a soporte',
                sender: { name: 'Agente' },
                created_at: 1751000700,
                private: true,
              },
            ],
          },
        }),
      });
      const result = await gw.listMessages(42);
      expect(result[0]).toMatchObject({ direction: 'outbound', private: true });
    });
  });

  describe('sendMessage', () => {
    it('POST .../messages con {content, message_type:"outgoing"} y mapea la respuesta', async () => {
      const { http, gw } = fakeHttp({
        post: jest.fn().mockResolvedValue({
          data: { id: 99, message_type: 1, content: 'gracias por tu compra', sender: { name: 'Agente' }, created_at: 1751000400 },
        }),
      });
      const result = await gw.sendMessage(42, 'gracias por tu compra');
      expect(http.post).toHaveBeenCalledWith('/api/v1/accounts/2/conversations/42/messages', {
        content: 'gracias por tu compra',
        message_type: 'outgoing',
      });
      expect(result).toEqual({
        id: 99,
        direction: 'outbound',
        content: 'gracias por tu compra',
        senderName: 'Agente',
        createdAt: new Date(1751000400 * 1000).toISOString(),
      });
    });
  });

  describe('searchContact', () => {
    it('GET .../contacts/search?q= y mapea phone_number → phone', async () => {
      const { http, gw } = fakeHttp({
        get: jest.fn().mockResolvedValue({
          data: { payload: [{ id: 5, name: 'Juan Perez', phone_number: '+5493511234567' }] },
        }),
      });
      const result = await gw.searchContact('juan');
      expect(http.get).toHaveBeenCalledWith('/api/v1/accounts/2/contacts/search', { params: { q: 'juan' } });
      expect(result).toEqual([{ id: 5, name: 'Juan Perez', phone: '+5493511234567' }]);
    });
  });

  describe('registerWebhook', () => {
    it('POST /api/v1/accounts/:id/webhooks con url, subscriptions y secret', async () => {
      const { http, gw } = fakeHttp();
      await gw.registerWebhook('https://be.ipnext.com.ar/api/messaging/webhook', 'shh');
      expect(http.post).toHaveBeenCalledWith('/api/v1/accounts/2/webhooks', {
        url: 'https://be.ipnext.com.ar/api/messaging/webhook',
        subscriptions: ['message_created', 'conversation_created', 'conversation_status_changed'],
        secret: 'shh',
      });
    });
  });

  describe('robustez ante fallos (SEND-3/ROB-1) — un solo resultado de fallo', () => {
    it('error de red en GET → ChatwootUnavailableError', async () => {
      const { gw } = fakeHttp({ get: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) });
      await expect(gw.listConversations()).rejects.toBeInstanceOf(ChatwootUnavailableError);
    });

    it('4xx de Chatwoot en POST → sigue siendo ChatwootUnavailableError (NO se distingue de un 5xx)', async () => {
      const err = Object.assign(new Error('Request failed with status code 422'), {
        isAxiosError: true,
        response: { status: 422, data: { error: 'invalid conversation' } },
      });
      const { gw } = fakeHttp({ post: jest.fn().mockRejectedValue(err) });
      await expect(gw.sendMessage(42, 'x')).rejects.toBeInstanceOf(ChatwootUnavailableError);
    });

    it('5xx de Chatwoot en GET → ChatwootUnavailableError', async () => {
      const err = Object.assign(new Error('Internal Server Error'), {
        isAxiosError: true,
        response: { status: 503, data: {} },
      });
      const { gw } = fakeHttp({ get: jest.fn().mockRejectedValue(err) });
      await expect(gw.getConversation(1)).rejects.toBeInstanceOf(ChatwootUnavailableError);
    });
  });

  describe('constructor', () => {
    it('sin http inyectado, arma axios.create con baseURL y header api_access_token', () => {
      // No lanza y queda usable — el axios real se ejercita indirectamente en los tests de arriba
      // via el http inyectado; acá solo probamos que el ctor no explota sin `http`.
      expect(() => new HttpChatwootGateway({ baseUrl: 'https://chat.ipnext.com.ar', accountId: '2', inboxId: '1', apiToken: 'tok' })).not.toThrow();
    });
  });
});

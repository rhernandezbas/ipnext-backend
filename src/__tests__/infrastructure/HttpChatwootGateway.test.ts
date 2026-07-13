import axios, { AxiosInstance } from 'axios';
import FormData from 'form-data';
import { HttpChatwootGateway } from '@infrastructure/adapters/chatwoot/HttpChatwootGateway';
import { ChatwootUnavailableError } from '@domain/errors/messaging';

// fix-be #1 (HIGH) — only the "hardening de memoria/timeout" describe block below
// exercises the REAL (non-injected) `rawGet`, which falls through to a bare
// `axios.get`. Every other test in this file injects its own `http`/`rawGet` fake
// and never touches the real axios module, so mocking it here is safe.
jest.mock('axios');

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

    describe('messaging-inbox-notes (F1.5 fase D, NOTE-4) — options.private', () => {
      it('options.private:true → el POST JSON incluye private:true', async () => {
        const { http, gw } = fakeHttp({
          post: jest.fn().mockResolvedValue({
            data: { id: 100, message_type: 1, content: 'nota interna', created_at: 1751000401 },
          }),
        });

        await gw.sendMessage(42, 'nota interna', undefined, { private: true });

        expect(http.post).toHaveBeenCalledWith('/api/v1/accounts/2/conversations/42/messages', {
          content: 'nota interna',
          message_type: 'outgoing',
          private: true,
        });
      });

      it('options ausente/private:false → el POST JSON NO incluye el campo private (compat, cero regresión)', async () => {
        const { http, gw } = fakeHttp({
          post: jest.fn().mockResolvedValue({
            data: { id: 101, message_type: 1, content: 'hola', created_at: 1751000402 },
          }),
        });

        await gw.sendMessage(42, 'hola', undefined, { private: false });

        expect(http.post).toHaveBeenCalledWith('/api/v1/accounts/2/conversations/42/messages', {
          content: 'hola',
          message_type: 'outgoing',
        });
      });
    });
  });

  describe('sendMessage — multipart (messaging-inbox-v2-media, Tanda 2 · SEND-4)', () => {
    it('BE1.1 — files=[] también usa el camino JSON, no multipart (SEND-4 scenario 2, cero regresión)', async () => {
      const { http, gw } = fakeHttp({
        post: jest.fn().mockResolvedValue({
          data: { id: 1, message_type: 1, content: 'x', created_at: 1751000000 },
        }),
      });
      await gw.sendMessage(42, 'x', []);
      expect(http.post).toHaveBeenCalledWith('/api/v1/accounts/2/conversations/42/messages', {
        content: 'x',
        message_type: 'outgoing',
      });
    });

    it('BE1.2/BE1.3 — con 2 files → POST multipart con attachments[]×2 + content + message_type, timeout/maxBodyLength seteados, y la respuesta mapea attachments[].id/sourceUrl (SEND-4 scenarios 1/3)', async () => {
      const { http, gw } = fakeHttp({
        post: jest.fn().mockResolvedValue({
          data: {
            id: 100,
            message_type: 1,
            content: 'mirá esto',
            created_at: 1751000500,
            attachments: [
              { id: 501, file_type: 'image', content_type: 'image/jpeg', data_url: 'https://chat.ipnext.com.ar/x/501.jpg', file_size: 111 },
              { id: 502, file_type: 'file', content_type: 'application/pdf', data_url: 'https://chat.ipnext.com.ar/x/502.pdf', file_size: 222 },
            ],
          },
        }),
      });
      const files = [
        { buffer: Buffer.from('img-bytes'), filename: 'foto.jpg', contentType: 'image/jpeg' },
        { buffer: Buffer.from('pdf-bytes'), filename: 'factura.pdf', contentType: 'application/pdf' },
      ];

      const result = await gw.sendMessage(42, 'mirá esto', files);

      expect(http.post).toHaveBeenCalledTimes(1);
      const [url, body, config] = http.post.mock.calls[0] as [string, FormData, Record<string, unknown>];
      expect(url).toBe('/api/v1/accounts/2/conversations/42/messages');
      expect(body).toBeInstanceOf(FormData);
      expect(String((config['headers'] as Record<string, string>)['content-type'])).toContain('multipart/form-data');
      expect(config['timeout']).toBeGreaterThan(0);
      expect(config['maxBodyLength']).toBeGreaterThan(0);

      const raw = body.getBuffer().toString('utf8');
      expect((raw.match(/name="attachments\[\]"/g) ?? []).length).toBe(2);
      expect(raw).toContain('name="content"');
      expect(raw).toContain('name="message_type"');
      expect(raw).toContain('mirá esto');
      expect(raw).toContain('outgoing');

      // SEND-4 scenario 3 — la respuesta mapeada trae attachments[].id/sourceUrl.
      expect(result.attachments).toEqual([
        expect.objectContaining({ id: 501, sourceUrl: 'https://chat.ipnext.com.ar/x/501.jpg' }),
        expect.objectContaining({ id: 502, sourceUrl: 'https://chat.ipnext.com.ar/x/502.pdf' }),
      ]);
    });

    it('BE1.4 — timeout/red caída en el POST multipart → ChatwootUnavailableError, nunca cuelga (#11)', async () => {
      const { gw } = fakeHttp({ post: jest.fn().mockRejectedValue(new Error('ECONNABORTED')) });
      const files = [{ buffer: Buffer.from('x'), filename: 'a.jpg', contentType: 'image/jpeg' }];

      await expect(gw.sendMessage(42, 'x', files)).rejects.toBeInstanceOf(ChatwootUnavailableError);
    });

    it('messaging-inbox-notes (NOTE-4) — options.private:true con files → multipart incluye form.append("private","true")', async () => {
      const { http, gw } = fakeHttp({
        post: jest.fn().mockResolvedValue({
          data: { id: 102, message_type: 1, content: 'nota con archivo', created_at: 1751000600 },
        }),
      });
      const files = [{ buffer: Buffer.from('img'), filename: 'foto.jpg', contentType: 'image/jpeg' }];

      await gw.sendMessage(42, 'nota con archivo', files, { private: true });

      const [, body] = http.post.mock.calls[0] as [string, FormData];
      const raw = body.getBuffer().toString('utf8');
      expect(raw).toContain('name="private"');
      expect(raw).toContain('true');
    });

    it('messaging-inbox-notes (NOTE-4) — options ausente con files → multipart NO incluye el campo private (compat)', async () => {
      const { http, gw } = fakeHttp({
        post: jest.fn().mockResolvedValue({
          data: { id: 103, message_type: 1, content: 'con archivo normal', created_at: 1751000601 },
        }),
      });
      const files = [{ buffer: Buffer.from('img'), filename: 'foto.jpg', contentType: 'image/jpeg' }];

      await gw.sendMessage(42, 'con archivo normal', files);

      const [, body] = http.post.mock.calls[0] as [string, FormData];
      const raw = body.getBuffer().toString('utf8');
      expect(raw).not.toContain('name="private"');
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

  describe('downloadAttachment (messaging-inbox-v2-media, Tanda 1 · MEDIA-2)', () => {
    function gwWithRawGet(rawGet: jest.Mock) {
      return new HttpChatwootGateway({
        baseUrl: 'https://chat.ipnext.com.ar',
        accountId: '2',
        inboxId: '1',
        apiToken: 'tok',
        rawGet: rawGet as unknown as (url: string) => Promise<{ data: ArrayBuffer; headers: Record<string, unknown> }>,
      });
    }

    it('scenario 6/8 — sigue el sourceUrl y devuelve { buffer, contentType } desde la respuesta cruda', async () => {
      const bytes = new TextEncoder().encode('fake-jpg-bytes').buffer;
      const rawGet = jest.fn().mockResolvedValue({ data: bytes, headers: { 'content-type': 'image/jpeg' } });
      const gw = gwWithRawGet(rawGet);

      const result = await gw.downloadAttachment('https://chat.ipnext.com.ar/rails/active_storage/blobs/redirect/abc/foto.jpg');

      // fix-be #1 — `downloadAttachment` now always forwards its (optional) `options`
      // through to `rawGet`, even when the caller didn't pass any (`undefined`), so the
      // real axios-backed `rawGet` can apply its hardening defaults (see fix-be #1
      // describe block below).
      expect(rawGet).toHaveBeenCalledWith(
        'https://chat.ipnext.com.ar/rails/active_storage/blobs/redirect/abc/foto.jpg',
        undefined,
      );
      expect(result.buffer.toString()).toBe('fake-jpg-bytes');
      expect(result.contentType).toBe('image/jpeg');
    });

    it('content-type ausente en la respuesta → fallback application/octet-stream (nunca truena el mapeo)', async () => {
      const bytes = new TextEncoder().encode('x').buffer;
      const rawGet = jest.fn().mockResolvedValue({ data: bytes, headers: {} });
      const gw = gwWithRawGet(rawGet);

      const result = await gw.downloadAttachment('https://x/y');
      expect(result.contentType).toBe('application/octet-stream');
    });

    it('scenario 9 — red caída/timeout en la descarga → ChatwootUnavailableError (mismo criterio SEND-3/ROB-1)', async () => {
      const rawGet = jest.fn().mockRejectedValue(new Error('ETIMEDOUT'));
      const gw = gwWithRawGet(rawGet);

      await expect(gw.downloadAttachment('https://x/y')).rejects.toBeInstanceOf(ChatwootUnavailableError);
    });

    it('sin rawGet inyectado, el ctor no explota (usa axios.get real internamente)', () => {
      expect(() =>
        new HttpChatwootGateway({ baseUrl: 'https://chat.ipnext.com.ar', accountId: '2', inboxId: '1', apiToken: 'tok' }),
      ).not.toThrow();
    });
  });

  describe('fix-be #1 (HIGH) — hardening de memoria/timeout del rawGet REAL (sin inyección)', () => {
    afterEach(() => jest.clearAllMocks());

    function gwWithRealRawGet() {
      return new HttpChatwootGateway({ baseUrl: 'https://chat.ipnext.com.ar', accountId: '2', inboxId: '1', apiToken: 'tok' });
    }

    it('fija maxContentLength/maxBodyLength = options.maxBytes y un timeout — axios NUNCA bufferea sin cota', async () => {
      const bytes = new TextEncoder().encode('x').buffer;
      (axios.get as jest.Mock).mockResolvedValue({ data: bytes, headers: {} });
      const gw = gwWithRealRawGet();

      await gw.downloadAttachment('https://x/y', { maxBytes: 5 * 1024 * 1024 });

      expect(axios.get).toHaveBeenCalledWith(
        'https://x/y',
        expect.objectContaining({
          responseType: 'arraybuffer',
          maxContentLength: 5 * 1024 * 1024,
          maxBodyLength: 5 * 1024 * 1024,
          timeout: expect.any(Number),
        }),
      );
    });

    it('sin options (maxBytes ausente) igual fija un default FINITO — nunca Infinity/sin cota', async () => {
      const bytes = new TextEncoder().encode('x').buffer;
      (axios.get as jest.Mock).mockResolvedValue({ data: bytes, headers: {} });
      const gw = gwWithRealRawGet();

      await gw.downloadAttachment('https://x/y');

      const callOptions = (axios.get as jest.Mock).mock.calls[0][1];
      expect(Number.isFinite(callOptions.maxContentLength)).toBe(true);
      expect(callOptions.maxContentLength).toBeGreaterThan(0);
      expect(Number.isFinite(callOptions.maxBodyLength)).toBe(true);
      expect(callOptions.timeout).toBeGreaterThan(0);
    });

    it('axios abortando a mitad de stream (maxContentLength excedido) → ChatwootUnavailableError, nunca un buffer parcial ni un throw crudo', async () => {
      (axios.get as jest.Mock).mockRejectedValue(
        Object.assign(new Error('maxContentLength size of 5242880 exceeded'), {
          code: 'ERR_FR_MAX_CONTENT_LENGTH_EXCEEDED',
        }),
      );
      const gw = gwWithRealRawGet();

      await expect(gw.downloadAttachment('https://x/y', { maxBytes: 5 * 1024 * 1024 })).rejects.toBeInstanceOf(
        ChatwootUnavailableError,
      );
    });

    it('timeout de un data_url que nunca responde → ChatwootUnavailableError (no deja la promesa colgada)', async () => {
      (axios.get as jest.Mock).mockRejectedValue(Object.assign(new Error('timeout of 30000ms exceeded'), { code: 'ECONNABORTED' }));
      const gw = gwWithRealRawGet();

      await expect(gw.downloadAttachment('https://x/y', { maxBytes: 100 * 1024 * 1024 })).rejects.toBeInstanceOf(
        ChatwootUnavailableError,
      );
    });
  });
});

/**
 * messaging-bulk (F2, T5.1-T5.3, design §2.2) — `TwilioContentGateway`. Patrón
 * axios de `HttpChatwootGateway`/`GestionRealClient` (`http` inyectable, NO
 * axios/nock real en tests — un stub mínimo `{get: jest.fn(), post: jest.fn()}`).
 *
 * DOS hosts distintos (`content.twilio.com` para templates, `api.twilio.com`
 * para el envío) — por eso el ctor toma `contentBaseUrl`/`apiBaseUrl`
 * inyectables en vez de un solo `axios.create({baseURL})`.
 */
import { TwilioContentGateway } from '@infrastructure/adapters/twilio/TwilioContentGateway';
import {
  TemplateProviderUnavailableError,
  TemplateSendRejectedError,
  TemplateProviderConfigError,
} from '@domain/errors/messaging-bulk';

function axiosErr(
  status?: number,
  opts: { headers?: Record<string, string>; code?: string; data?: unknown } = {},
) {
  return {
    isAxiosError: true,
    message: status ? `Request failed with status code ${status}` : 'network error',
    code: opts.code,
    response: status === undefined ? undefined : { status, headers: opts.headers ?? {}, data: opts.data },
  };
}

function makeGateway(overrides: { get?: jest.Mock; post?: jest.Mock } = {}) {
  const get = overrides.get ?? jest.fn();
  const post = overrides.post ?? jest.fn();
  const gateway = new TwilioContentGateway({
    accountSid: 'ACtest',
    authToken: 'secret',
    messagingServiceSid: 'MGtest',
    http: { get, post } as never,
  });
  return { gateway, get, post };
}

const CONTENT_PAGE_1 = {
  data: {
    contents: [
      {
        sid: 'HXapproved',
        friendly_name: 'recordatorio_deuda',
        language: 'es',
        variables: { '1': 'nombre' },
        approval_requests: { status: 'approved', category: 'UTILITY' },
      },
      {
        sid: 'HXpending',
        friendly_name: 'promo_nueva',
        language: 'es',
        variables: {},
        approval_requests: { status: 'pending' },
      },
    ],
    meta: { next_page_url: null },
  },
};

describe('TwilioContentGateway — listTemplates', () => {
  it('1 página → mapea contentSid/friendlyName/language/variables/approvalStatus/category', async () => {
    const { gateway, get } = makeGateway({ get: jest.fn().mockResolvedValueOnce(CONTENT_PAGE_1) });

    const templates = await gateway.listTemplates();

    expect(templates).toEqual([
      { contentSid: 'HXapproved', friendlyName: 'recordatorio_deuda', language: 'es', variables: { '1': 'nombre' }, approvalStatus: 'approved', category: 'UTILITY' },
      { contentSid: 'HXpending', friendlyName: 'promo_nueva', language: 'es', variables: {}, approvalStatus: 'pending', category: undefined },
    ]);
    expect(get).toHaveBeenCalledTimes(1);
    const [url, config] = get.mock.calls[0];
    expect(url).toContain('content.twilio.com/v1/ContentAndApprovals');
    expect(url).toContain('PageSize=200');
    expect((config as { auth: { username: string; password: string } }).auth).toEqual({ username: 'ACtest', password: 'secret' });
  });

  it('2 páginas (next_page_url no-null luego null) → concatena todo', async () => {
    const page1 = {
      data: {
        contents: [{ sid: 'HX1', friendly_name: 'a', language: 'es', variables: {}, approval_requests: { status: 'approved' } }],
        meta: { next_page_url: 'https://content.twilio.com/v1/ContentAndApprovals?PageSize=200&PageToken=abc' },
      },
    };
    const page2 = {
      data: {
        contents: [{ sid: 'HX2', friendly_name: 'b', language: 'es', variables: {}, approval_requests: { status: 'rejected' } }],
        meta: { next_page_url: null },
      },
    };
    const get = jest.fn().mockResolvedValueOnce(page1).mockResolvedValueOnce(page2);
    const { gateway } = makeGateway({ get });

    const templates = await gateway.listTemplates();

    expect(templates.map((t) => t.contentSid)).toEqual(['HX1', 'HX2']);
    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls[1][0]).toBe('https://content.twilio.com/v1/ContentAndApprovals?PageSize=200&PageToken=abc');
  });

  it('401 (credencial mala) → TemplateProviderUnavailableError', async () => {
    const { gateway } = makeGateway({ get: jest.fn().mockRejectedValueOnce(axiosErr(401)) });

    await expect(gateway.listTemplates()).rejects.toBeInstanceOf(TemplateProviderUnavailableError);
  });

  it('sin templates → lista vacía', async () => {
    const { gateway } = makeGateway({ get: jest.fn().mockResolvedValueOnce({ data: { contents: [], meta: { next_page_url: null } } }) });

    await expect(gateway.listTemplates()).resolves.toEqual([]);
  });
});

describe('TwilioContentGateway — sendTemplate', () => {
  it('200 → {providerId, status}, POST form-urlencoded con los params correctos', async () => {
    const post = jest.fn().mockResolvedValueOnce({ data: { sid: 'SM123', status: 'queued' } });
    const { gateway } = makeGateway({ post });

    const result = await gateway.sendTemplate('+5493364123456', 'HXapproved', { '1': 'Juan' });

    expect(result).toEqual({ providerId: 'SM123', status: 'queued' });
    expect(post).toHaveBeenCalledTimes(1);
    const [url, body, config] = post.mock.calls[0];
    expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages.json');
    expect(body).toContain('MessagingServiceSid=MGtest');
    expect(body).toContain('To=whatsapp%3A%2B5493364123456');
    expect(body).toContain('ContentSid=HXapproved');
    expect(decodeURIComponent(body as string)).toContain('ContentVariables={"1":"Juan"}');
    expect((config as { headers: Record<string, string> }).headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect((config as { auth: { username: string; password: string } }).auth).toEqual({ username: 'ACtest', password: 'secret' });
  });

  it('429 con header Retry-After → TemplateProviderUnavailableError con retryAfterMs correcto', async () => {
    const post = jest.fn().mockRejectedValueOnce(axiosErr(429, { headers: { 'retry-after': '2' } }));
    const { gateway } = makeGateway({ post });

    let caught: unknown;
    try {
      await gateway.sendTemplate('+5493364123456', 'HXapproved', {});
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(TemplateProviderUnavailableError);
    expect((caught as TemplateProviderUnavailableError).retryAfterMs).toBe(2000);
  });

  it('500/502/503/504 → TemplateProviderUnavailableError (retryable, sin retryAfterMs)', async () => {
    for (const status of [500, 502, 503, 504]) {
      const post = jest.fn().mockRejectedValueOnce(axiosErr(status));
      const { gateway } = makeGateway({ post });
      await expect(gateway.sendTemplate('+549', 'HX1', {})).rejects.toBeInstanceOf(TemplateProviderUnavailableError);
    }
  });

  it('400 → TemplateSendRejectedError (terminal per-mensaje, NO retryable)', async () => {
    const post = jest.fn().mockRejectedValueOnce(axiosErr(400));
    const { gateway } = makeGateway({ post });

    await expect(gateway.sendTemplate('+549', 'HX1', {})).rejects.toBeInstanceOf(TemplateSendRejectedError);
  });

  // ── FIX-2: 401/403/404 son SISTÉMICOS (config/auth), no per-mensaje ─────────
  it('FIX-2: 401/403/404 → TemplateProviderConfigError (sistémico), NUNCA TemplateSendRejectedError', async () => {
    for (const status of [401, 403, 404]) {
      const post = jest.fn().mockRejectedValueOnce(axiosErr(status));
      const { gateway } = makeGateway({ post });
      const err = await gateway.sendTemplate('+549', 'HX1', {}).catch((e) => e);
      expect(err).toBeInstanceOf(TemplateProviderConfigError);
      expect(err).not.toBeInstanceOf(TemplateSendRejectedError);
    }
  });

  it('FIX-2: accountSid vacío → TemplateProviderConfigError ANTES de tocar el proveedor (guard proactivo)', async () => {
    const post = jest.fn();
    const gateway = new TwilioContentGateway({
      accountSid: '', // sin config (opt-in ausente) — la URL sería /Accounts//Messages.json
      authToken: 'secret',
      messagingServiceSid: 'MGtest',
      http: { get: jest.fn(), post } as never,
    });

    await expect(gateway.sendTemplate('+5493364123456', 'HXapproved', {})).rejects.toBeInstanceOf(
      TemplateProviderConfigError,
    );
    expect(post).not.toHaveBeenCalled(); // no se disparó ninguna request
  });

  // ── FIX-7a: el `code` de Twilio viaja en el error para diagnóstico ─────────
  it('FIX-7a: el error incluye el `code` numérico de Twilio (ej. 21211) para diagnóstico, sin PII', async () => {
    const post = jest.fn().mockRejectedValueOnce(
      axiosErr(400, { data: { code: 21211, message: "The 'To' number is not a valid phone number." } }),
    );
    const { gateway } = makeGateway({ post });

    const err = (await gateway.sendTemplate('+549', 'HX1', {}).catch((e) => e)) as Error;

    expect(err).toBeInstanceOf(TemplateSendRejectedError);
    expect(err.message).toContain('21211');
    // HIST-3 — nunca el message crudo del proveedor (podría traer el número) ni credenciales.
    expect(err.message).not.toContain('not a valid phone number');
    expect(err.message).not.toMatch(/authToken|secret/i);
  });

  it('timeout/ECONNABORTED (sin response) → TemplateProviderUnavailableError', async () => {
    const post = jest.fn().mockRejectedValueOnce(axiosErr(undefined, { code: 'ECONNABORTED' }));
    const { gateway } = makeGateway({ post });

    await expect(gateway.sendTemplate('+549', 'HX1', {})).rejects.toBeInstanceOf(TemplateProviderUnavailableError);
  });

  it('HIST-3 — el error saneado nunca incluye el objeto crudo de la respuesta', async () => {
    const post = jest.fn().mockRejectedValueOnce(axiosErr(400));
    const { gateway } = makeGateway({ post });

    let caught: unknown;
    try {
      await gateway.sendTemplate('+549', 'HX1', {});
    } catch (err) {
      caught = err;
    }

    const message = (caught as Error).message;
    expect(message).not.toContain('headers');
    expect(message).not.toMatch(/authToken|secret/i);
  });
});

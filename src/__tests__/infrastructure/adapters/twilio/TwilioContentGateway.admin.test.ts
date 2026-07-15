/**
 * Change 3 (templates CRUD, T2) — los 4 métodos admin del `TwilioContentGateway`
 * (create/get/delete/submit) contra la Content API, con el `http` inyectable
 * (stub `{get,post,delete}` — NO axios/nock real, regla TDD del repo).
 *
 * DIFERENCIA clave con el send-path: la Content API de CRUD es **JSON** (no
 * form-urlencoded) y un **404** significa "template inexistente" →
 * `TemplateNotFoundError` (404), NO `TemplateProviderConfigError` (que en el
 * send-path mapea 404 a config sistémica). El resto del criterio (429/5xx/red →
 * unavailable; 401/403 → config; otros 4xx → rejected) se mantiene.
 */
import { TwilioContentGateway } from '@infrastructure/adapters/twilio/TwilioContentGateway';
import {
  TemplateNotFoundError,
  TemplateProviderUnavailableError,
  TemplateProviderConfigError,
  TemplateSendRejectedError,
} from '@domain/errors/messaging-bulk';

function axiosErr(status?: number, opts: { headers?: Record<string, string>; code?: string; data?: unknown } = {}) {
  return {
    isAxiosError: true,
    message: status ? `Request failed with status code ${status}` : 'network error',
    code: opts.code,
    response: status === undefined ? undefined : { status, headers: opts.headers ?? {}, data: opts.data },
  };
}

function makeGateway(overrides: { get?: jest.Mock; post?: jest.Mock; delete?: jest.Mock } = {}) {
  const get = overrides.get ?? jest.fn();
  const post = overrides.post ?? jest.fn();
  const del = overrides.delete ?? jest.fn();
  const gateway = new TwilioContentGateway({
    accountSid: 'ACtest',
    authToken: 'secret',
    messagingServiceSid: 'MGtest',
    http: { get, post, delete: del } as never,
  });
  return { gateway, get, post, del };
}

describe('TwilioContentGateway — createTemplate (T2)', () => {
  it('POST /v1/Content JSON con friendly_name/language/variables/types + Basic auth; mapea a DTO curado', async () => {
    const post = jest.fn().mockResolvedValueOnce({
      data: { sid: 'HXnew', friendly_name: 'promo', language: 'es', variables: { '1': '1' }, types: { 'twilio/text': { body: 'Hola {{1}}' } } },
    });
    const { gateway } = makeGateway({ post });

    const dto = await gateway.createTemplate({ friendlyName: 'promo', language: 'es', variables: { '1': '1' }, body: 'Hola {{1}}' });

    expect(dto).toEqual({
      contentSid: 'HXnew',
      friendlyName: 'promo',
      language: 'es',
      variables: { '1': '1' },
      approvalStatus: 'unsubmitted',
      category: undefined,
      body: 'Hola {{1}}',
    });
    const [url, body, config] = post.mock.calls[0];
    expect(url).toBe('https://content.twilio.com/v1/Content');
    expect(body).toEqual({ friendly_name: 'promo', language: 'es', variables: { '1': '1' }, types: { 'twilio/text': { body: 'Hola {{1}}' } } });
    expect((config as { headers: Record<string, string> }).headers['Content-Type']).toBe('application/json');
    expect((config as { auth: { username: string; password: string } }).auth).toEqual({ username: 'ACtest', password: 'secret' });
  });

  it('400 → TemplateSendRejectedError (payload rechazado por el proveedor)', async () => {
    const post = jest.fn().mockRejectedValueOnce(axiosErr(400));
    const { gateway } = makeGateway({ post });

    await expect(gateway.createTemplate({ friendlyName: 'x', language: 'es', variables: {}, body: 'b' })).rejects.toBeInstanceOf(TemplateSendRejectedError);
  });

  it('503 → TemplateProviderUnavailableError (retryable)', async () => {
    const post = jest.fn().mockRejectedValueOnce(axiosErr(503));
    const { gateway } = makeGateway({ post });

    await expect(gateway.createTemplate({ friendlyName: 'x', language: 'es', variables: {}, body: 'b' })).rejects.toBeInstanceOf(TemplateProviderUnavailableError);
  });
});

describe('TwilioContentGateway — getTemplate (T2)', () => {
  it('GET /v1/Content/:sid → DTO; Basic auth', async () => {
    const get = jest.fn().mockResolvedValueOnce({ data: { sid: 'HXg', friendly_name: 'g', language: 'es', variables: {}, types: {} } });
    const { gateway } = makeGateway({ get });

    const dto = await gateway.getTemplate('HXg');

    expect(dto.contentSid).toBe('HXg');
    expect(dto.approvalStatus).toBe('unsubmitted');
    const [url, config] = get.mock.calls[0];
    expect(url).toBe('https://content.twilio.com/v1/Content/HXg');
    expect((config as { auth: { username: string; password: string } }).auth).toEqual({ username: 'ACtest', password: 'secret' });
  });

  it('404 → TemplateNotFoundError (NO ConfigError — diferencia con el send-path)', async () => {
    const get = jest.fn().mockRejectedValueOnce(axiosErr(404));
    const { gateway } = makeGateway({ get });

    const err = await gateway.getTemplate('HXmissing').catch((e) => e);
    expect(err).toBeInstanceOf(TemplateNotFoundError);
    expect(err).not.toBeInstanceOf(TemplateProviderConfigError);
  });

  it('401/403 → TemplateProviderConfigError', async () => {
    for (const s of [401, 403]) {
      const get = jest.fn().mockRejectedValueOnce(axiosErr(s));
      const { gateway } = makeGateway({ get });
      await expect(gateway.getTemplate('HX')).rejects.toBeInstanceOf(TemplateProviderConfigError);
    }
  });

  it('timeout/red (sin response) → TemplateProviderUnavailableError', async () => {
    const get = jest.fn().mockRejectedValueOnce(axiosErr(undefined, { code: 'ECONNABORTED' }));
    const { gateway } = makeGateway({ get });

    await expect(gateway.getTemplate('HX')).rejects.toBeInstanceOf(TemplateProviderUnavailableError);
  });
});

describe('TwilioContentGateway — deleteTemplate (T2)', () => {
  it('DELETE /v1/Content/:sid?deleteInWaba=true + Basic auth', async () => {
    const del = jest.fn().mockResolvedValueOnce({ data: {} });
    const { gateway } = makeGateway({ delete: del });

    await gateway.deleteTemplate('HXd', true);

    const [url, config] = del.mock.calls[0];
    expect(url).toBe('https://content.twilio.com/v1/Content/HXd?deleteInWaba=true');
    expect((config as { auth: { username: string; password: string } }).auth).toEqual({ username: 'ACtest', password: 'secret' });
  });

  it('deleteInWaba omitido → default false', async () => {
    const del = jest.fn().mockResolvedValueOnce({ data: {} });
    const { gateway } = makeGateway({ delete: del });

    await gateway.deleteTemplate('HXd');

    expect(del.mock.calls[0][0]).toBe('https://content.twilio.com/v1/Content/HXd?deleteInWaba=false');
  });

  it('404 → TemplateNotFoundError', async () => {
    const del = jest.fn().mockRejectedValueOnce(axiosErr(404));
    const { gateway } = makeGateway({ delete: del });

    await expect(gateway.deleteTemplate('HXmissing', true)).rejects.toBeInstanceOf(TemplateNotFoundError);
  });
});

describe('TwilioContentGateway — submitForApproval (T2)', () => {
  it('POST /v1/Content/:sid/ApprovalRequests/whatsapp {name, category} JSON + Basic auth', async () => {
    const post = jest.fn().mockResolvedValueOnce({ data: {} });
    const { gateway } = makeGateway({ post });

    await gateway.submitForApproval('HXs', 'promo_julio', 'MARKETING');

    const [url, body, config] = post.mock.calls[0];
    expect(url).toBe('https://content.twilio.com/v1/Content/HXs/ApprovalRequests/whatsapp');
    expect(body).toEqual({ name: 'promo_julio', category: 'MARKETING' });
    expect((config as { headers: Record<string, string> }).headers['Content-Type']).toBe('application/json');
    expect((config as { auth: { username: string; password: string } }).auth).toEqual({ username: 'ACtest', password: 'secret' });
  });

  it('429 → TemplateProviderUnavailableError con retryAfterMs', async () => {
    const post = jest.fn().mockRejectedValueOnce(axiosErr(429, { headers: { 'retry-after': '3' } }));
    const { gateway } = makeGateway({ post });

    const err = (await gateway.submitForApproval('HXs', 'n', 'UTILITY').catch((e) => e)) as TemplateProviderUnavailableError;
    expect(err).toBeInstanceOf(TemplateProviderUnavailableError);
    expect(err.retryAfterMs).toBe(3000);
  });
});

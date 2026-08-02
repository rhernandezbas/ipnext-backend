/**
 * portal-push-notifications — `FcmPushSender`. Patrón axios de
 * `TwilioContentGateway.test.ts` (`http` inyectable, stub mínimo
 * `{post: jest.fn()}`, sin axios/nock real). El JWT del intercambio OAuth2 se
 * firma DE VERDAD (RS256, `jsonwebtoken`) contra un par de claves generado en
 * el test — solo el POST http del canje/envío está mockeado.
 */
import { generateKeyPairSync } from 'crypto';
import { FcmPushSender } from '@infrastructure/adapters/fcm/FcmPushSender';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const SERVICE_ACCOUNT_JSON = JSON.stringify({
  project_id: 'ipnextapp',
  client_email: 'fcm-sender@ipnextapp.iam.gserviceaccount.com',
  private_key: privateKey,
});

function tokenResponse(accessToken = 'fake-access-token', expiresIn = 3600) {
  return { data: { access_token: accessToken, expires_in: expiresIn, token_type: 'Bearer' } };
}

function fcmError(status: number, errorCode: string) {
  return {
    isAxiosError: true,
    message: `Request failed with status code ${status}`,
    response: {
      status,
      data: { error: { code: status, message: 'x', status: errorCode, details: [{ errorCode }] } },
    },
  };
}

function makeSender(overrides: { post?: jest.Mock; now?: () => number } = {}) {
  const post = overrides.post ?? jest.fn();
  const sender = new FcmPushSender({
    serviceAccountJson: SERVICE_ACCOUNT_JSON,
    http: { post } as never,
    ...(overrides.now ? { now: overrides.now } : {}),
  });
  return { sender, post };
}

describe('FcmPushSender — construcción', () => {
  it('rechaza un JSON malformado', () => {
    expect(() => new FcmPushSender({ serviceAccountJson: '{not json' })).toThrow();
  });

  it('rechaza un service account incompleto (falta private_key)', () => {
    const bad = JSON.stringify({ project_id: 'x', client_email: 'x@x.com' });
    expect(() => new FcmPushSender({ serviceAccountJson: bad })).toThrow();
  });

  it('dryRun es false (a diferencia de NoopPushSender)', () => {
    const { sender } = makeSender();
    expect(sender.dryRun).toBe(false);
  });
});

describe('FcmPushSender — send', () => {
  it('sin tokens no llama al proveedor', async () => {
    const { sender, post } = makeSender();
    const result = await sender.send([], { title: 't', body: 'b' });
    expect(result).toEqual({ invalidTokens: [] });
    expect(post).not.toHaveBeenCalled();
  });

  it('un POST por token contra messages:send del proyecto correcto, con Bearer + Authorization', async () => {
    const post = jest
      .fn()
      .mockResolvedValueOnce(tokenResponse()) // canje OAuth2
      .mockResolvedValueOnce({ data: { name: 'projects/ipnextapp/messages/1' } })
      .mockResolvedValueOnce({ data: { name: 'projects/ipnextapp/messages/2' } });
    const { sender } = makeSender({ post });

    const result = await sender.send(['tok-1', 'tok-2'], { title: 'Corte', body: 'Volvemos a las 15' });

    expect(result).toEqual({ invalidTokens: [] });
    expect(post).toHaveBeenCalledTimes(3);
    const [tokenCallUrl] = post.mock.calls[0] as [string];
    expect(tokenCallUrl).toBe('https://oauth2.googleapis.com/token');
    const [sendUrl, sendBody, sendOpts] = post.mock.calls[1] as [string, unknown, { headers: Record<string, string> }];
    expect(sendUrl).toBe('https://fcm.googleapis.com/v1/projects/ipnextapp/messages:send');
    expect(sendBody).toEqual({ message: { token: 'tok-1', notification: { title: 'Corte', body: 'Volvemos a las 15' } } });
    expect(sendOpts.headers['Authorization']).toBe('Bearer fake-access-token');
  });

  it('caso obligatorio 7 (unit del adapter) — UNREGISTERED e INVALID_ARGUMENT van a invalidTokens, otros errores NO', async () => {
    const post = jest
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockRejectedValueOnce(fcmError(404, 'UNREGISTERED'))
      .mockRejectedValueOnce(fcmError(400, 'INVALID_ARGUMENT'))
      .mockRejectedValueOnce(fcmError(429, 'QUOTA_EXCEEDED'))
      .mockResolvedValueOnce({ data: { name: 'ok' } });
    const { sender } = makeSender({ post });

    const result = await sender.send(['tok-dead-1', 'tok-dead-2', 'tok-quota', 'tok-ok'], { title: 't', body: 'b' });

    expect(result.invalidTokens.sort()).toEqual(['tok-dead-1', 'tok-dead-2']);
  });

  it('cachea el access_token entre dos send() (un solo canje OAuth2)', async () => {
    let callCount = 0;
    const post = jest.fn().mockImplementation((url: string) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        callCount += 1;
        return Promise.resolve(tokenResponse());
      }
      return Promise.resolve({ data: { name: 'ok' } });
    });
    const { sender } = makeSender({ post });

    await sender.send(['tok-1'], { title: 't', body: 'b' });
    await sender.send(['tok-2'], { title: 't', body: 'b' });

    expect(callCount).toBe(1);
  });

  it('re-canjea el token una vez vencido (fuera del margen de seguridad)', async () => {
    let nowMs = 1_000_000;
    let callCount = 0;
    const post = jest.fn().mockImplementation((url: string) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        callCount += 1;
        return Promise.resolve(tokenResponse('token-' + callCount, 3600));
      }
      return Promise.resolve({ data: { name: 'ok' } });
    });
    const { sender } = makeSender({ post, now: () => nowMs });

    await sender.send(['tok-1'], { title: 't', body: 'b' });
    nowMs += 3600 * 1000; // avanza más allá del TTL + margen de seguridad
    await sender.send(['tok-2'], { title: 't', body: 'b' });

    expect(callCount).toBe(2);
  });
});

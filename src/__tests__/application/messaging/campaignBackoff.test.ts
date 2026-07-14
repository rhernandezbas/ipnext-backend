/**
 * messaging-bulk (F2, T4.2, design §5.2, SEND-3) — `campaignBackoffMs`/
 * `sendWithRetry`. Clon del RAZONAMIENTO de `GestionRealClient.backoffMs`/
 * `postWithRetry` (exponencial base·3^i + jitter, respeta Retry-After, cap
 * maxBackoffMs) adaptado al error TIPADO del port (`TemplateProviderUnavailableError`)
 * en vez de un AxiosError crudo — el mapeo axios→error tipado lo hace el
 * adapter (`TwilioContentGateway`, Batch 5).
 */
import { sendWithRetry, campaignBackoffMs } from '@application/use-cases/messaging/campaignBackoff';
import { TemplateProviderUnavailableError, TemplateSendRejectedError } from '@domain/errors/messaging-bulk';

describe('sendWithRetry', () => {
  it('SEND-3: éxito al primer intento no reintenta ni duerme', async () => {
    const sleep = jest.fn().mockResolvedValue(undefined);
    const send = jest.fn().mockResolvedValue({ providerId: 'SM1', status: 'queued' });

    const result = await sendWithRetry(send, { sleep, random: () => 0 });

    expect(result).toEqual({ providerId: 'SM1', status: 'queued' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('SEND-3: falla transitoria (503) y luego éxito — reintentos transparentes al resultado final', async () => {
    const sleep = jest.fn().mockResolvedValue(undefined);
    const send = jest
      .fn()
      .mockRejectedValueOnce(new TemplateProviderUnavailableError('503'))
      .mockRejectedValueOnce(new TemplateProviderUnavailableError('503'))
      .mockResolvedValueOnce({ providerId: 'SM1', status: 'queued' });

    const result = await sendWithRetry(send, { sleep, random: () => 0, maxRetries: 3 });

    expect(result).toEqual({ providerId: 'SM1', status: 'queued' });
    expect(send).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('SEND-3: falla persistente agota los reintentos configurados y re-lanza el error del último intento', async () => {
    const sleep = jest.fn().mockResolvedValue(undefined);
    const err500 = new TemplateProviderUnavailableError('500 persistente');
    const send = jest.fn().mockRejectedValue(err500);

    await expect(sendWithRetry(send, { sleep, random: () => 0, maxRetries: 2 })).rejects.toBe(err500);

    expect(send).toHaveBeenCalledTimes(3); // 1 intento inicial + 2 reintentos
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('SEND-3: error NO-retryable (TemplateSendRejectedError) falla en el PRIMER intento sin agotar reintentos', async () => {
    const sleep = jest.fn().mockResolvedValue(undefined);
    const rejected = new TemplateSendRejectedError('400 content_sid inválido');
    const send = jest.fn().mockRejectedValue(rejected);

    await expect(sendWithRetry(send, { sleep, random: () => 0, maxRetries: 3 })).rejects.toBe(rejected);

    expect(send).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('SEND-3: error no-tipado (bug, no es del port) se re-lanza sin reintentar', async () => {
    const sleep = jest.fn().mockResolvedValue(undefined);
    const bug = new Error('unexpected boom');
    const send = jest.fn().mockRejectedValue(bug);

    await expect(sendWithRetry(send, { sleep, random: () => 0 })).rejects.toBe(bug);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('respeta Retry-After (retryAfterMs del error) cuando es mayor al backoff exponencial', async () => {
    const sleep = jest.fn().mockResolvedValue(undefined);
    const send = jest
      .fn()
      .mockRejectedValueOnce(new TemplateProviderUnavailableError('429', 2000))
      .mockResolvedValueOnce({ providerId: 'SM1', status: 'queued' });

    await sendWithRetry(send, { sleep, random: () => 0, retryBaseMs: 300 });

    expect(sleep.mock.calls[0][0]).toBeGreaterThanOrEqual(2000);
  });

  it('cap a maxBackoffMs con un retryAfterMs hostil (evita congelar el worker horas)', async () => {
    const sleep = jest.fn().mockResolvedValue(undefined);
    const send = jest
      .fn()
      .mockRejectedValueOnce(new TemplateProviderUnavailableError('429', 3_600_000)) // 1h
      .mockResolvedValueOnce({ providerId: 'SM1', status: 'queued' });

    await sendWithRetry(send, { sleep, random: () => 0, maxBackoffMs: 30_000 });

    expect(sleep.mock.calls[0][0]).toBe(30_000);
  });
});

describe('campaignBackoffMs', () => {
  it('exponencial base·3^i sin jitter (random=0)', () => {
    const opts = { retryBaseMs: 300, maxBackoffMs: 30_000, random: () => 0 };
    expect(campaignBackoffMs(0, undefined, opts)).toBe(300);
    expect(campaignBackoffMs(1, undefined, opts)).toBe(900);
    expect(campaignBackoffMs(2, undefined, opts)).toBe(2700);
  });

  it('jitter acotado en [base, 2*base)', () => {
    const opts = { retryBaseMs: 300, maxBackoffMs: 30_000, random: () => 0.999 };
    const delay = campaignBackoffMs(0, undefined, opts);
    expect(delay).toBeGreaterThanOrEqual(300);
    expect(delay).toBeLessThan(600);
  });

  it('un random no-finito no rompe el delay (nunca NaN/negativo)', () => {
    const opts = { retryBaseMs: 300, maxBackoffMs: 30_000, random: () => NaN };
    const delay = campaignBackoffMs(0, undefined, opts);
    expect(Number.isFinite(delay)).toBe(true);
    expect(delay).toBeGreaterThanOrEqual(0);
  });
});

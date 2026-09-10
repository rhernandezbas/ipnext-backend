/**
 * messaging-bulk (F2, T3.2) — fake TemplateMessagingPort. Array de TemplateDto
 * inyectable + sendTemplate que registra llamadas. Modo "falla el N-ésimo con
 * 429" (TemplateProviderUnavailableError) y "rechaza el número X"
 * (TemplateSendRejectedError). NO se mockea axios — se inyecta el fake port
 * (regla TDD del repo).
 */
import { InMemoryTemplateMessagingGateway } from '@infrastructure/adapters/in-memory/InMemoryTemplateMessagingGateway';
import { TemplateProviderUnavailableError, TemplateSendRejectedError } from '@domain/errors/messaging-bulk';
import type { TemplateDto } from '@domain/ports/TemplateMessagingPort';

const APPROVED_TEMPLATE: TemplateDto = {
  contentSid: 'HXapproved',
  friendlyName: 'recordatorio_deuda',
  language: 'es',
  variables: { '1': 'nombre', '2': 'monto_deuda' },
  approvalStatus: 'approved',
  category: 'UTILITY',
  body: 'Hola {{1}}, tenés un saldo pendiente de {{2}}',
};

describe('InMemoryTemplateMessagingGateway', () => {
  it('listTemplates devuelve el array inyectado en el ctor', async () => {
    const gateway = new InMemoryTemplateMessagingGateway({ templates: [APPROVED_TEMPLATE] });

    const templates = await gateway.listTemplates();

    expect(templates).toEqual([APPROVED_TEMPLATE]);
  });

  it('modo normal: sendTemplate registra la llamada y devuelve un providerId fake en queued', async () => {
    const gateway = new InMemoryTemplateMessagingGateway();

    const result = await gateway.sendTemplate('+5493364111111', 'HXapproved', { '1': 'Juan' });

    expect(result.status).toBe('queued');
    expect(result.providerId).toMatch(/^SMfake/);
    expect(gateway.calls).toEqual([
      { to: '+5493364111111', contentSid: 'HXapproved', variables: { '1': 'Juan' } },
    ]);
  });

  it('modo "falla el N-ésimo con 429": solo el envío N-ésimo lanza TemplateProviderUnavailableError', async () => {
    const gateway = new InMemoryTemplateMessagingGateway({ failNthWith429: 2, retryAfterMs: 5000 });

    // 1er envío: OK
    await expect(gateway.sendTemplate('+549111', 'HXapproved', {})).resolves.toMatchObject({ status: 'queued' });
    // 2do envío (el N-ésimo configurado): 429
    await expect(gateway.sendTemplate('+549222', 'HXapproved', {})).rejects.toThrow(
      TemplateProviderUnavailableError,
    );
    // 3er envío: OK de nuevo (solo el N-ésimo EXACTO falla, no todos los siguientes)
    await expect(gateway.sendTemplate('+549333', 'HXapproved', {})).resolves.toMatchObject({ status: 'queued' });
    expect(gateway.calls).toHaveLength(3);
  });

  it('el error del N-ésimo intento lleva el retryAfterMs configurado', async () => {
    const gateway = new InMemoryTemplateMessagingGateway({ failNthWith429: 1, retryAfterMs: 7000 });

    let caught: unknown;
    try {
      await gateway.sendTemplate('+549111', 'HXapproved', {});
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(TemplateProviderUnavailableError);
    expect((caught as TemplateProviderUnavailableError).retryAfterMs).toBe(7000);
  });

  it('modo "rechaza el número X": lanza TemplateSendRejectedError SOLO para ese número', async () => {
    const gateway = new InMemoryTemplateMessagingGateway({ rejectPhone: '+549bad' });

    await expect(gateway.sendTemplate('+549bad', 'HXapproved', {})).rejects.toThrow(TemplateSendRejectedError);
    await expect(gateway.sendTemplate('+549good', 'HXapproved', {})).resolves.toMatchObject({ status: 'queued' });
  });

  // ── whatsapp-invoice-detail-quickreply — mirror del branch quickReply del adapter real ──
  describe('createTemplate — button tagged union (mirror del branch real)', () => {
    it('button type:"quickReply" → registra la llamada con el shape RAW, sin url', async () => {
      const gateway = new InMemoryTemplateMessagingGateway();

      await gateway.createTemplate({
        friendlyName: 'ver_facturas',
        language: 'es',
        variables: {},
        body: 'Hola',
        button: { type: 'quickReply', title: 'Ver mis facturas' },
      });

      expect(gateway.createCalls[0].button).toEqual({ type: 'quickReply', title: 'Ver mis facturas' });
    });

    it('button type:"url" → registra la llamada con title/url (regresión, shape existente)', async () => {
      const gateway = new InMemoryTemplateMessagingGateway();

      await gateway.createTemplate({
        friendlyName: 'recordatorio',
        language: 'es',
        variables: {},
        body: 'Hola',
        button: { type: 'url', title: 'Ver más', url: 'https://portal.ipnext.com.ar/facturas' },
      });

      expect(gateway.createCalls[0].button).toEqual({
        type: 'url',
        title: 'Ver más',
        url: 'https://portal.ipnext.com.ar/facturas',
      });
    });
  });
});

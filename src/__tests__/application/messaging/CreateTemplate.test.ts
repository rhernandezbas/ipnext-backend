/**
 * Change 3 (templates CRUD, T3) — CreateTemplate. Valida entrada (friendlyName/
 * language/body no vacíos, category ∈ enum si viene), mapea `variables[]` →
 * Record índice→sample para el proveedor, y devuelve un DTO CURADO (nunca el
 * JSON crudo de Twilio). Se testea con el fake in-memory del port (NO se mockea
 * axios/Prisma).
 */
import { CreateTemplate } from '@application/use-cases/messaging/CreateTemplate';
import { InvalidTemplateInputError } from '@domain/errors/messaging-bulk';
import { InMemoryTemplateMessagingGateway } from '@infrastructure/adapters/in-memory/InMemoryTemplateMessagingGateway';

describe('CreateTemplate (T3)', () => {
  it('input válido → llama al port con el shape correcto y devuelve DTO curado (sin leak)', async () => {
    const gw = new InMemoryTemplateMessagingGateway();
    const uc = new CreateTemplate(gw);

    const dto = await uc.execute({ friendlyName: 'promo_julio', language: 'es', category: 'MARKETING', body: 'Hola {{1}}', variables: ['1'] });

    expect(dto.contentSid).toMatch(/^HX/);
    expect(dto.friendlyName).toBe('promo_julio');
    expect(dto.approvalStatus).toBe('unsubmitted');
    expect(dto.sendable).toBe(false);
    expect(dto.variables).toEqual(['1']);
    // El port recibió el shape de proveedor (variables como Record índice→sample).
    expect(gw.createCalls[0]).toEqual({ friendlyName: 'promo_julio', language: 'es', variables: { '1': '1' }, body: 'Hola {{1}}' });
    // Sin leak del crudo de Twilio.
    expect(dto).not.toHaveProperty('types');
    expect(dto).not.toHaveProperty('sid');
  });

  it('body vacío/whitespace → InvalidTemplateInputError (NO llama al port)', async () => {
    const gw = new InMemoryTemplateMessagingGateway();
    const uc = new CreateTemplate(gw);

    await expect(uc.execute({ friendlyName: 'x', language: 'es', body: '   ', variables: [] })).rejects.toBeInstanceOf(InvalidTemplateInputError);
    expect(gw.createCalls).toHaveLength(0);
  });

  it('category fuera de enum → InvalidTemplateInputError', async () => {
    const gw = new InMemoryTemplateMessagingGateway();
    const uc = new CreateTemplate(gw);

    await expect(uc.execute({ friendlyName: 'x', language: 'es', category: 'PROMO', body: 'b', variables: [] })).rejects.toBeInstanceOf(InvalidTemplateInputError);
    expect(gw.createCalls).toHaveLength(0);
  });

  it('friendlyName vacío → InvalidTemplateInputError', async () => {
    const gw = new InMemoryTemplateMessagingGateway();
    const uc = new CreateTemplate(gw);

    await expect(uc.execute({ friendlyName: '  ', language: 'es', body: 'b', variables: [] })).rejects.toBeInstanceOf(InvalidTemplateInputError);
  });

  it('language vacío → InvalidTemplateInputError', async () => {
    const gw = new InMemoryTemplateMessagingGateway();
    const uc = new CreateTemplate(gw);

    await expect(uc.execute({ friendlyName: 'x', language: '', body: 'b', variables: [] })).rejects.toBeInstanceOf(InvalidTemplateInputError);
  });

  it('sin variables → Record vacío al port (create sin variables es válido)', async () => {
    const gw = new InMemoryTemplateMessagingGateway();
    const uc = new CreateTemplate(gw);

    const dto = await uc.execute({ friendlyName: 'x', language: 'es', body: 'sin vars' });

    expect(gw.createCalls[0]).toMatchObject({ variables: {} });
    expect(dto.variables).toEqual([]);
  });

  // ── whatsapp-template-buttons — botón CTA opcional (design §2/#2, #3) ──────
  describe('button (CTA opcional)', () => {
    it('botón válido → llega al port RAW (createCalls[0].button)', async () => {
      const gw = new InMemoryTemplateMessagingGateway();
      const uc = new CreateTemplate(gw);

      const dto = await uc.execute({
        friendlyName: 'recordatorio_deuda',
        language: 'es',
        body: 'Hola {{1}}, mirá tu factura',
        button: { title: 'Ver mis facturas', url: 'https://portal.ipnext.com.ar/facturas' },
      });

      expect(gw.createCalls[0].button).toEqual({ type: 'url', title: 'Ver mis facturas', url: 'https://portal.ipnext.com.ar/facturas' });
      expect(dto.contentSid).toMatch(/^HX/);
    });

    it('sin botón → createCalls[0].button es undefined (regresión, no se inventa nada)', async () => {
      const gw = new InMemoryTemplateMessagingGateway();
      const uc = new CreateTemplate(gw);

      await uc.execute({ friendlyName: 'promo', language: 'es', body: 'Hola' });

      expect(gw.createCalls[0].button).toBeUndefined();
    });

    it('title whitespace-only → InvalidTemplateInputError, NO llama al port', async () => {
      const gw = new InMemoryTemplateMessagingGateway();
      const uc = new CreateTemplate(gw);

      await expect(
        uc.execute({ friendlyName: 'x', language: 'es', body: 'b', button: { title: '   ', url: 'https://example.com' } }),
      ).rejects.toBeInstanceOf(InvalidTemplateInputError);
      expect(gw.createCalls).toHaveLength(0);
    });

    it('title > 25 chars → InvalidTemplateInputError', async () => {
      const gw = new InMemoryTemplateMessagingGateway();
      const uc = new CreateTemplate(gw);

      const longTitle = 'a'.repeat(26);
      await expect(
        uc.execute({ friendlyName: 'x', language: 'es', body: 'b', button: { title: longTitle, url: 'https://example.com' } }),
      ).rejects.toBeInstanceOf(InvalidTemplateInputError);
      expect(gw.createCalls).toHaveLength(0);
    });

    it('url relativa (no absoluta) → InvalidTemplateInputError', async () => {
      const gw = new InMemoryTemplateMessagingGateway();
      const uc = new CreateTemplate(gw);

      await expect(
        uc.execute({ friendlyName: 'x', language: 'es', body: 'b', button: { title: 'Ver más', url: '/facturas' } }),
      ).rejects.toBeInstanceOf(InvalidTemplateInputError);
      expect(gw.createCalls).toHaveLength(0);
    });

    it('url con protocolo ftp:// → InvalidTemplateInputError (solo http/https)', async () => {
      const gw = new InMemoryTemplateMessagingGateway();
      const uc = new CreateTemplate(gw);

      await expect(
        uc.execute({ friendlyName: 'x', language: 'es', body: 'b', button: { title: 'Ver más', url: 'ftp://example.com/x' } }),
      ).rejects.toBeInstanceOf(InvalidTemplateInputError);
      expect(gw.createCalls).toHaveLength(0);
    });

    it('falta la key title → InvalidTemplateInputError', async () => {
      const gw = new InMemoryTemplateMessagingGateway();
      const uc = new CreateTemplate(gw);

      await expect(
        uc.execute({
          friendlyName: 'x',
          language: 'es',
          body: 'b',
          button: { url: 'https://example.com' } as unknown as { title: string; url: string },
        }),
      ).rejects.toBeInstanceOf(InvalidTemplateInputError);
      expect(gw.createCalls).toHaveLength(0);
    });

    it('falta la key url → InvalidTemplateInputError', async () => {
      const gw = new InMemoryTemplateMessagingGateway();
      const uc = new CreateTemplate(gw);

      await expect(
        uc.execute({
          friendlyName: 'x',
          language: 'es',
          body: 'b',
          button: { title: 'Ver más' } as unknown as { title: string; url: string },
        }),
      ).rejects.toBeInstanceOf(InvalidTemplateInputError);
      expect(gw.createCalls).toHaveLength(0);
    });

    it('GOTCHA gateway: url con placeholder {{1}} llega RAW al port, sin percent-encoding', async () => {
      const gw = new InMemoryTemplateMessagingGateway();
      const uc = new CreateTemplate(gw);

      await uc.execute({
        friendlyName: 'x',
        language: 'es',
        body: 'b',
        button: { title: 'Ver más', url: 'https://portal.ipnext.com.ar/{{1}}' },
      });

      expect((gw.createCalls[0].button as { url: string } | undefined)?.url).toBe('https://portal.ipnext.com.ar/{{1}}');
    });

    // ── fix wave (review adversarial) ────────────────────────────────────────
    it('url con whitespace alrededor → se guarda TRIMEADA (no el raw)', async () => {
      const gw = new InMemoryTemplateMessagingGateway();
      const uc = new CreateTemplate(gw);

      await uc.execute({
        friendlyName: 'x',
        language: 'es',
        body: 'b',
        button: { title: '  Ver más  ', url: '  https://portal.ipnext.com.ar/facturas  ' },
      });

      expect(gw.createCalls[0].button).toEqual({
        type: 'url',
        title: 'Ver más',
        url: 'https://portal.ipnext.com.ar/facturas',
      });
    });

    it('url con whitespace en el BORDE (newline de padding) → el valor almacenado queda limpio', async () => {
      const gw = new InMemoryTemplateMessagingGateway();
      const uc = new CreateTemplate(gw);

      await uc.execute({
        friendlyName: 'x',
        language: 'es',
        body: 'b',
        button: { title: ' \n Ver \n ', url: ' \n https://a.com/x \n ' },
      });

      expect(gw.createCalls[0].button).toEqual({ type: 'url', title: 'Ver', url: 'https://a.com/x' });
    });

    // `new URL()` BORRA en silencio el whitespace INTERIOR al parsear, así que
    // la url "válida" y la url que se almacena/envía divergen. Se rechaza.
    it.each([
      ['newline interior', 'https://a.com/x\ny'],
      ['tab interior', 'https://a.com/\tx'],
      ['espacio interior', 'https://a.com/x y'],
      ['carriage return interior', 'https://a.co\rm/x'],
    ])('url con %s → InvalidTemplateInputError, no llega al gateway', async (_label, url) => {
      const gw = new InMemoryTemplateMessagingGateway();
      const uc = new CreateTemplate(gw);

      await expect(
        uc.execute({ friendlyName: 'x', language: 'es', body: 'b', button: { title: 'Ver más', url } }),
      ).rejects.toBeInstanceOf(InvalidTemplateInputError);
      expect(gw.createCalls).toHaveLength(0);
    });

    it('button: null explícito → InvalidTemplateInputError, no TypeError', async () => {
      const gw = new InMemoryTemplateMessagingGateway();
      const uc = new CreateTemplate(gw);

      await expect(
        uc.execute({
          friendlyName: 'x',
          language: 'es',
          body: 'b',
          button: null as unknown as { title: string; url: string },
        }),
      ).rejects.toBeInstanceOf(InvalidTemplateInputError);
      expect(gw.createCalls).toHaveLength(0);
    });
  });

  // ── whatsapp-invoice-detail-quickreply (Phase 1) — tagged union `TemplateButton` ──
  describe('button tagged union (type: url | quickReply)', () => {
    it('legacy {title,url} sin type → normaliza a type:"url"', async () => {
      const gw = new InMemoryTemplateMessagingGateway();
      const uc = new CreateTemplate(gw);

      await uc.execute({
        friendlyName: 'x',
        language: 'es',
        body: 'b',
        button: { title: 'Ver mis facturas', url: 'https://portal.ipnext.com.ar/facturas' },
      });

      expect(gw.createCalls[0].button).toEqual({
        type: 'url',
        title: 'Ver mis facturas',
        url: 'https://portal.ipnext.com.ar/facturas',
      });
    });

    it('type:"quickReply" con el título exacto de la constante → aceptado, sin url', async () => {
      const gw = new InMemoryTemplateMessagingGateway();
      const uc = new CreateTemplate(gw);

      await uc.execute({
        friendlyName: 'x',
        language: 'es',
        body: 'b',
        button: { type: 'quickReply', title: 'Ver mis facturas' } as unknown as { title: string; url: string },
      });

      expect(gw.createCalls[0].button).toEqual({ type: 'quickReply', title: 'Ver mis facturas' });
    });

    it('type:"quickReply" con título distinto de la constante → InvalidTemplateInputError', async () => {
      const gw = new InMemoryTemplateMessagingGateway();
      const uc = new CreateTemplate(gw);

      await expect(
        uc.execute({
          friendlyName: 'x',
          language: 'es',
          body: 'b',
          button: { type: 'quickReply', title: 'Otro título' } as unknown as { title: string; url: string },
        }),
      ).rejects.toBeInstanceOf(InvalidTemplateInputError);
      expect(gw.createCalls).toHaveLength(0);
    });

    it('type desconocido → InvalidTemplateInputError', async () => {
      const gw = new InMemoryTemplateMessagingGateway();
      const uc = new CreateTemplate(gw);

      await expect(
        uc.execute({
          friendlyName: 'x',
          language: 'es',
          body: 'b',
          button: { type: 'carousel', title: 'x' } as unknown as { title: string; url: string },
        }),
      ).rejects.toBeInstanceOf(InvalidTemplateInputError);
      expect(gw.createCalls).toHaveLength(0);
    });
  });
});

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
});

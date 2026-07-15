/**
 * Change 3 (templates CRUD, T3) — SubmitTemplateForApproval. Valida category ∈
 * {UTILITY, MARKETING, AUTHENTICATION} y normaliza el `name` a
 * lowercase_alfanumérico antes de llamar al port. Fake in-memory (NO axios).
 */
import { SubmitTemplateForApproval, normalizeTemplateName } from '@application/use-cases/messaging/SubmitTemplateForApproval';
import { InvalidTemplateInputError } from '@domain/errors/messaging-bulk';
import { InMemoryTemplateMessagingGateway } from '@infrastructure/adapters/in-memory/InMemoryTemplateMessagingGateway';
import type { TemplateDto } from '@domain/ports/TemplateMessagingPort';

const SEED: TemplateDto = {
  contentSid: 'HXs',
  friendlyName: 's',
  language: 'es',
  variables: {},
  approvalStatus: 'unsubmitted',
  body: 'x',
};

describe('SubmitTemplateForApproval (T3)', () => {
  it('category válida + name normalizado → llama al port con el name normalizado', async () => {
    const gw = new InMemoryTemplateMessagingGateway({ templates: [SEED] });

    await new SubmitTemplateForApproval(gw).execute('HXs', { name: 'Promo Julio 2026!', category: 'MARKETING' });

    expect(gw.submitCalls).toEqual([{ contentSid: 'HXs', name: 'promo_julio_2026', category: 'MARKETING' }]);
  });

  it('category inválida → InvalidTemplateInputError (NO llama al port)', async () => {
    const gw = new InMemoryTemplateMessagingGateway({ templates: [SEED] });

    await expect(new SubmitTemplateForApproval(gw).execute('HXs', { name: 'x', category: 'PROMO' })).rejects.toBeInstanceOf(InvalidTemplateInputError);
    expect(gw.submitCalls).toHaveLength(0);
  });

  it('name que normaliza a vacío → InvalidTemplateInputError', async () => {
    const gw = new InMemoryTemplateMessagingGateway({ templates: [SEED] });

    await expect(new SubmitTemplateForApproval(gw).execute('HXs', { name: '  !!! ', category: 'UTILITY' })).rejects.toBeInstanceOf(InvalidTemplateInputError);
  });

  it('normalizeTemplateName: lowercase + alfanum + underscore, sin bordes', () => {
    expect(normalizeTemplateName('  Recordatorio DEUDA #1 ')).toBe('recordatorio_deuda_1');
    expect(normalizeTemplateName('promo_julio')).toBe('promo_julio');
  });
});

import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { InMemorySettingsRepository } from '../../infrastructure/adapters/in-memory/InMemorySettingsRepository';
import { GetSystemSettings } from '../../application/use-cases/GetSystemSettings';
import { UpdateSystemSettings } from '../../application/use-cases/UpdateSystemSettings';
import { GetEmailSettings } from '../../application/use-cases/GetEmailSettings';
import { UpdateEmailSettings } from '../../application/use-cases/UpdateEmailSettings';
import { ListTemplates } from '../../application/use-cases/ListTemplates';
import { UpdateTemplate } from '../../application/use-cases/UpdateTemplate';
import { ListApiTokens } from '../../application/use-cases/ListApiTokens';
import { CreateApiToken } from '../../application/use-cases/CreateApiToken';
import { RevokeApiToken } from '../../application/use-cases/RevokeApiToken';
import { GetFinanceSettings } from '../../application/use-cases/GetFinanceSettings';
import { UpdateFinanceSettings } from '../../application/use-cases/UpdateFinanceSettings';
import { ListPaymentMethods } from '../../application/use-cases/ListPaymentMethods';
import { CreatePaymentMethod } from '../../application/use-cases/CreatePaymentMethod';
import { UpdatePaymentMethod } from '../../application/use-cases/UpdatePaymentMethod';
import { DeletePaymentMethod } from '../../application/use-cases/DeletePaymentMethod';
import { createSettingsRouter } from '../../infrastructure/http/routes/settings.routes';

function buildApp() {
  const app = express();
  app.use(express.json());

  const repo = new InMemorySettingsRepository();
  const getSystemSettings = new GetSystemSettings(repo);
  const updateSystemSettings = new UpdateSystemSettings(repo);
  const getEmailSettings = new GetEmailSettings(repo);
  const updateEmailSettings = new UpdateEmailSettings(repo);
  const listTemplates = new ListTemplates(repo);
  const updateTemplate = new UpdateTemplate(repo);
  const listApiTokens = new ListApiTokens(repo);
  const createApiToken = new CreateApiToken(repo);
  const revokeApiToken = new RevokeApiToken(repo);
  const getFinanceSettings = new GetFinanceSettings(repo);
  const updateFinanceSettings = new UpdateFinanceSettings(repo);
  const listPaymentMethods = new ListPaymentMethods(repo);
  const createPaymentMethod = new CreatePaymentMethod(repo);
  const updatePaymentMethod = new UpdatePaymentMethod(repo);
  const deletePaymentMethod = new DeletePaymentMethod(repo);

  app.use(
    '/api/settings',
    createSettingsRouter(
      getSystemSettings,
      updateSystemSettings,
      getEmailSettings,
      updateEmailSettings,
      listTemplates,
      updateTemplate,
      listApiTokens,
      createApiToken,
      revokeApiToken,
      getFinanceSettings,
      updateFinanceSettings,
      listPaymentMethods,
      createPaymentMethod,
      updatePaymentMethod,
      deletePaymentMethod,
    ),
  );

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

describe('GET /api/settings/finance', () => {
  it('returns 200 with finance settings including taxRate 21', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/settings/finance');

    expect(res.status).toBe(200);
    expect(res.body.taxRate).toBe(21);
    expect(res.body.taxName).toBe('IVA');
    expect(res.body.currency).toBe('ARS');
  });
});

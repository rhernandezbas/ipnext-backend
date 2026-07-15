/**
 * Change 3 (templates CRUD, T2.x) — mapeo en el `errorHandler` de PRODUCCIÓN de
 * los códigos nuevos: TEMPLATE_NOT_FOUND → 404, TEMPLATE_IN_USE → 409, y
 * VALIDATION_ERROR (InvalidTemplateInputError) → 400 (ya mapeado, se re-verifica
 * para este error tipado). Se ejercita el middleware real (no se reimplementa el
 * mapeo en el test).
 */
import request from 'supertest';
import express from 'express';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import {
  TemplateNotFoundError,
  TemplateInUseByCampaignError,
  InvalidTemplateInputError,
} from '@domain/errors/messaging-bulk';

function appThrowing(err: unknown) {
  const app = express();
  app.get('/boom', (_req, _res) => {
    throw err;
  });
  app.use(errorHandler);
  return app;
}

describe('errorHandler statusMap — códigos Change 3 (templates CRUD)', () => {
  it('TEMPLATE_NOT_FOUND → 404', async () => {
    const res = await request(appThrowing(new TemplateNotFoundError('Template HXx not found'))).get('/boom');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TEMPLATE_NOT_FOUND');
  });

  it('TEMPLATE_IN_USE → 409', async () => {
    const res = await request(appThrowing(new TemplateInUseByCampaignError('HXx', ['camp-1']))).get('/boom');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TEMPLATE_IN_USE');
  });

  // Fix wave (review adversarial 🟡#2) — el diseño pedía exponer CUÁLES campañas
  // retienen el template; `campaignIds` debe viajar serializado en el body (mismo
  // patrón whitelisteado que `missing`/`missingFields`), no solo el conteo del message.
  it('TEMPLATE_IN_USE → 409 con `campaignIds` serializados en el body JSON', async () => {
    const res = await request(appThrowing(new TemplateInUseByCampaignError('HXx', ['camp-1', 'camp-2']))).get('/boom');
    expect(res.status).toBe(409);
    expect(res.body.campaignIds).toEqual(['camp-1', 'camp-2']);
  });

  it('VALIDATION_ERROR (InvalidTemplateInputError) → 400', async () => {
    const res = await request(appThrowing(new InvalidTemplateInputError('body es requerido'))).get('/boom');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});

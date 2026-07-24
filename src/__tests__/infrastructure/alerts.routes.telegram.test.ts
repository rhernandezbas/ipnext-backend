/**
 * POST /api/alerts/telegram/webhook — Fase D (`noc-alert-telegram`). Secret-token
 * auth (X-Telegram-Bot-Api-Secret-Token, NOT apiKeyMiddleware's X-API-Key/Bearer),
 * callback ack:<id> → AcknowledgeAlert, idempotencia ante doble-callback.
 * Patrón de fixture: alerts.routes.test.ts (supertest + deps in-memory).
 */
import request from 'supertest';
import express from 'express';

import { createAlertsRouter, AlertsRouterDeps } from '@infrastructure/http/routes/alerts.routes';
import { createTelegramSecretMiddleware } from '@infrastructure/http/middleware/apiKeyMiddleware';
import { IngestAlert } from '@application/use-cases/alerts/IngestAlert';
import { ListAlerts } from '@application/use-cases/alerts/ListAlerts';
import { AcknowledgeAlert } from '@application/use-cases/alerts/AcknowledgeAlert';
import { InMemoryNocAlertRepository } from '@infrastructure/adapters/in-memory/InMemoryNocAlertRepository';
import { NoOpAlertEventPublisher } from '@infrastructure/adapters/in-memory/NoOpAlertEventPublisher';
import { InMemoryFeatureFlagRepository } from '@infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { NocAlert } from '@domain/entities/nocAlert';
import type { TelegramGateway } from '@infrastructure/adapters/telegram/TelegramGateway';

// Same reasoning as alerts.routes.test.ts — apiKeyMiddleware.ts (createTelegramSecretMiddleware's
// default arg) imports @infrastructure/config at module load; mock it so the fail-fast
// validateEnv() never runs. telegramWebhookSecret included this time.
jest.mock('@infrastructure/config', () => ({
  config: {
    externalApi: { apiKey: '' },
    alerts: { grafanaIngestKey: '', fiberIngestKey: '', telegramWebhookSecret: '' },
  },
}));

const WEBHOOK_SECRET = 'telegram-webhook-secret-test';

class FakeTelegramGateway implements Pick<TelegramGateway, 'answerCallbackQuery'> {
  calls: { callbackQueryId: string; text?: string }[] = [];
  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    this.calls.push({ callbackQueryId, text });
  }
}

// F-D3 (fix wave, MEDIUM) — simula un flake de la Telegram Bot API.
class ThrowingTelegramGateway implements Pick<TelegramGateway, 'answerCallbackQuery'> {
  async answerCallbackQuery(): Promise<void> {
    throw new Error('Telegram API flake');
  }
}

function seedAlert(repo: InMemoryNocAlertRepository, overrides: Partial<NocAlert> = {}): NocAlert {
  const alert: NocAlert = {
    id: 'alert-1',
    source: 'grafana',
    fingerprint: 'fp-1',
    alertname: 'BGP peer down',
    severity: 'critical',
    status: 'firing',
    entityType: 'bgp_peer',
    entityName: 'peer-rda2',
    entityRef: null,
    metricName: null,
    metricValue: null,
    metricUnit: null,
    threshold: null,
    message: 'BGP peer down',
    explanation: null,
    link: null,
    startsAt: '2026-07-24T10:00:00.000Z',
    firstSeen: '2026-07-24T10:00:00.000Z',
    lastSeen: '2026-07-24T10:00:00.000Z',
    endsAt: null,
    createdAt: '2026-07-24T10:00:00.000Z',
    updatedAt: '2026-07-24T10:00:00.000Z',
    acknowledged: false,
    ackBy: null,
    ackAt: null,
    ackNote: null,
    escalationState: null,
    telegramChatId: null,
    telegramMessageId: null,
    ...overrides,
  };
  repo.seed(alert);
  return alert;
}

interface Fixture {
  app: express.Express;
  repo: InMemoryNocAlertRepository;
  telegramGateway: FakeTelegramGateway;
}

function buildApp(): Fixture {
  const telegramGateway = new FakeTelegramGateway();
  const { app, repo } = buildAppWithGateway(telegramGateway);
  return { app, repo, telegramGateway };
}

/** F-D3 (fix wave) — test seam to swap in a gateway that throws (Telegram flake). */
function buildAppWithGateway(
  telegramGateway: Pick<TelegramGateway, 'answerCallbackQuery'>,
): { app: express.Express; repo: InMemoryNocAlertRepository } {
  const repo = new InMemoryNocAlertRepository();
  const publisher = new NoOpAlertEventPublisher();
  const featureFlagRepo = new InMemoryFeatureFlagRepository();

  const deps: AlertsRouterDeps = {
    ingestAlert: new IngestAlert(repo, publisher),
    listAlerts: new ListAlerts(repo),
    acknowledgeAlert: new AcknowledgeAlert(repo, publisher),
    ingestKeys: {},
    featureFlagRepo,
    auth: (_req, _res, next) => next(),
    requirePerm: () => (_req, _res, next) => next(),
    telegramWebhookAuth: createTelegramSecretMiddleware(WEBHOOK_SECRET),
    telegramGateway,
  };

  const app = express();
  app.use(express.json());
  app.use('/api/alerts', createAlertsRouter(deps));
  app.use(errorHandler);

  return { app, repo };
}

function callback(alertId: string, username = 'noc_operator') {
  return {
    callback_query: {
      id: 'cbq-1',
      data: `ack:${alertId}`,
      from: { id: 123, username },
    },
  };
}

describe('POST /api/alerts/telegram/webhook (Fase D, noc-alert-telegram)', () => {
  // D6 — spec.md "Webhook without or with invalid secret token is rejected".
  it('sin header X-Telegram-Bot-Api-Secret-Token → 401, ningún ACK registrado', async () => {
    const { app, repo } = buildApp();
    seedAlert(repo);

    const res = await request(app).post('/api/alerts/telegram/webhook').send(callback('alert-1'));

    expect(res.status).toBe(401);
    const stored = await repo.findById('alert-1');
    expect(stored?.acknowledged).toBe(false);
  });

  it('con header inválido → 401, ningún ACK registrado', async () => {
    const { app, repo } = buildApp();
    seedAlert(repo);

    const res = await request(app)
      .post('/api/alerts/telegram/webhook')
      .set('X-Telegram-Bot-Api-Secret-Token', 'wrong-secret')
      .send(callback('alert-1'));

    expect(res.status).toBe(401);
    const stored = await repo.findById('alert-1');
    expect(stored?.acknowledged).toBe(false);
  });

  // D7 — spec.md "Valid callback acknowledges the matching alert".
  it('secret válido + callback ack:<id> de alerta existente → AcknowledgeAlert invocado, ackBy/ackAt seteados', async () => {
    const { app, repo, telegramGateway } = buildApp();
    seedAlert(repo);

    const res = await request(app)
      .post('/api/alerts/telegram/webhook')
      .set('X-Telegram-Bot-Api-Secret-Token', WEBHOOK_SECRET)
      .send(callback('alert-1', 'noc_operator'));

    expect(res.status).toBe(200);
    const stored = await repo.findById('alert-1');
    expect(stored?.acknowledged).toBe(true);
    expect(stored?.ackBy).toBe('telegram:noc_operator');
    expect(stored?.ackAt).not.toBeNull();
    expect(telegramGateway.calls).toHaveLength(1);
    expect(telegramGateway.calls[0]?.callbackQueryId).toBe('cbq-1');
  });

  // D8 — spec.md "Callback for a non-existent alert does not error the webhook".
  it('secret válido + callback de id inexistente → 2xx (no retry), NO crea ni modifica ningún NocAlert', async () => {
    const { app, repo, telegramGateway } = buildApp();

    const res = await request(app)
      .post('/api/alerts/telegram/webhook')
      .set('X-Telegram-Bot-Api-Secret-Token', WEBHOOK_SECRET)
      .send(callback('does-not-exist'));

    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
    const stored = await repo.findById('does-not-exist');
    expect(stored).toBeNull();
    expect(telegramGateway.calls).toHaveLength(1);
  });

  // D12 — spec.md "Second acknowledge attempt from the other channel is a no-op"
  // (acá: mismo canal, doble-callback — igual de idempotente).
  it('doble-callback ack:<id> del MISMO alertId → idempotente, ackBy/ackAt NO cambian entre el 1ro y el 2do', async () => {
    const { app, repo } = buildApp();
    seedAlert(repo);

    const first = await request(app)
      .post('/api/alerts/telegram/webhook')
      .set('X-Telegram-Bot-Api-Secret-Token', WEBHOOK_SECRET)
      .send(callback('alert-1', 'first_operator'));
    const second = await request(app)
      .post('/api/alerts/telegram/webhook')
      .set('X-Telegram-Bot-Api-Secret-Token', WEBHOOK_SECRET)
      .send(callback('alert-1', 'second_operator'));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const stored = await repo.findById('alert-1');
    expect(stored?.ackBy).toBe('telegram:first_operator');
  });

  it('update sin callback_query (otro tipo de update) → 2xx, no revienta, no toca ningún NocAlert', async () => {
    const { app, repo } = buildApp();
    seedAlert(repo);

    const res = await request(app)
      .post('/api/alerts/telegram/webhook')
      .set('X-Telegram-Bot-Api-Secret-Token', WEBHOOK_SECRET)
      .send({ message: { text: 'hola' } });

    expect(res.status).toBe(200);
    const stored = await repo.findById('alert-1');
    expect(stored?.acknowledged).toBe(false);
  });

  // F-D3 (fix wave, MEDIUM) — answerCallbackQuery colgado sobre el gateway crudo
  // sin try/catch: un flake de Telegram tiraba, se iba por next(err) → 500, y
  // Telegram reintentaba el webhook aunque el ACK YA se había persistido.
  it('answerCallbackQuery falla (flake de Telegram) → el webhook responde 2xx igual, el ACK ya persistió', async () => {
    const { app, repo } = buildAppWithGateway(new ThrowingTelegramGateway());
    seedAlert(repo);

    const res = await request(app)
      .post('/api/alerts/telegram/webhook')
      .set('X-Telegram-Bot-Api-Secret-Token', WEBHOOK_SECRET)
      .send(callback('alert-1'));

    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
    const stored = await repo.findById('alert-1');
    expect(stored?.acknowledged).toBe(true);
  });
});

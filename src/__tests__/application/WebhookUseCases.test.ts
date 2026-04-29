import { InMemorySettingsRepository } from '../../infrastructure/adapters/in-memory/InMemorySettingsRepository';
import { ListWebhooks } from '../../application/use-cases/ListWebhooks';
import { CreateWebhook } from '../../application/use-cases/CreateWebhook';

function makeRepo() {
  return new InMemorySettingsRepository();
}

describe('ListWebhooks', () => {
  it('returns 3 webhooks', async () => {
    const repo = makeRepo();
    const uc = new ListWebhooks(repo);

    const result = await uc.execute();

    expect(result).toHaveLength(3);
    expect(result[0].id).toBeTruthy();
    expect(result[0].url).toBeTruthy();
  });
});

describe('CreateWebhook', () => {
  it('creates webhook with events', async () => {
    const repo = makeRepo();
    const uc = new CreateWebhook(repo);

    const result = await uc.execute({
      name: 'Test Webhook',
      url: 'https://example.com/hook',
      events: ['client.created', 'invoice.paid'],
      secret: 'mysecret',
      status: 'active',
    });

    expect(result.id).toBeTruthy();
    expect(result.name).toBe('Test Webhook');
    expect(result.events).toContain('client.created');
    expect(result.events).toContain('invoice.paid');
    expect(result.lastTriggered).toBeNull();
    expect(result.lastStatus).toBeNull();
  });
});

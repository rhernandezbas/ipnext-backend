import { InMemorySettingsRepository } from '../../infrastructure/adapters/in-memory/InMemorySettingsRepository';
import { GetSystemSettings } from '../../application/use-cases/GetSystemSettings';
import { UpdateSystemSettings } from '../../application/use-cases/UpdateSystemSettings';
import { GetEmailSettings } from '../../application/use-cases/GetEmailSettings';
import { ListTemplates } from '../../application/use-cases/ListTemplates';
import { ListApiTokens } from '../../application/use-cases/ListApiTokens';
import { CreateApiToken } from '../../application/use-cases/CreateApiToken';

function makeRepo() {
  return new InMemorySettingsRepository();
}

describe('GetSystemSettings', () => {
  it('returns companyName IPNEXT SA', async () => {
    const repo = makeRepo();
    const uc = new GetSystemSettings(repo);

    const result = await uc.execute();

    expect(result.companyName).toBe('IPNEXT SA');
    expect(result.timezone).toBe('America/Argentina/Buenos_Aires');
    expect(result.currency).toBe('ARS');
  });
});

describe('UpdateSystemSettings', () => {
  it('updates and returns the new value', async () => {
    const repo = makeRepo();
    const uc = new UpdateSystemSettings(repo);

    const result = await uc.execute({ companyName: 'NUEVA SA', currency: 'USD' });

    expect(result.companyName).toBe('NUEVA SA');
    expect(result.currency).toBe('USD');
    expect(result.timezone).toBe('America/Argentina/Buenos_Aires');
  });
});

describe('GetEmailSettings', () => {
  it('returns smtpHost', async () => {
    const repo = makeRepo();
    const uc = new GetEmailSettings(repo);

    const result = await uc.execute();

    expect(result.smtpHost).toBe('smtp.ipnext.com.ar');
    expect(result.smtpPort).toBe(587);
    expect(result.useTls).toBe(true);
  });
});

describe('ListTemplates', () => {
  it('returns 3 templates', async () => {
    const repo = makeRepo();
    const uc = new ListTemplates(repo);

    const result = await uc.execute();

    expect(result).toHaveLength(3);
    expect(result[0].id).toBeTruthy();
    expect(result[0].subject).toBeTruthy();
    expect(result[0].body).toBeTruthy();
  });

  it('templates have variables array with at least 2 items', async () => {
    const repo = makeRepo();
    const uc = new ListTemplates(repo);

    const result = await uc.execute();

    expect(result.every(t => Array.isArray(t.variables) && (t.variables?.length ?? 0) >= 2)).toBe(true);
  });
});

describe('ListApiTokens', () => {
  it('returns 2 tokens', async () => {
    const repo = makeRepo();
    const uc = new ListApiTokens(repo);

    const result = await uc.execute();

    expect(result).toHaveLength(2);
    expect(result[0].id).toBeTruthy();
    expect(result[0].name).toBeTruthy();
  });
});

describe('CreateApiToken', () => {
  it('returns token with name and permissions', async () => {
    const repo = makeRepo();
    const uc = new CreateApiToken(repo);

    const result = await uc.execute('Mi token', ['read:clients', 'write:invoices']);

    expect(result.id).toBeTruthy();
    expect(result.name).toBe('Mi token');
    expect(result.permissions).toContain('read:clients');
    expect(result.permissions).toContain('write:invoices');
    expect(result.createdAt).toBeTruthy();
    expect(result.lastUsed).toBeNull();
  });
});

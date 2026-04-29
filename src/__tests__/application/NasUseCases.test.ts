import { InMemoryNasRepository } from '../../infrastructure/adapters/in-memory/InMemoryNasRepository';
import { ListNasServers } from '../../application/use-cases/ListNasServers';
import { GetNasServer } from '../../application/use-cases/GetNasServer';
import { GetRadiusConfig } from '../../application/use-cases/GetRadiusConfig';
import { UpdateRadiusConfig } from '../../application/use-cases/UpdateRadiusConfig';

function makeRepo() {
  return new InMemoryNasRepository();
}

describe('ListNasServers', () => {
  it('returns 3 seeded NAS servers', async () => {
    const repo = makeRepo();
    const uc = new ListNasServers(repo);

    const result = await uc.execute();

    expect(result).toHaveLength(3);
    expect(result[0].name).toBe('MikroTik central');
  });
});

describe('GetNasServer', () => {
  it('returns NAS server by id', async () => {
    const repo = makeRepo();
    const uc = new GetNasServer(repo);

    const result = await uc.execute('2');

    expect(result).not.toBeNull();
    expect(result!.id).toBe('2');
    expect(result!.name).toBe('Ubiquiti zona norte');
    expect(result!.type).toBe('ubiquiti');
  });
});

describe('NasServer radiusSecret masking', () => {
  it('radiusSecret is masked in response', async () => {
    const repo = makeRepo();
    const uc = new ListNasServers(repo);

    const result = await uc.execute();

    result.forEach(server => {
      expect(server.radiusSecret).toBe('••••••••');
    });
  });
});

describe('GetRadiusConfig', () => {
  it('returns config with authPort 1812', async () => {
    const repo = makeRepo();
    const uc = new GetRadiusConfig(repo);

    const result = await uc.execute();

    expect(result.authPort).toBe(1812);
    expect(result.acctPort).toBe(1813);
    expect(result.coaPort).toBe(3799);
  });
});

describe('UpdateRadiusConfig', () => {
  it('updates sessionTimeout', async () => {
    const repo = makeRepo();
    const uc = new UpdateRadiusConfig(repo);

    const result = await uc.execute({ sessionTimeout: 43200 });

    expect(result.sessionTimeout).toBe(43200);
    expect(result.authPort).toBe(1812); // unchanged
  });
});

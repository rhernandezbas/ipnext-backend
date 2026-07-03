import { InMemoryNasRepository } from '../../infrastructure/adapters/in-memory/InMemoryNasRepository';
import { ListNasServers } from '../../application/use-cases/ListNasServers';
import { GetNasServer } from '../../application/use-cases/GetNasServer';
import { UpdateNasServer } from '../../application/use-cases/UpdateNasServer';
import { GetRadiusConfig } from '../../application/use-cases/GetRadiusConfig';
import { UpdateRadiusConfig } from '../../application/use-cases/UpdateRadiusConfig';
import { NAS_SECRET_MASK } from '../../domain/entities/nas';

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

describe('NasServer secret masking (use case)', () => {
  it('radiusSecret & apiPassword are masked in list/get when a REAL secret is stored', async () => {
    const repo = makeRepo();
    const created = await repo.createNasServer({
      name: 'real', type: 'mikrotik_api', ipAddress: '10.0.0.9', radiusSecret: 'REAL-RADIUS-SECRET',
      nasIpAddress: '10.0.0.9', apiPort: 8728, apiLogin: 'admin', apiPassword: 'REAL-API-PW',
      status: 'active', lastSeen: null, clientCount: 0, description: '',
    });

    const list = await new ListNasServers(repo).execute();
    const fromList = list.find(n => n.id === created.id)!;
    expect(fromList.radiusSecret).toBe(NAS_SECRET_MASK);
    expect(fromList.apiPassword).toBe(NAS_SECRET_MASK);

    const got = await new GetNasServer(repo).execute(created.id);
    expect(got!.radiusSecret).toBe(NAS_SECRET_MASK);
    expect(got!.apiPassword).toBe(NAS_SECRET_MASK);
  });
});

describe('UpdateNasServer secret sentinel', () => {
  it('mask / empty leaves the stored secret intact; a real new value updates it', async () => {
    const repo = makeRepo();
    // plant a real secret directly on seed id=1 (bypasses the use-case sentinel)
    await repo.updateNasServer('1', { radiusSecret: 'STORED-REAL', apiPassword: 'STORED-API' });
    const uc = new UpdateNasServer(repo);

    await uc.execute('1', { radiusSecret: NAS_SECRET_MASK, apiPassword: NAS_SECRET_MASK });
    let stored = await repo.findNasServerById('1');
    expect(stored!.radiusSecret).toBe('STORED-REAL');
    expect(stored!.apiPassword).toBe('STORED-API');

    await uc.execute('1', { radiusSecret: '', apiPassword: '' });
    stored = await repo.findNasServerById('1');
    expect(stored!.radiusSecret).toBe('STORED-REAL');

    await uc.execute('1', { radiusSecret: 'NEW-REAL' });
    stored = await repo.findNasServerById('1');
    expect(stored!.radiusSecret).toBe('NEW-REAL');
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

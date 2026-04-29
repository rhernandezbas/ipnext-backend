import { InMemoryPartnerRepository } from '../../infrastructure/adapters/in-memory/InMemoryPartnerRepository';
import { ListPartners } from '../../application/use-cases/ListPartners';
import { GetPartner } from '../../application/use-cases/GetPartner';
import { CreatePartner } from '../../application/use-cases/CreatePartner';
import { UpdatePartner } from '../../application/use-cases/UpdatePartner';
import { DeletePartner } from '../../application/use-cases/DeletePartner';

function makeRepo() {
  return new InMemoryPartnerRepository();
}

describe('ListPartners', () => {
  it('returns all 3 seeded partners', async () => {
    const repo = makeRepo();
    const uc = new ListPartners(repo);

    const result = await uc.execute();

    expect(result).toHaveLength(3);
    expect(result[0].name).toBe('IPNEXT Buenos Aires');
    expect(result[1].name).toBe('IPNEXT Córdoba');
    expect(result[2].name).toBe('IPNEXT Rosario');
  });
});

describe('GetPartner', () => {
  it('returns correct partner by id', async () => {
    const repo = makeRepo();
    const uc = new GetPartner(repo);

    const result = await uc.execute('1');

    expect(result).not.toBeNull();
    expect(result!.id).toBe('1');
    expect(result!.primaryEmail).toBe('ba@ipnext.com.ar');
    expect(result!.clientCount).toBe(1250);
  });
});

describe('CreatePartner', () => {
  it('creates partner with correct fields', async () => {
    const repo = makeRepo();
    const uc = new CreatePartner(repo);

    const result = await uc.execute({
      name: 'IPNEXT Mar del Plata',
      status: 'active',
      primaryEmail: 'mdp@ipnext.com.ar',
      phone: '+54223000000',
      address: 'Av. Colón 1000',
      city: 'Mar del Plata',
      country: 'AR',
      timezone: 'America/Argentina/Buenos_Aires',
      currency: 'ARS',
      logoUrl: null,
    });

    expect(result.id).toBeTruthy();
    expect(result.name).toBe('IPNEXT Mar del Plata');
    expect(result.clientCount).toBe(0);
    expect(result.adminCount).toBe(0);
    expect(result.createdAt).toBeTruthy();
  });
});

describe('UpdatePartner', () => {
  it('updates partner status', async () => {
    const repo = makeRepo();
    const uc = new UpdatePartner(repo);

    const result = await uc.execute('3', { status: 'active' });

    expect(result).not.toBeNull();
    expect(result!.id).toBe('3');
    expect(result!.status).toBe('active');
    expect(result!.name).toBe('IPNEXT Rosario');
  });
});

describe('DeletePartner', () => {
  it('removes partner and returns true', async () => {
    const repo = makeRepo();
    const uc = new DeletePartner(repo);

    const result = await uc.execute('3');

    expect(result).toBe(true);

    const listUc = new ListPartners(repo);
    const remaining = await listUc.execute();
    expect(remaining).toHaveLength(2);
    expect(remaining.find(p => p.id === '3')).toBeUndefined();
  });
});

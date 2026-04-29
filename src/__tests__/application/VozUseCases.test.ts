import { InMemoryVozRepository } from '../../infrastructure/adapters/in-memory/InMemoryVozRepository';
import { ListVoipCategories } from '../../application/use-cases/ListVoipCategories';
import { CreateVoipCategory } from '../../application/use-cases/CreateVoipCategory';
import { ListVoipCdrs } from '../../application/use-cases/ListVoipCdrs';
import { ListVoipPlans } from '../../application/use-cases/ListVoipPlans';

function makeRepo() {
  return new InMemoryVozRepository();
}

describe('ListVoipCategories', () => {
  it('returns 4 seeded categories', async () => {
    const repo = makeRepo();
    const uc = new ListVoipCategories(repo);

    const result = await uc.execute();

    expect(result).toHaveLength(4);
    expect(result[0].name).toBe('Llamadas locales');
    expect(result[3].name).toBe('Internacional');
  });
});

describe('CreateVoipCategory', () => {
  it('creates category correctly', async () => {
    const repo = makeRepo();
    const uc = new CreateVoipCategory(repo);

    const result = await uc.execute({
      name: 'Llamadas a empresas',
      prefix: '0800',
      pricePerMinute: 0,
      freeMinutes: 0,
      status: 'active',
    });

    expect(result.id).toBeTruthy();
    expect(result.name).toBe('Llamadas a empresas');
    expect(result.prefix).toBe('0800');
  });
});

describe('ListVoipCdrs', () => {
  it('returns 10 seeded CDR records', async () => {
    const repo = makeRepo();
    const uc = new ListVoipCdrs(repo);

    const result = await uc.execute();

    expect(result).toHaveLength(10);
    expect(result.every(c => c.id && c.clientId && c.callerNumber)).toBe(true);
  });
});

describe('ListVoipPlans', () => {
  it('returns 2 seeded VoIP plans', async () => {
    const repo = makeRepo();
    const uc = new ListVoipPlans(repo);

    const result = await uc.execute();

    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('Plan VoIP Básico');
    expect(result[1].name).toBe('Plan VoIP Total');
  });
});

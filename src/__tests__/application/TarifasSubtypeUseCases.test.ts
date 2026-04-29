import { InMemoryEmpresaRepository } from '../../infrastructure/adapters/in-memory/InMemoryEmpresaRepository';
import { ListServicePlans } from '../../application/use-cases/ListServicePlans';

function makeRepo() {
  return new InMemoryEmpresaRepository();
}

describe('ListServicePlans with subtype filter', () => {
  it('returns only internet plans when subtype=internet', async () => {
    const repo = makeRepo();
    const uc = new ListServicePlans(repo);

    const result = await uc.execute('internet');

    expect(result.length).toBeGreaterThan(0);
    result.forEach(p => expect(p.planSubtype).toBe('internet'));
  });

  it('all plans have planSubtype field', async () => {
    const repo = makeRepo();
    const uc = new ListServicePlans(repo);

    const result = await uc.execute();

    result.forEach(p => expect(p.planSubtype).toBeDefined());
  });
});

import { InMemoryEmpresaRepository } from '../../infrastructure/adapters/in-memory/InMemoryEmpresaRepository';
import { ListInventoryProducts } from '../../application/use-cases/ListInventoryProducts';
import { ListInventoryUnits } from '../../application/use-cases/ListInventoryUnits';

function makeRepo() {
  return new InMemoryEmpresaRepository();
}

describe('ListInventoryProducts', () => {
  it('returns 5 products', async () => {
    const repo = makeRepo();
    const uc = new ListInventoryProducts(repo);

    const result = await uc.execute();

    expect(result).toHaveLength(5);
    expect(result[0].sku).toBeTruthy();
    expect(result[0].description).toBeTruthy();
    expect(result[0].totalStock).toBeDefined();
  });
});

describe('ListInventoryUnits', () => {
  it('returns 10 units', async () => {
    const repo = makeRepo();
    const uc = new ListInventoryUnits(repo);

    const result = await uc.execute();

    expect(result).toHaveLength(10);
  });

  it('units have serialNumber field', async () => {
    const repo = makeRepo();
    const uc = new ListInventoryUnits(repo);

    const result = await uc.execute();

    // serialNumber may be null (cables) but field must exist
    expect(result.every(u => 'serialNumber' in u)).toBe(true);
  });

  it('filters by productId', async () => {
    const repo = makeRepo();
    const uc = new ListInventoryUnits(repo);

    const result = await uc.execute('prod-1');

    expect(result.length).toBe(2);
    expect(result.every(u => u.productId === 'prod-1')).toBe(true);
  });
});

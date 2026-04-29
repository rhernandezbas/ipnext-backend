import { InMemoryEmpresaRepository } from '../../infrastructure/adapters/in-memory/InMemoryEmpresaRepository';
import { ListServicePlans } from '../../application/use-cases/ListServicePlans';
import { GetServicePlan } from '../../application/use-cases/GetServicePlan';
import { CreateServicePlan } from '../../application/use-cases/CreateServicePlan';
import { UpdateServicePlan } from '../../application/use-cases/UpdateServicePlan';
import { DeleteServicePlan } from '../../application/use-cases/DeleteServicePlan';
import { ListNetworkDevices } from '../../application/use-cases/ListNetworkDevices';
import { ListInventoryItems } from '../../application/use-cases/ListInventoryItems';

function makeRepo() {
  return new InMemoryEmpresaRepository();
}

describe('ListServicePlans', () => {
  it('returns seeded service plans', async () => {
    const repo = makeRepo();
    const uc = new ListServicePlans(repo);

    const result = await uc.execute();

    expect(result.length).toBeGreaterThanOrEqual(4);
    expect(result[0].name).toBe('Plan Básico');
    expect(result[1].name).toBe('Plan Estándar');
    expect(result[2].name).toBe('Plan Premium');
  });
});

describe('GetServicePlan', () => {
  it('returns correct plan by id', async () => {
    const repo = makeRepo();
    const uc = new GetServicePlan(repo);

    const result = await uc.execute('2');

    expect(result).not.toBeNull();
    expect(result!.id).toBe('2');
    expect(result!.name).toBe('Plan Estándar');
    expect(result!.downloadSpeed).toBe(100);
    expect(result!.price).toBe(6500);
  });
});

describe('CreateServicePlan', () => {
  it('creates new service plan with correct fields', async () => {
    const repo = makeRepo();
    const uc = new CreateServicePlan(repo);

    const result = await uc.execute({
      name: 'Plan Test',
      type: 'internet',
      planSubtype: 'internet',
      downloadSpeed: 500,
      uploadSpeed: 200,
      price: 20000,
      billingCycle: 'monthly',
      status: 'active',
      description: 'Test plan',
      subscriberCount: 0,
    });

    expect(result.id).toBeTruthy();
    expect(result.name).toBe('Plan Test');
    expect(result.downloadSpeed).toBe(500);
    expect(result.price).toBe(20000);
  });
});

describe('UpdateServicePlan', () => {
  it('updates plan price', async () => {
    const repo = makeRepo();
    const uc = new UpdateServicePlan(repo);

    const result = await uc.execute('1', { price: 4000 });

    expect(result).not.toBeNull();
    expect(result!.id).toBe('1');
    expect(result!.price).toBe(4000);
    expect(result!.name).toBe('Plan Básico');
  });
});

describe('ListNetworkDevices', () => {
  it('returns 5 seeded network devices', async () => {
    const repo = makeRepo();
    const uc = new ListNetworkDevices(repo);

    const result = await uc.execute();

    expect(result).toHaveLength(5);
    expect(result.every(d => d.id && d.name && d.type && d.ipAddress)).toBe(true);
  });
});

describe('ListInventoryItems', () => {
  it('returns 5 seeded inventory items', async () => {
    const repo = makeRepo();
    const uc = new ListInventoryItems(repo);

    const result = await uc.execute();

    expect(result).toHaveLength(5);
    expect(result.every(i => i.id && i.name && i.sku)).toBe(true);
  });

  it('item status is low_stock when quantity < minStock', async () => {
    const repo = makeRepo();
    const uc = new ListInventoryItems(repo);

    const result = await uc.execute();
    const lowStockItems = result.filter(i => i.status === 'low_stock');

    expect(lowStockItems.length).toBeGreaterThan(0);
    lowStockItems.forEach(item => {
      expect(item.quantity).toBeLessThan(item.minStock);
    });
  });
});

describe('DeleteServicePlan', () => {
  it('removes plan and returns true', async () => {
    const repo = makeRepo();
    const uc = new DeleteServicePlan(repo);

    const result = await uc.execute('4');

    expect(result).toBe(true);

    const listUc = new ListServicePlans(repo);
    const remaining = await listUc.execute();
    expect(remaining.find(p => p.id === '4')).toBeUndefined();
  });
});

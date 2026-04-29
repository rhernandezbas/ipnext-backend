import { InMemorySettingsRepository } from '../../infrastructure/adapters/in-memory/InMemorySettingsRepository';
import { GetFinanceSettings } from '../../application/use-cases/GetFinanceSettings';
import { UpdateFinanceSettings } from '../../application/use-cases/UpdateFinanceSettings';
import { ListPaymentMethods } from '../../application/use-cases/ListPaymentMethods';
import { CreatePaymentMethod } from '../../application/use-cases/CreatePaymentMethod';

function makeRepo() {
  return new InMemorySettingsRepository();
}

describe('GetFinanceSettings', () => {
  it('returns taxRate 21', async () => {
    const repo = makeRepo();
    const uc = new GetFinanceSettings(repo);

    const result = await uc.execute();

    expect(result.taxRate).toBe(21);
    expect(result.taxName).toBe('IVA');
    expect(result.currency).toBe('ARS');
  });
});

describe('UpdateFinanceSettings', () => {
  it('updates invoiceDueDays', async () => {
    const repo = makeRepo();
    const uc = new UpdateFinanceSettings(repo);

    const result = await uc.execute({ invoiceDueDays: 15 });

    expect(result.invoiceDueDays).toBe(15);
    expect(result.taxRate).toBe(21);
  });
});

describe('ListPaymentMethods', () => {
  it('returns 3 seeded payment methods', async () => {
    const repo = makeRepo();
    const uc = new ListPaymentMethods(repo);

    const result = await uc.execute();

    expect(result).toHaveLength(3);
    expect(result[0].name).toBe('Transferencia bancaria');
    expect(result[1].name).toBe('Mercado Pago');
    expect(result[2].name).toBe('Efectivo');
  });
});

describe('CreatePaymentMethod', () => {
  it('creates payment method with correct fields', async () => {
    const repo = makeRepo();
    const uc = new CreatePaymentMethod(repo);

    const result = await uc.execute({
      name: 'Débito automático',
      type: 'card',
      enabled: true,
      config: { processor: 'VISA' },
    });

    expect(result.id).toBeTruthy();
    expect(result.name).toBe('Débito automático');
    expect(result.type).toBe('card');
    expect(result.enabled).toBe(true);
  });
});

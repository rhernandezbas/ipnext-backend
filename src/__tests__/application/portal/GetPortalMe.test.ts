/**
 * customer-portal-api (Fase 4, task 4.1) — GetPortalMe.
 *
 * portal-self-service spec "Mi resumen (GET /api/portal/me)" + "Cliente sin saldo
 * fetcheado". Fake CustomerRepository INLINE MINIMO (convencion del repo — ver
 * messagingBulk.routes.test.ts / ReceiveChatwootWebhook.optout.test.ts: "NO un
 * InMemoryCustomerRepository completo", no existe un adapter in-memory compartido
 * para este port).
 */
import { GetPortalMe } from '@application/use-cases/portal/GetPortalMe';
import { Customer } from '@domain/entities/customer';
import { ClientNotFoundError } from '@domain/errors';
import type { CustomerRepository } from '@domain/ports/CustomerRepository';

function makeCustomer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: 'client-a',
    name: 'Ana Cliente',
    email: 'ana@example.com',
    phone: '1155551234',
    status: 'active',
    address: 'Calle Falsa 123',
    city: 'CABA',
    country: 'AR',
    login: 'ana',
    createdAt: '2026-01-01T00:00:00.000Z',
    balanceDue: null,
    balanceCurrency: null,
    lastBalanceAt: null,
    ...overrides,
  };
}

class FakeCustomerRepository implements Partial<CustomerRepository> {
  private customers = new Map<string, Customer>();

  seed(customer: Customer): void {
    this.customers.set(customer.id, customer);
  }

  async findById(id: string): Promise<Customer> {
    const c = this.customers.get(id);
    if (!c) throw new ClientNotFoundError(id);
    return c;
  }
}

describe('GetPortalMe — customer-portal-api Fase 4.1', () => {
  it('devuelve nombre, estado y saldo del cliente del token', async () => {
    const repo = new FakeCustomerRepository();
    repo.seed(makeCustomer({ id: 'client-a', name: 'Ana Cliente', status: 'active', balanceDue: 1500, balanceCurrency: 'ARS', lastBalanceAt: '2026-07-01T00:00:00.000Z' }));
    const useCase = new GetPortalMe(repo as unknown as CustomerRepository);

    const result = await useCase.execute('client-a');

    expect(result).toEqual({
      name: 'Ana Cliente',
      status: 'active',
      balance: 1500,
      balanceCurrency: 'ARS',
      lastBalanceAt: '2026-07-01T00:00:00.000Z',
    });
  });

  it('scenario "Cliente sin saldo fetcheado": balanceDue null -> balance: null (NUNCA 0)', async () => {
    const repo = new FakeCustomerRepository();
    repo.seed(makeCustomer({ id: 'client-a', balanceDue: null, balanceCurrency: null, lastBalanceAt: null }));
    const useCase = new GetPortalMe(repo as unknown as CustomerRepository);

    const result = await useCase.execute('client-a');

    expect(result.balance).toBeNull();
    expect(result.balance).not.toBe(0);
  });

  // anti-IDOR (spec 4.5): dos clientes seedeados, cada token trae SOLO su propio clientId
  // (el clientId nunca llega desde otro lado que no sea req.portalClientId — la ruta lo
  // pasa aca como el UNICO argumento). Este test prueba que el use case respeta el clientId
  // que recibe y jamas filtra data de otro id salvo que se lo pidan explicitamente.
  it('anti-IDOR: dos clientes seedeados, cada llamada ve SOLO su propio cliente', async () => {
    const repo = new FakeCustomerRepository();
    repo.seed(makeCustomer({ id: 'client-a', name: 'Cliente A', balanceDue: 100 }));
    repo.seed(makeCustomer({ id: 'client-b', name: 'Cliente B', balanceDue: 200 }));
    const useCase = new GetPortalMe(repo as unknown as CustomerRepository);

    const a = await useCase.execute('client-a');
    const b = await useCase.execute('client-b');

    expect(a.name).toBe('Cliente A');
    expect(a.balance).toBe(100);
    expect(b.name).toBe('Cliente B');
    expect(b.balance).toBe(200);
  });
});

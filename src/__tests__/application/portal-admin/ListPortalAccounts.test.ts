/**
 * ListPortalAccounts — customer-portal-api (Fase 3, task 3.2).
 * Spec: portal-accounts-admin "Habilitar / deshabilitar / borrar / listar" — GET, paginado.
 */
import { ListPortalAccounts } from '@application/use-cases/portal-admin/ListPortalAccounts';
import { InMemoryPortalAccountRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalAccountRepository';
import { InMemoryClientPortalLookup } from '@infrastructure/adapters/in-memory/InMemoryClientPortalLookup';

async function build() {
  const accounts = new InMemoryPortalAccountRepository();
  const clients = new InMemoryClientPortalLookup();
  const useCase = new ListPortalAccounts(accounts, clients);
  return { accounts, clients, useCase };
}

describe('ListPortalAccounts', () => {
  it('lista con nombre del cliente, dni, status y lastLoginAt', async () => {
    const { accounts, clients, useCase } = await build();
    clients.seed('client-1', 'Ronald Hernández');
    await accounts.create({ clientId: 'client-1', dni: '17883799', passwordHash: 'h' });

    const result = await useCase.execute({});
    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({
      clientId: 'client-1',
      clientName: 'Ronald Hernández',
      dni: '17883799',
      status: 'active',
      lastLoginAt: null,
    });
    expect((result.data[0] as unknown as Record<string, unknown>).passwordHash).toBeUndefined();
  });

  it('paginado — respeta page/limit y total', async () => {
    const { accounts, clients, useCase } = await build();
    for (let i = 0; i < 5; i++) {
      clients.seed(`client-${i}`, `Cliente ${i}`);
      await accounts.create({ clientId: `client-${i}`, dni: `dni-${i}`, passwordHash: 'h' });
    }

    const page1 = await useCase.execute({ page: 1, limit: 2 });
    expect(page1.data).toHaveLength(2);
    expect(page1.total).toBe(5);
    expect(page1.page).toBe(1);
    expect(page1.limit).toBe(2);

    const page3 = await useCase.execute({ page: 3, limit: 2 });
    expect(page3.data).toHaveLength(1);
  });

  it('lista vacía cuando no hay cuentas', async () => {
    const { useCase } = await build();
    const result = await useCase.execute({});
    expect(result.data).toEqual([]);
    expect(result.total).toBe(0);
  });
});

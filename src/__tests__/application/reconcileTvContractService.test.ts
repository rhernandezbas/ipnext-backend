/**
 * #67 re-review — reconcileTvContractService con `excludeServiceIds`.
 *
 * El CRITICAL del #67: en la baja real el pack BASE es IRREMOVIBLE (su DELETE lanza 424),
 * así que cuando el reconcile RELEE la cuenta el base SIGUE presente. Sin exclusión, la rama
 * "services present" reactivaba la fila TV local (active, notes del CIC viejo, credenciales
 * intactas) y el renew+unlink posterior la dejaba irreparable.
 *
 * FIX: `excludeServiceIds` permite descontar los ids derivados a `unremovable`. Con SÓLO el
 * base (excluido) la rama es "vacía" → la fila se INACTIVA + limpia credenciales (#65 M6).
 */
import { reconcileTvContractService } from '@application/use-cases/gigared/reconcileTvContractService';
import { InMemoryContractServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceRepository';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';
import type { GigaredPort, GigaredAccount } from '@domain/ports/GigaredPort';

function fakeAccount(over: Partial<GigaredAccount> = {}): GigaredAccount {
  const base: GigaredAccount = {
    cic: '0006230159', gigaredId: '100', email: 'e@x.com', firstName: 'N', lastName: 'A',
    registrationDate: '2026-01-19', services: [], internalId: 'cust-1', clientId: 'cust-1', ott: null,
  };
  const merged = { ...base, ...over };
  if (!('clientId' in over)) {
    merged.clientId = merged.internalId ? merged.internalId.replace(/-\d+$/, '') : null;
  }
  return merged;
}

function fakePort(over: Partial<GigaredPort> = {}): GigaredPort {
  return {
    getSummary: jest.fn(),
    listAccounts: jest.fn(),
    getAccountByInternalId: jest.fn(async () => fakeAccount()),
    getAccountByCic: jest.fn(async () => fakeAccount()),
    register: jest.fn(), activate: jest.fn(), setInternalId: jest.fn(async () => {}),
    addService: jest.fn(async () => {}),
    removeService: jest.fn(async () => {}),
    setOtt: jest.fn(async () => {}),
    changePassword: jest.fn(async () => {}),
    renewCic: jest.fn(async () => ({ oldCic: '0006230159', newCic: '0006230160' })),
    ...over,
  };
}

async function seed(catalog: InMemoryServiceCatalogRepository, cs: InMemoryContractServiceRepository) {
  const cat = await catalog.create({ name: 'TV', label: 'TV', active: true, sortOrder: 0 });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (cs as any).catalog[cat.id] = { name: cat.name, label: cat.label };
  return cat;
}

describe('reconcileTvContractService — excludeServiceIds (#67 re-review)', () => {
  let cs: InMemoryContractServiceRepository;
  let catalog: InMemoryServiceCatalogRepository;
  beforeEach(() => {
    cs = new InMemoryContractServiceRepository();
    catalog = new InMemoryServiceCatalogRepository();
  });

  it('SÓLO el base irremovible presente + excludeServiceIds=[base] → rama VACÍA → fila INACTIVA + credenciales limpias', async () => {
    const cat = await seed(catalog, cs);
    const row = await cs.add({
      contractId: 'C1', serviceCatalogId: cat.id,
      notes: 'CIC 0006230159 · Gigared Play Full', tvLogin: 'GIGA129', tvPassword: 'old-secret',
    });
    // La cuenta RELEÍDA sigue teniendo el base (nunca se borró).
    const gigared = fakePort({
      getAccountByInternalId: jest.fn(async () =>
        fakeAccount({ services: [{ id: '129', name: 'Gigared Play Full' }] })),
    });

    await reconcileTvContractService({
      gigared, csRepo: cs, catalogRepo: catalog,
      customerId: 'cust-1', contractId: 'C1',
      clearCredentialsOnInactive: true,
      excludeServiceIds: ['129'],
    });

    const after = await cs.getById(row.id);
    expect(after!.status).toBe('inactive');
    expect(after!.tvLogin).toBeNull();
    expect(after!.tvPassword).toBeNull();
  });

  it('add-on real presente que NO está en excludeServiceIds → rama "services present" → fila ACTIVA (no la inactiva por error)', async () => {
    const cat = await seed(catalog, cs);
    const row = await cs.add({
      contractId: 'C1', serviceCatalogId: cat.id, notes: 'CIC 0006230159 · viejo',
    });
    const gigared = fakePort({
      getAccountByInternalId: jest.fn(async () =>
        fakeAccount({ services: [
          { id: '129', name: 'Gigared Play Full' },
          { id: '39', name: 'Pack Todo Futbol' },
        ] })),
    });

    await reconcileTvContractService({
      gigared, csRepo: cs, catalogRepo: catalog,
      customerId: 'cust-1', contractId: 'C1',
      excludeServiceIds: ['129'], // sólo el base excluido; 39 sigue contando
    });

    const after = await cs.getById(row.id);
    // queda 39 tras excluir el base → la fila NO se inactiva: sigue activa con el add-on en las notes.
    expect(after!.status).toBe('active');
    expect(after!.notes).toContain('Pack Todo Futbol');
  });

  it('sin excludeServiceIds (comportamiento legacy) → con el base presente la rama es "services present"', async () => {
    const cat = await seed(catalog, cs);
    const row = await cs.add({
      contractId: 'C1', serviceCatalogId: cat.id, notes: 'CIC 0006230159 · viejo',
    });
    const gigared = fakePort({
      getAccountByInternalId: jest.fn(async () =>
        fakeAccount({ services: [{ id: '129', name: 'Gigared Play Full' }] })),
    });

    await reconcileTvContractService({
      gigared, csRepo: cs, catalogRepo: catalog,
      customerId: 'cust-1', contractId: 'C1',
    });

    const after = await cs.getById(row.id);
    expect(after!.status).toBe('active');
  });
});

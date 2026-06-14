/**
 * #109 — RegisterGigaredAccount: CIC se asigna automáticamente del pool de cuentas
 * 'unregistered' (ya no lo elige el operador desde el FE).
 *
 * (a) Pool vacío → NoCicAvailableError (antes de tocar Gigared).
 * (b) Pool con N cuentas unregistered → registra/activa con el CIC elegido por el selector.
 *     Con el `pick` inyectado el test es determinístico.
 */
import { RegisterGigaredAccount } from '@application/use-cases/gigared/RegisterGigaredAccount';
import type { GigaredPort, GigaredAccount } from '@domain/ports/GigaredPort';
import { NoCicAvailableError, GrClientIdRequiredError } from '@domain/errors/gigared';
import { ClientNotFoundError } from '@domain/errors';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeAccount(over: Partial<GigaredAccount> = {}): GigaredAccount {
  const base: GigaredAccount = {
    cic: '0000000001', gigaredId: '100', email: 'e@x.com', firstName: 'N', lastName: 'A',
    registrationDate: '2026-01-19', services: [], internalId: 'cust-1', clientId: 'cust-1', ott: null,
  };
  return { ...base, ...over };
}

function fakePort(over: Partial<GigaredPort> = {}): GigaredPort {
  return {
    getSummary:            jest.fn(),
    listAccounts:          jest.fn(async () => []),
    getAccountByInternalId: jest.fn(async () => fakeAccount()),
    getAccountByCic:       jest.fn(async () => fakeAccount()),
    register:              jest.fn(async () => {}),
    activate:              jest.fn(async () => {}),
    setInternalId:         jest.fn(async () => {}),
    addService:            jest.fn(async () => {}),
    removeService:         jest.fn(async () => {}),
    setOtt:                jest.fn(async () => {}),
    changePassword:        jest.fn(async () => {}),
    renewCic:              jest.fn(async () => ({ oldCic: '0000000001', newCic: '0000000002' })),
    ...over,
  };
}

/**
 * Customer lookup minimal — solo necesita id y grClienteId.
 * El grClienteId por default es '123456' → deterministicTvPassword produce 'ip123456'
 * que pasa el check CUA [a-z0-9] 8 chars. 'GR0001' tiene mayúsculas y fallaría.
 */
function fakeCustomerLookup(found = true, grClienteId = '123456') {
  return {
    findById: async (id: string) =>
      found ? { id, grClienteId } : null,
  };
}

/** Input mínimo para el use case (ya sin `cic`). */
const minInput = () => ({
  firstName: 'Juan',
  lastName: 'Pérez',
  email: 'juan@example.com',
  sendActivationEmail: false,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RegisterGigaredAccount #109 — CIC automático del pool', () => {

  it('(a) pool vacío → lanza NoCicAvailableError ANTES de tocar Gigared', async () => {
    const port = fakePort({
      listAccounts: jest.fn(async () => []),
    });
    const uc = new RegisterGigaredAccount(port, fakeCustomerLookup());

    await expect(uc.execute('cust-1', minInput()))
      .rejects.toBeInstanceOf(NoCicAvailableError);

    expect(port.register).not.toHaveBeenCalled();
    expect(port.activate).not.toHaveBeenCalled();
  });

  it('(a) pool vacío → error con code NO_CIC_AVAILABLE', async () => {
    const port = fakePort({ listAccounts: jest.fn(async () => []) });
    const uc = new RegisterGigaredAccount(port, fakeCustomerLookup());

    const err = await uc.execute('cust-1', minInput()).catch(e => e);
    expect((err as NoCicAvailableError).code).toBe('NO_CIC_AVAILABLE');
  });

  it('(b) pool con 3 cuentas → usa la elegida por el selector inyectado (índice 1 → cic "B")', async () => {
    const poolAccounts: GigaredAccount[] = [
      fakeAccount({ cic: 'A' }),
      fakeAccount({ cic: 'B' }),
      fakeAccount({ cic: 'C' }),
    ];
    const port = fakePort({
      listAccounts: jest.fn(async () => poolAccounts),
      getAccountByInternalId: jest.fn(async () => fakeAccount({ cic: 'B' })),
    });
    // selector inyectado: siempre elige índice 1 (determinístico)
    const pick = (_n: number) => 1;

    const uc = new RegisterGigaredAccount(port, fakeCustomerLookup(), undefined, undefined, undefined, undefined, undefined, undefined, pick);
    const result = await uc.execute('cust-1', minInput());

    // listAccounts llamado con { status: 'unregistered' }
    expect(port.listAccounts).toHaveBeenCalledWith({ status: 'unregistered' });

    // register y activate recibieron el CIC del pool elegido
    expect(port.register).toHaveBeenCalledWith(expect.objectContaining({ cic: 'B' }));
    expect(port.activate).toHaveBeenCalledWith(expect.objectContaining({ cic: 'B' }));
    expect(port.setInternalId).toHaveBeenCalledWith('B', expect.any(String));

    // resultado existe y tiene account
    expect(result).toHaveProperty('account');
  });

  it('(b) pool con 1 cuenta → selector elige índice 0 (único disponible)', async () => {
    const singleAccount = fakeAccount({ cic: 'ONLY1' });
    const port = fakePort({
      listAccounts: jest.fn(async () => [singleAccount]),
      getAccountByInternalId: jest.fn(async () => singleAccount),
    });
    const pick = (_n: number) => 0;

    const uc = new RegisterGigaredAccount(port, fakeCustomerLookup(), undefined, undefined, undefined, undefined, undefined, undefined, pick);
    await uc.execute('cust-1', minInput());

    expect(port.register).toHaveBeenCalledWith(expect.objectContaining({ cic: 'ONLY1' }));
    expect(port.activate).toHaveBeenCalledWith(expect.objectContaining({ cic: 'ONLY1' }));
  });

  it('cliente inexistente → ClientNotFoundError (sin tocar el pool)', async () => {
    const port = fakePort();
    const uc = new RegisterGigaredAccount(port, fakeCustomerLookup(false));

    await expect(uc.execute('ghost', minInput()))
      .rejects.toBeInstanceOf(ClientNotFoundError);

    expect(port.listAccounts).not.toHaveBeenCalled();
  });

  it('cliente sin grClienteId → GrClientIdRequiredError (sin tocar el pool)', async () => {
    const port = fakePort();
    const uc = new RegisterGigaredAccount(port, fakeCustomerLookup(true, ''));

    await expect(uc.execute('cust-1', minInput()))
      .rejects.toBeInstanceOf(GrClientIdRequiredError);

    expect(port.listAccounts).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// FIX 1 — CIC vacío (cic: '') en el pool → NoCicAvailableError
// FIX W2 — pick fuera de rango → NoCicAvailableError (no TypeError opaco)
// ---------------------------------------------------------------------------

describe('RegisterGigaredAccount — FIX 1 + W2: guard cic falsy / índice fuera de rango', () => {

  it('FIX 1: pool con cuenta de cic vacío ("") → NoCicAvailableError (no pasa a Gigared)', async () => {
    const port = fakePort({
      listAccounts: jest.fn(async () => [fakeAccount({ cic: '' })]),
    });
    // pick inyectado: siempre elige índice 0 (la única cuenta del pool)
    const pick = (_n: number) => 0;
    const uc = new RegisterGigaredAccount(port, fakeCustomerLookup(), undefined, undefined, undefined, undefined, undefined, undefined, pick);

    await expect(uc.execute('cust-1', minInput()))
      .rejects.toBeInstanceOf(NoCicAvailableError);

    // Gigared jamás debe tocarse
    expect(port.register).not.toHaveBeenCalled();
    expect(port.activate).not.toHaveBeenCalled();
  });

  it('FIX 1: error lanzado tiene code NO_CIC_AVAILABLE (no TypeError)', async () => {
    const port = fakePort({
      listAccounts: jest.fn(async () => [fakeAccount({ cic: '' })]),
    });
    const pick = (_n: number) => 0;
    const uc = new RegisterGigaredAccount(port, fakeCustomerLookup(), undefined, undefined, undefined, undefined, undefined, undefined, pick);

    const err = await uc.execute('cust-1', minInput()).catch(e => e);
    expect(err).toBeInstanceOf(NoCicAvailableError);
    expect((err as NoCicAvailableError).code).toBe('NO_CIC_AVAILABLE');
  });

  it('W2: pick devuelve índice fuera de rango (pool.length) → NoCicAvailableError, no TypeError', async () => {
    const pool = [fakeAccount({ cic: 'X1' }), fakeAccount({ cic: 'X2' })];
    const port = fakePort({
      listAccounts: jest.fn(async () => pool),
    });
    // off-by-one: índice === pool.length → undefined en el array
    const pick = (n: number) => n; // pick(2) para pool de 2 → out-of-bounds
    const uc = new RegisterGigaredAccount(port, fakeCustomerLookup(), undefined, undefined, undefined, undefined, undefined, undefined, pick);

    await expect(uc.execute('cust-1', minInput()))
      .rejects.toBeInstanceOf(NoCicAvailableError);

    expect(port.register).not.toHaveBeenCalled();
  });
});

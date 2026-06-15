/**
 * #109 — RegisterGigaredAccount: CIC se asigna automáticamente del pool de cuentas
 * 'unregistered' (ya no lo elige el operador desde el FE).
 *
 * (a) Pool vacío → NoCicAvailableError (antes de tocar Gigared).
 * (b) Pool con N cuentas unregistered → registra/activa con el CIC elegido por el selector.
 *     Con el `pick` inyectado el test es determinístico.
 *
 * #115 — la identidad determinística de TV (password + email) deriva del grContratoId del
 * CONTRATO, no del grClienteId del cliente. contractId es REQUERIDO para el alta.
 */
import { RegisterGigaredAccount } from '@application/use-cases/gigared/RegisterGigaredAccount';
import type { GigaredPort, GigaredAccount } from '@domain/ports/GigaredPort';
import {
  NoCicAvailableError,
  GrClientIdRequiredError,
  GrContractIdRequiredError,
} from '@domain/errors/gigared';
import { ClientNotFoundError } from '@domain/errors';
import { ContractNotFoundError } from '@domain/errors/contractServices';
import { deterministicTvPassword, deterministicTvEmail } from '@infrastructure/security/gigaredPassword';
import { currentTvInternalId } from '@domain/gigared/tvIdentity';

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
 * Customer lookup minimal — grClienteId puede existir pero ya NO se usa para el alta TV.
 * Lo mantenemos en el shape (otros use cases lo usan); el alta lo ignora.
 */
function fakeCustomerLookup(found = true, grClienteId = '999999') {
  return {
    findById: async (id: string) =>
      found ? { id, grClienteId } : null,
  };
}

/**
 * Contract lookup in-memory. Por defecto el contrato pertenece a 'cust-1' con grContratoId='204382'.
 */
function fakeContractLookup(opts: {
  found?: boolean;
  clientId?: string;
  grContratoId?: string | null;
} = {}) {
  const { found = true, clientId = 'cust-1', grContratoId = '204382' } = opts;
  return {
    findById: async (id: string) =>
      found ? { id, clientId, grContratoId } : null,
  };
}

/** Pick determinístico: siempre devuelve el índice 0. */
const pickFirst = (_n: number) => 0;

/** Input mínimo para el use case — contractId REQUERIDO en el nuevo diseño. */
const minInput = (contractId = 'contract-1') => ({
  firstName: 'Juan',
  lastName: 'Pérez',
  email: 'juan@example.com',
  sendActivationEmail: false,
  contractId,
});

/** Pool de una cuenta para que el use case no falle en NoCicAvailableError. */
function poolOf(cic: string) {
  return jest.fn(async () => [fakeAccount({ cic })]);
}

// ---------------------------------------------------------------------------
// Tests heredados #109 (ajustados: pasan contractId + contractLookup)
// ---------------------------------------------------------------------------

describe('RegisterGigaredAccount #109 — CIC automático del pool', () => {

  it('(a) pool vacío → lanza NoCicAvailableError ANTES de tocar Gigared', async () => {
    const port = fakePort({
      listAccounts: jest.fn(async () => []),
    });
    const uc = new RegisterGigaredAccount(port, fakeCustomerLookup(), fakeContractLookup());

    await expect(uc.execute('cust-1', minInput()))
      .rejects.toBeInstanceOf(NoCicAvailableError);

    expect(port.register).not.toHaveBeenCalled();
    expect(port.activate).not.toHaveBeenCalled();
  });

  it('(a) pool vacío → error con code NO_CIC_AVAILABLE', async () => {
    const port = fakePort({ listAccounts: jest.fn(async () => []) });
    const uc = new RegisterGigaredAccount(port, fakeCustomerLookup(), fakeContractLookup());

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
    const pick = (_n: number) => 1;

    const uc = new RegisterGigaredAccount(port, fakeCustomerLookup(), fakeContractLookup(), undefined, undefined, undefined, undefined, undefined, pick);
    const result = await uc.execute('cust-1', minInput());

    expect(port.listAccounts).toHaveBeenCalledWith({ status: 'unregistered' });
    expect(port.register).toHaveBeenCalledWith(expect.objectContaining({ cic: 'B' }));
    expect(port.activate).toHaveBeenCalledWith(expect.objectContaining({ cic: 'B' }));
    expect(port.setInternalId).toHaveBeenCalledWith('B', expect.any(String));
    expect(result).toHaveProperty('account');
  });

  it('(b) pool con 1 cuenta → selector elige índice 0 (único disponible)', async () => {
    const singleAccount = fakeAccount({ cic: 'ONLY1' });
    const port = fakePort({
      listAccounts: jest.fn(async () => [singleAccount]),
      getAccountByInternalId: jest.fn(async () => singleAccount),
    });
    const pick = (_n: number) => 0;

    const uc = new RegisterGigaredAccount(port, fakeCustomerLookup(), fakeContractLookup(), undefined, undefined, undefined, undefined, undefined, pick);
    await uc.execute('cust-1', minInput());

    expect(port.register).toHaveBeenCalledWith(expect.objectContaining({ cic: 'ONLY1' }));
    expect(port.activate).toHaveBeenCalledWith(expect.objectContaining({ cic: 'ONLY1' }));
  });

  it('cliente inexistente → ClientNotFoundError (sin tocar el pool)', async () => {
    const port = fakePort();
    const uc = new RegisterGigaredAccount(port, fakeCustomerLookup(false), fakeContractLookup());

    await expect(uc.execute('ghost', minInput()))
      .rejects.toBeInstanceOf(ClientNotFoundError);

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
    const pick = (_n: number) => 0;
    const uc = new RegisterGigaredAccount(port, fakeCustomerLookup(), fakeContractLookup(), undefined, undefined, undefined, undefined, undefined, pick);

    await expect(uc.execute('cust-1', minInput()))
      .rejects.toBeInstanceOf(NoCicAvailableError);

    expect(port.register).not.toHaveBeenCalled();
    expect(port.activate).not.toHaveBeenCalled();
  });

  it('FIX 1: error lanzado tiene code NO_CIC_AVAILABLE (no TypeError)', async () => {
    const port = fakePort({
      listAccounts: jest.fn(async () => [fakeAccount({ cic: '' })]),
    });
    const pick = (_n: number) => 0;
    const uc = new RegisterGigaredAccount(port, fakeCustomerLookup(), fakeContractLookup(), undefined, undefined, undefined, undefined, undefined, pick);

    const err = await uc.execute('cust-1', minInput()).catch(e => e);
    expect(err).toBeInstanceOf(NoCicAvailableError);
    expect((err as NoCicAvailableError).code).toBe('NO_CIC_AVAILABLE');
  });

  it('W2: pick devuelve índice fuera de rango (pool.length) → NoCicAvailableError, no TypeError', async () => {
    const pool = [fakeAccount({ cic: 'X1' }), fakeAccount({ cic: 'X2' })];
    const port = fakePort({
      listAccounts: jest.fn(async () => pool),
    });
    const pick = (n: number) => n;
    const uc = new RegisterGigaredAccount(port, fakeCustomerLookup(), fakeContractLookup(), undefined, undefined, undefined, undefined, undefined, pick);

    await expect(uc.execute('cust-1', minInput()))
      .rejects.toBeInstanceOf(NoCicAvailableError);

    expect(port.register).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// #115 — Nueva conducta: identidad deriva del grContratoId (NO del grClienteId)
// ---------------------------------------------------------------------------

describe('RegisterGigaredAccount #115 — identidad TV deriva del grContratoId del contrato', () => {

  it('alta primera vez: password derivada de grContratoId (NO de grClienteId)', async () => {
    // Cliente con grClienteId='999999'; contrato con grContratoId='204382'
    // → password debe ser deterministicTvPassword('204382'), no 'ip999999'
    const register = jest.fn(async () => {});
    const port = fakePort({
      listAccounts: poolOf('CIC01'),
      register,
      getAccountByInternalId: jest.fn(async () => fakeAccount({ cic: 'CIC01' })),
    });
    const uc = new RegisterGigaredAccount(
      port,
      fakeCustomerLookup(true, '999999'),
      fakeContractLookup({ grContratoId: '204382' }),
      undefined, undefined, undefined, undefined, undefined, pickFirst,
    );

    await uc.execute('cust-1', minInput('contract-1'));

    const callArg = (register.mock.calls[0] as unknown[])[0] as { password: string };
    expect(callArg.password).toBe(deterministicTvPassword('204382'));
    // Asegurar que NO se usó el grClienteId del cliente
    expect(callArg.password).not.toBe(deterministicTvPassword('999999'));
  });

  it('re-alta (seq=1): email deriva de grContratoId, no de grClienteId', async () => {
    const { InMemoryClientTvCancellationRepository } = await import(
      '@infrastructure/adapters/in-memory/InMemoryClientTvCancellationRepository'
    );
    const { InMemoryClientTvActivationRepository } = await import(
      '@infrastructure/adapters/in-memory/InMemoryClientTvActivationRepository'
    );
    const register = jest.fn(async () => {});
    const port = fakePort({
      listAccounts: poolOf('CIC02'),
      register,
      getAccountByInternalId: jest.fn(async () => fakeAccount({ cic: 'CIC02' })),
    });

    const tvCancellation = new InMemoryClientTvCancellationRepository();
    tvCancellation.seedCancelled('cust-1');
    const activation = new InMemoryClientTvActivationRepository();

    const uc = new RegisterGigaredAccount(
      port,
      fakeCustomerLookup(true, '999999'),
      fakeContractLookup({ grContratoId: '204382' }),
      undefined, undefined,
      tvCancellation,
      activation,
      undefined, pickFirst,
    );

    await uc.execute('cust-1', { ...minInput('contract-1'), lastName: 'López' });

    const callArg = (register.mock.calls[0] as unknown[])[0] as { email: string };
    // seq=1 → email = deterministicTvEmail('López', '204382', 1)
    expect(callArg.email).toBe(deterministicTvEmail('López', '204382', 1));
    // NO el derivado del grClienteId
    expect(callArg.email).not.toBe(deterministicTvEmail('López', '999999', 1));
  });

  it('contrato sin grContratoId (null) → GrContractIdRequiredError, Gigared no tocado', async () => {
    const port = fakePort({ listAccounts: poolOf('CIC03') });
    const uc = new RegisterGigaredAccount(
      port,
      fakeCustomerLookup(),
      fakeContractLookup({ grContratoId: null }),
      undefined, undefined, undefined, undefined, undefined, pickFirst,
    );

    const err = await uc.execute('cust-1', minInput()).catch(e => e);

    expect(err).toBeInstanceOf(GrContractIdRequiredError);
    expect((err as GrContractIdRequiredError).code).toBe('GR_CONTRACT_ID_REQUIRED');
    expect(port.register).not.toHaveBeenCalled();
    expect(port.activate).not.toHaveBeenCalled();
    expect(port.setInternalId).not.toHaveBeenCalled();
  });

  it('grContratoId con chars fuera de CUA → GrContractIdRequiredError, Gigared no tocado', async () => {
    // 'GR-ABCD' genera 'ipGR-ABCD' que tiene guión y mayúsculas → fuera de [a-z0-9]
    const port = fakePort({ listAccounts: poolOf('CIC04') });
    const uc = new RegisterGigaredAccount(
      port,
      fakeCustomerLookup(),
      fakeContractLookup({ grContratoId: 'GR-ABCD' }),
      undefined, undefined, undefined, undefined, undefined, pickFirst,
    );

    const err = await uc.execute('cust-1', minInput()).catch(e => e);

    expect(err).toBeInstanceOf(GrContractIdRequiredError);
    expect((err as GrContractIdRequiredError).code).toBe('GR_CONTRACT_ID_REQUIRED');
    expect(port.register).not.toHaveBeenCalled();
  });

  it('contrato ajeno (clientId != customerId) → ContractNotFoundError, Gigared no tocado (validación SIEMPRE)', async () => {
    const port = fakePort({ listAccounts: poolOf('CIC05') });
    const uc = new RegisterGigaredAccount(
      port,
      fakeCustomerLookup(),
      fakeContractLookup({ clientId: 'otro-cliente', grContratoId: '204382' }),
      undefined, undefined, undefined, undefined, undefined, pickFirst,
    );

    const err = await uc.execute('cust-1', minInput()).catch(e => e);

    expect(err).toBeInstanceOf(ContractNotFoundError);
    expect(port.register).not.toHaveBeenCalled();
    expect(port.activate).not.toHaveBeenCalled();
  });

  it('internal_id sigue siendo currentTvInternalId(customerId, seq) — NO cambia', async () => {
    const setInternalId = jest.fn(async () => {});
    const port = fakePort({
      listAccounts: poolOf('CIC06'),
      setInternalId,
      getAccountByInternalId: jest.fn(async () => fakeAccount({ cic: 'CIC06' })),
    });
    const uc = new RegisterGigaredAccount(
      port,
      fakeCustomerLookup(true, '999999'),
      fakeContractLookup({ grContratoId: '204382' }),
      undefined, undefined, undefined, undefined, undefined, pickFirst,
    );

    await uc.execute('cust-1', minInput('contract-1'));

    // seq=0 (primera alta, sin repos de activation/cancellation) → internal_id = 'cust-1'
    expect(setInternalId).toHaveBeenCalledWith('CIC06', currentTvInternalId('cust-1', 0));
  });
});

// ---------------------------------------------------------------------------
// #118 — Alta nueva (seq=0): email debe derivar server-side del grContratoId
//         igual que la clave y que la re-alta — no del input.email del FE
// ---------------------------------------------------------------------------

describe('RegisterGigaredAccount #118 — alta nueva (seq=0): email server-side del grContratoId', () => {

  it('alta nueva (seq=0): email enviado a Gigared = deterministicTvEmail(lastName, grContratoId, 0), NO input.email del FE', async () => {
    // El FE manda un input.email derivado del grClienteId (ej: 'perez999999@gmail.com')
    // El server debe ignorarlo y derivar el email del grContratoId='204382' server-side
    const register = jest.fn(async () => {});
    const port = fakePort({
      listAccounts: poolOf('CIC10'),
      register,
      getAccountByInternalId: jest.fn(async () => fakeAccount({ cic: 'CIC10' })),
    });
    const uc = new RegisterGigaredAccount(
      port,
      fakeCustomerLookup(true, '999999'),
      fakeContractLookup({ grContratoId: '204382' }),
      undefined, undefined, undefined, undefined, undefined, pickFirst,
    );

    // input.email simula lo que manda el FE (derivado del grClienteId, NO del grContratoId)
    const inputEmailFromFe = 'perez999999@gmail.com';
    await uc.execute('cust-1', { ...minInput('contract-1'), lastName: 'Pérez', email: inputEmailFromFe });

    const callArg = (register.mock.calls[0] as unknown[])[0] as { email: string };
    // Debe ser el email server-side derivado del grContratoId, seq=0
    expect(callArg.email).toBe(deterministicTvEmail('Pérez', '204382', 0));
    // NO el email del FE (que viene del grClienteId)
    expect(callArg.email).not.toBe(inputEmailFromFe);
  });

  it('#118: email (seq=0) y password derivan del MISMO grContratoId — fuente única', async () => {
    // Ambos deben venir de '204382', no de '999999' (grClienteId)
    const register = jest.fn(async () => {});
    const port = fakePort({
      listAccounts: poolOf('CIC11'),
      register,
      getAccountByInternalId: jest.fn(async () => fakeAccount({ cic: 'CIC11' })),
    });
    const uc = new RegisterGigaredAccount(
      port,
      fakeCustomerLookup(true, '999999'),
      fakeContractLookup({ grContratoId: '204382' }),
      undefined, undefined, undefined, undefined, undefined, pickFirst,
    );

    await uc.execute('cust-1', { ...minInput('contract-1'), lastName: 'García' });

    const callArg = (register.mock.calls[0] as unknown[])[0] as { email: string; password: string };
    expect(callArg.email).toBe(deterministicTvEmail('García', '204382', 0));
    expect(callArg.password).toBe(deterministicTvPassword('204382'));
    // Confirmar que NINGUNO deriva del grClienteId
    expect(callArg.email).not.toContain('999999');
    expect(callArg.password).not.toContain('999999');
  });
});

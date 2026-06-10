import { InMemoryClientMirrorRepository } from '@infrastructure/adapters/in-memory/InMemoryClientMirrorRepository';
import { GrClient } from '@domain/entities/gestionReal';

function makeGrClient(id: string, statusCode = '2'): GrClient {
  return {
    grClienteId: id,
    name: `Cliente ${id}`,
    documento: id,
    email: `c${id}@mail.com`,
    phone: '123',
    status: 'Deudor',
    statusCode,
    address: 'Calle 1',
    city: 'Mercedes',
    province: 'Buenos Aires',
    ultimaModificacion: '01-01-2026 10:00:00',
    fechaCreacion: null,
    raw: { original: true },
  };
}

describe('InMemoryClientMirrorRepository.updateClientBalance', () => {
  let repo: InMemoryClientMirrorRepository;
  const at = new Date('2026-05-27T10:00:00Z');

  beforeEach(async () => {
    repo = new InMemoryClientMirrorRepository();
    // Upsert a client first
    await repo.upsertClient(makeGrClient('100011'));
  });

  it('sets balance fields on the client', async () => {
    await repo.updateClientBalance('100011', 65722.07, 'ARS', at);
    const stored = repo.balances.get('100011');
    expect(stored?.amount).toBe(65722.07);
    expect(stored?.currency).toBe('ARS');
    expect(stored?.lastBalanceAt).toEqual(at);
  });

  it('does NOT clobber the original client raw / status', async () => {
    await repo.updateClientBalance('100011', 1000, 'ARS', at);
    const client = repo.clients.get('100011');
    // The original raw payload should still be intact
    expect(client?.raw).toEqual({ original: true });
    expect(client?.statusCode).toBe('2');
  });

  it('can update an existing balance (idempotent overwrite)', async () => {
    await repo.updateClientBalance('100011', 1000, 'ARS', at);
    const at2 = new Date('2026-05-27T11:00:00Z');
    await repo.updateClientBalance('100011', 2000, 'ARS', at2);
    const stored = repo.balances.get('100011');
    expect(stored?.amount).toBe(2000);
    expect(stored?.lastBalanceAt).toEqual(at2);
  });

  it('stores amount=0 for a paid-off client', async () => {
    await repo.updateClientBalance('100011', 0, 'ARS', at);
    const stored = repo.balances.get('100011');
    expect(stored?.amount).toBe(0);
  });

  it('is a no-op for an unknown grClienteId (does not throw)', async () => {
    await expect(repo.updateClientBalance('UNKNOWN', 100, 'ARS', at)).resolves.toBeUndefined();
  });
});

import { UpdateContractName } from '@application/use-cases/UpdateContractName';
import { ContractRepository } from '@domain/ports/ContractRepository';
import { ContractNotFoundError } from '@domain/errors/contractServices';

/** Minimal ContractRepository stub exercising only updateName. */
class StubContractRepo implements ContractRepository {
  public store: Record<string, string | null> = {};
  async list(): Promise<any> { throw new Error('not used'); }
  async stats(): Promise<any> { throw new Error('not used'); }
  async updateName(id: string, name?: string | null) {
    if (!(id in this.store)) return null;
    if (name !== undefined) this.store[id] = name;
    return { id, name: this.store[id] };
  }
  async listDistinctVendedores(): Promise<string[]> { throw new Error('not used'); }
  async updateLocation(): Promise<never> { throw new Error('not used'); }
}

describe('UpdateContractName', () => {
  let repo: StubContractRepo;
  let uc: UpdateContractName;

  beforeEach(() => {
    repo = new StubContractRepo();
    uc = new UpdateContractName(repo);
  });

  // CN-2.1
  it('sets a name on an existing contract', async () => {
    repo.store['C'] = null;
    const result = await uc.execute('C', 'Fibra Casa');
    expect(result).toEqual({ id: 'C', name: 'Fibra Casa' });
    expect(repo.store['C']).toBe('Fibra Casa');
  });

  // CN-2.2 — empty string normalizes to null
  it('normalizes an empty/whitespace string to null', async () => {
    repo.store['C'] = 'Fibra Casa';
    const result = await uc.execute('C', '   ');
    expect(result.name).toBeNull();
    expect(repo.store['C']).toBeNull();
  });

  it('treats explicit null as null', async () => {
    repo.store['C'] = 'X';
    const result = await uc.execute('C', null);
    expect(result.name).toBeNull();
  });

  // CN-2.3
  it('throws ContractNotFoundError when updateName returns null', async () => {
    await expect(uc.execute('X', 'Test')).rejects.toBeInstanceOf(ContractNotFoundError);
  });

  // W-3 — PATCH body {} (name absent) is a no-op: returns the contract unchanged.
  it('no-op when name is undefined: returns current name, does not mutate', async () => {
    repo.store['C'] = 'Fibra Casa';
    const result = await uc.execute('C', undefined);
    expect(result).toEqual({ id: 'C', name: 'Fibra Casa' });
    expect(repo.store['C']).toBe('Fibra Casa');
  });

  it('no-op on a missing contract still throws ContractNotFoundError', async () => {
    await expect(uc.execute('X', undefined)).rejects.toBeInstanceOf(ContractNotFoundError);
  });
});

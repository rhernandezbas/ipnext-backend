import { UpdateIClassStatusCatalog } from '@application/use-cases/UpdateIClassStatusCatalog';
import { InMemoryIClassStatusCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryIClassStatusCatalogRepository';
import { IClassStatusNotFoundError } from '@domain/errors/iclass';

describe('UpdateIClassStatusCatalog', () => {
  async function setup() {
    const repo = new InMemoryIClassStatusCatalogRepository();
    await repo.upsertByStatusCode({ statusCode: '12', iclassLabel: 'Em Análise' });
    const uc = new UpdateIClassStatusCatalog(repo);
    return { repo, uc };
  }

  it('updates only tracked when only tracked provided', async () => {
    const { uc, repo } = await setup();
    const result = await uc.execute('12', { tracked: true });
    expect(result.tracked).toBe(true);
    expect(result.displayLabel).toBeNull();
    expect(result.color).toBeNull();
    // Verify via repo read
    const entry = await repo.getByStatusCode('12');
    expect(entry!.tracked).toBe(true);
  });

  it('updates displayLabel and color without affecting tracked', async () => {
    const { uc, repo } = await setup();
    await repo.update('12', { tracked: true });
    const result = await uc.execute('12', { displayLabel: 'En análisis', color: '#FFAA00' });
    expect(result.displayLabel).toBe('En análisis');
    expect(result.color).toBe('#FFAA00');
    expect(result.tracked).toBe(true); // unchanged
  });

  it('can clear displayLabel and color with null', async () => {
    const { uc, repo } = await setup();
    await repo.update('12', { displayLabel: 'old label', color: '#FF0000' });
    const result = await uc.execute('12', { displayLabel: null, color: null });
    expect(result.displayLabel).toBeNull();
    expect(result.color).toBeNull();
  });

  it('throws IClassStatusNotFoundError for unknown statusCode', async () => {
    const { uc } = await setup();
    await expect(uc.execute('999', { tracked: true })).rejects.toThrow(IClassStatusNotFoundError);
  });
});

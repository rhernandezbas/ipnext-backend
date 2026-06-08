import { describe, it, expect } from '@jest/globals';
import { UpdateIClassClosureConfig } from '@application/use-cases/UpdateIClassClosureConfig';
import { InMemoryIClassClosureConfigRepository } from '../../infrastructure/adapters/in-memory/InMemoryIClassClosureConfigRepository';

describe('UpdateIClassClosureConfig', () => {
  it('full update persists both fields (spec scenario 5)', async () => {
    const repo = new InMemoryIClassClosureConfigRepository();
    const useCase = new UpdateIClassClosureConfig(repo);

    const result = await useCase.execute({ closureIntervalMs: 120000, autocompleteIntervalMs: 300000 });

    expect(result).toEqual({ closureIntervalMs: 120000, autocompleteIntervalMs: 300000 });
    const reread = await repo.get();
    expect(reread).toEqual({ closureIntervalMs: 120000, autocompleteIntervalMs: 300000 });
  });

  it('partial update only closureIntervalMs leaves autocompleteIntervalMs unchanged (spec scenario 6)', async () => {
    const repo = new InMemoryIClassClosureConfigRepository();
    const useCase = new UpdateIClassClosureConfig(repo);

    const result = await useCase.execute({ closureIntervalMs: 120000 });

    expect(result).toEqual({ closureIntervalMs: 120000, autocompleteIntervalMs: 900000 });
    const reread = await repo.get();
    expect(reread.autocompleteIntervalMs).toBe(900000);
  });
});

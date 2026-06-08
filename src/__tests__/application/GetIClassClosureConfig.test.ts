import { describe, it, expect } from '@jest/globals';
import { GetIClassClosureConfig } from '@application/use-cases/GetIClassClosureConfig';
import { InMemoryIClassClosureConfigRepository } from '../../infrastructure/adapters/in-memory/InMemoryIClassClosureConfigRepository';

describe('GetIClassClosureConfig', () => {
  it('returns defaults when no record exists (spec scenario 4)', async () => {
    const repo = new InMemoryIClassClosureConfigRepository();
    const useCase = new GetIClassClosureConfig(repo);

    const result = await useCase.execute();

    expect(result).toEqual({ closureIntervalMs: 600000, autocompleteIntervalMs: 900000 });
  });

  it('returns current persisted config (spec scenario 3)', async () => {
    const repo = new InMemoryIClassClosureConfigRepository();
    await repo.update({ closureIntervalMs: 120000, autocompleteIntervalMs: 300000 });
    const useCase = new GetIClassClosureConfig(repo);

    const result = await useCase.execute();

    expect(result).toEqual({ closureIntervalMs: 120000, autocompleteIntervalMs: 300000 });
  });
});

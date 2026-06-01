import { InMemoryGrLinkResolver } from '@infrastructure/adapters/in-memory/InMemoryGrLinkResolver';

describe('InMemoryGrLinkResolver', () => {
  it('resolves a local Client by GR client id when mirrored', async () => {
    const resolver = new InMemoryGrLinkResolver();
    resolver.seedClient('gr-100', { id: 'c-1', name: 'Juan Pérez' });

    const found = await resolver.findClientByGrId('gr-100');

    expect(found).toEqual({ id: 'c-1', name: 'Juan Pérez' });
  });

  it('returns null when the GR client id is not mirrored', async () => {
    const resolver = new InMemoryGrLinkResolver();

    const found = await resolver.findClientByGrId('gr-unknown');

    expect(found).toBeNull();
  });

  it('resolves a local Contract by GR contract id when mirrored', async () => {
    const resolver = new InMemoryGrLinkResolver();
    resolver.seedContract('gr-c-200', { id: 's-1', plan: '300MB' });

    const found = await resolver.findContractByGrContratoId('gr-c-200');

    expect(found).toEqual({ id: 's-1', plan: '300MB' });
  });

  it('returns null when the GR contract id is not mirrored', async () => {
    const resolver = new InMemoryGrLinkResolver();

    const found = await resolver.findContractByGrContratoId('gr-c-unknown');

    expect(found).toBeNull();
  });

  it('resolves a Contract with a null plan', async () => {
    const resolver = new InMemoryGrLinkResolver();
    resolver.seedContract('gr-c-300', { id: 's-2', plan: null });

    const found = await resolver.findContractByGrContratoId('gr-c-300');

    expect(found).toEqual({ id: 's-2', plan: null });
  });
});

/**
 * Unit test for the in-memory read-only client mirror adapter.
 * Verifies it returns exactly the seeded grClienteId set and exposes no
 * mutators a read-only consumer could misuse (ISP / read-only invariant).
 */
import { InMemoryClientMirrorReadRepository } from '../../infrastructure/adapters/in-memory/InMemoryClientMirrorReadRepository';
import type { ClientMirrorReadRepository } from '../../domain/ports/ClientMirrorReadRepository';

describe('InMemoryClientMirrorReadRepository', () => {
  it('returns exactly the seeded grClienteId set', async () => {
    const repo = new InMemoryClientMirrorReadRepository(['A', 'B', 'C']);
    await expect(repo.listGrClienteIds()).resolves.toEqual(['A', 'B', 'C']);
  });

  it('returns an empty array when not seeded', async () => {
    const repo = new InMemoryClientMirrorReadRepository();
    await expect(repo.listGrClienteIds()).resolves.toEqual([]);
  });

  it('reflects ids set after construction via the settable backing field', async () => {
    const repo = new InMemoryClientMirrorReadRepository();
    repo.ids = ['X', 'Y'];
    await expect(repo.listGrClienteIds()).resolves.toEqual(['X', 'Y']);
  });

  it('satisfies the ClientMirrorReadRepository port (read-only — listGrClienteIds is the only method)', () => {
    const repo: ClientMirrorReadRepository = new InMemoryClientMirrorReadRepository(['A']);
    // The port surface a read-only consumer sees is exactly listGrClienteIds.
    expect(typeof repo.listGrClienteIds).toBe('function');
    const methods = Object.getOwnPropertyNames(InMemoryClientMirrorReadRepository.prototype)
      .filter(name => name !== 'constructor');
    expect(methods).toEqual(['listGrClienteIds']);
  });
});

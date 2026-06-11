/**
 * TDD — SyncIClassNodes use case (REQ-NCAT-1).
 * Covers: created/updated/reactivated/deactivated, grouping nodes → selectable=false,
 * empty-code discarded, IClass down → error propagates.
 */
import { InMemoryIClassClient } from '../../infrastructure/adapters/in-memory/InMemoryIClassClient';
import { InMemoryIClassNodeRepository } from '../../infrastructure/adapters/in-memory/InMemoryIClassNodeRepository';
import { SyncIClassNodes } from '../../application/use-cases/SyncIClassNodes';
import { IClassUnavailableError } from '../../domain/errors/iclass';

function setup() {
  const iclass = new InMemoryIClassClient();
  const repo = new InMemoryIClassNodeRepository();
  const useCase = new SyncIClassNodes(iclass, repo);
  return { iclass, repo, useCase };
}

describe('SyncIClassNodes', () => {
  it('fresh DB + 3 nodes → all created, deactivated=0', async () => {
    const { iclass, repo, useCase } = setup();
    iclass.nodes = [
      { nodeId: 1, code: 'Mercedes', description: 'Mercedes' },
      { nodeId: 2, code: 'Lujan', description: 'Lujan' },
      { nodeId: 3, code: 'Chivilcoy', description: 'Chivilcoy' },
    ];

    const result = await useCase.execute();

    expect(result.created).toBe(3);
    expect(result.updated).toBe(0);
    expect(result.reactivated).toBe(0);
    expect(result.deactivated).toBe(0);
    expect(result.synced).toBe(3);

    const all = await repo.list();
    expect(all).toHaveLength(3);
    expect(all.every(n => n.active && n.selectable)).toBe(true);
  });

  it('grouping nodes persist with selectable=false', async () => {
    const { iclass, repo, useCase } = setup();
    iclass.nodes = [
      { nodeId: 1, code: 'Mercedes', description: 'Mercedes' },
      { nodeId: 10, code: 'IPNEXT INTERNET', description: 'agrupador' },
      { nodeId: 11, code: 'Main', description: 'agrupador' },
      { nodeId: 12, code: 'Argentina', description: 'agrupador' },
    ];

    await useCase.execute();

    const selectable = await repo.list({ selectable: true });
    expect(selectable).toHaveLength(1);
    expect(selectable[0].code).toBe('Mercedes');

    const nonSelectable = await repo.list({ selectable: false });
    expect(nonSelectable.map(n => n.code).sort()).toEqual(['Argentina', 'IPNEXT INTERNET', 'Main']);
  });

  it('node with empty code after trim is discarded', async () => {
    const { iclass, repo, useCase } = setup();
    iclass.nodes = [
      { nodeId: 1, code: 'Mercedes', description: 'Mercedes' },
      { nodeId: 2, code: '   ', description: 'blank' },
    ];

    const result = await useCase.execute();

    expect(result.synced).toBe(1);
    expect(result.created).toBe(1);
    const all = await repo.list();
    expect(all).toHaveLength(1);
    expect(all[0].code).toBe('Mercedes');
  });

  it('re-sync idempotent → all updated', async () => {
    const { iclass, useCase } = setup();
    iclass.nodes = [{ nodeId: 1, code: 'Mercedes', description: 'Mercedes' }];
    await useCase.execute();
    const result = await useCase.execute();
    expect(result.created).toBe(0);
    expect(result.updated).toBe(1);
    expect(result.deactivated).toBe(0);
  });

  it('node disappears → deactivated=1, active=false', async () => {
    const { iclass, repo, useCase } = setup();
    iclass.nodes = [
      { nodeId: 1, code: 'Mercedes', description: 'Mercedes' },
      { nodeId: 2, code: 'Lujan', description: 'Lujan' },
    ];
    await useCase.execute();

    iclass.nodes = [{ nodeId: 1, code: 'Mercedes', description: 'Mercedes' }];
    const result = await useCase.execute();

    expect(result.deactivated).toBe(1);
    const inactive = await repo.list({ active: false });
    expect(inactive).toHaveLength(1);
    expect(inactive[0].code).toBe('Lujan');
  });

  it('disappeared node reappears → reactivated=1', async () => {
    const { iclass, useCase } = setup();
    iclass.nodes = [
      { nodeId: 1, code: 'Mercedes', description: 'Mercedes' },
      { nodeId: 2, code: 'Lujan', description: 'Lujan' },
    ];
    await useCase.execute();

    iclass.nodes = [{ nodeId: 1, code: 'Mercedes', description: 'Mercedes' }];
    await useCase.execute(); // Lujan deactivated

    iclass.nodes = [
      { nodeId: 1, code: 'Mercedes', description: 'Mercedes' },
      { nodeId: 2, code: 'Lujan', description: 'Lujan' },
    ];
    const result = await useCase.execute();

    expect(result.reactivated).toBe(1);
    expect(result.deactivated).toBe(0);
  });

  it('IClass down → propagates IClassUnavailableError', async () => {
    const { iclass, useCase } = setup();
    iclass.failureMode = 'unavailable';
    await expect(useCase.execute()).rejects.toBeInstanceOf(IClassUnavailableError);
  });
});

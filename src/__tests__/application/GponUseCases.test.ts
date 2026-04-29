import { InMemoryGponRepository } from '../../infrastructure/adapters/in-memory/InMemoryGponRepository';
import { ListOlts } from '../../application/use-cases/ListOlts';
import { ListOnus } from '../../application/use-cases/ListOnus';
import { ListOnusByOlt } from '../../application/use-cases/ListOnusByOlt';

function makeRepo() {
  return new InMemoryGponRepository();
}

describe('ListOlts', () => {
  it('returns 2 OLTs', async () => {
    const repo = makeRepo();
    const uc = new ListOlts(repo);

    const result = await uc.execute();

    expect(result).toHaveLength(2);
    expect(result[0].id).toBeTruthy();
    expect(result[0].name).toBeTruthy();
  });
});

describe('ListOnus', () => {
  it('returns 20 ONUs', async () => {
    const repo = makeRepo();
    const uc = new ListOnus(repo);

    const result = await uc.execute();

    expect(result).toHaveLength(20);
  });
});

describe('ListOnusByOlt', () => {
  it('filters by oltId', async () => {
    const repo = makeRepo();
    const uc = new ListOnusByOlt(repo);

    const result = await uc.execute('olt-1');

    expect(result).toHaveLength(10);
    expect(result.every(o => o.oltId === 'olt-1')).toBe(true);
  });
});

import { ListZones } from '@application/use-cases/ListZones';
import { CreateZone } from '@application/use-cases/CreateZone';
import { InMemoryZoneRepository } from '@infrastructure/adapters/in-memory/InMemoryZoneRepository';

const validPoints = [
  { lat: -34.6037, lng: -58.3816 },
  { lat: -34.6, lng: -58.4 },
  { lat: -34.62, lng: -58.38 },
];

describe('ListZones', () => {
  it('returns empty array when no zones exist', async () => {
    const repo = new InMemoryZoneRepository();
    const uc = new ListZones(repo);
    const result = await uc.execute();
    expect(result).toEqual([]);
  });

  it('returns all zones as ZoneDtos', async () => {
    const repo = new InMemoryZoneRepository();
    const createUc = new CreateZone(repo);
    await createUc.execute({ name: 'Norte', color: '#22c55e', points: validPoints });
    await createUc.execute({ name: 'Sur', color: '#ef4444', points: validPoints });
    const listUc = new ListZones(repo);
    const result = await listUc.execute();
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('Norte');
    expect(result[1].name).toBe('Sur');
    // Ensure DTO shape (no Prisma leakage)
    expect(result[0].points).toHaveLength(3);
    expect(result[0].createdAt).toBeDefined();
  });
});

import { DeleteZone } from '@application/use-cases/DeleteZone';
import { ListZones } from '@application/use-cases/ListZones';
import { CreateZone } from '@application/use-cases/CreateZone';
import { InMemoryZoneRepository } from '@infrastructure/adapters/in-memory/InMemoryZoneRepository';
import { ZoneNotFoundError } from '@domain/errors/zone';

const validPoints = [
  { lat: -34.6037, lng: -58.3816 },
  { lat: -34.6, lng: -58.4 },
  { lat: -34.62, lng: -58.38 },
];

describe('DeleteZone', () => {
  it('deletes an existing zone so it no longer appears in list', async () => {
    const repo = new InMemoryZoneRepository();
    const created = await new CreateZone(repo).execute({ name: 'Norte', color: '#22c55e', points: validPoints });
    await new DeleteZone(repo).execute(created.id);
    const list = await new ListZones(repo).execute();
    expect(list).toHaveLength(0);
  });

  it('throws ZoneNotFoundError when zone does not exist', async () => {
    const repo = new InMemoryZoneRepository();
    await expect(new DeleteZone(repo).execute('ghost-id')).rejects.toThrow(ZoneNotFoundError);
  });
});

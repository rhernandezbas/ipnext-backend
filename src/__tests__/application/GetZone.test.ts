import { GetZone } from '@application/use-cases/GetZone';
import { CreateZone } from '@application/use-cases/CreateZone';
import { InMemoryZoneRepository } from '@infrastructure/adapters/in-memory/InMemoryZoneRepository';
import { ZoneNotFoundError } from '@domain/errors/zone';

const validPoints = [
  { lat: -34.6037, lng: -58.3816 },
  { lat: -34.6, lng: -58.4 },
  { lat: -34.62, lng: -58.38 },
];

describe('GetZone', () => {
  it('returns the zone DTO when it exists', async () => {
    const repo = new InMemoryZoneRepository();
    const created = await new CreateZone(repo).execute({ name: 'Norte', color: '#22c55e', points: validPoints });
    const dto = await new GetZone(repo).execute(created.id);
    expect(dto.id).toBe(created.id);
    expect(dto.name).toBe('Norte');
  });

  it('throws ZoneNotFoundError when zone does not exist', async () => {
    const repo = new InMemoryZoneRepository();
    await expect(new GetZone(repo).execute('non-existent-id')).rejects.toThrow(ZoneNotFoundError);
  });
});

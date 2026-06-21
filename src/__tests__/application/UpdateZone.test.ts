import { UpdateZone } from '@application/use-cases/UpdateZone';
import { CreateZone } from '@application/use-cases/CreateZone';
import { InMemoryZoneRepository } from '@infrastructure/adapters/in-memory/InMemoryZoneRepository';
import { ZoneNotFoundError, InvalidPolygonError } from '@domain/errors/zone';

const validPoints = [
  { lat: -34.6037, lng: -58.3816 },
  { lat: -34.6, lng: -58.4 },
  { lat: -34.62, lng: -58.38 },
];

const newPoints = [
  { lat: -34.5, lng: -58.3 },
  { lat: -34.55, lng: -58.35 },
  { lat: -34.52, lng: -58.32 },
  { lat: -34.48, lng: -58.28 },
];

describe('UpdateZone', () => {
  it('updates color and points of an existing zone', async () => {
    const repo = new InMemoryZoneRepository();
    const created = await new CreateZone(repo).execute({ name: 'Norte', color: '#22c55e', points: validPoints });
    const dto = await new UpdateZone(repo).execute({
      id: created.id,
      color: '#ef4444',
      points: newPoints,
    });
    expect(dto.id).toBe(created.id);
    expect(dto.color).toBe('#ef4444');
    expect(dto.points).toHaveLength(4);
    expect(dto.name).toBe('Norte'); // unchanged
  });

  it('throws ZoneNotFoundError when zone does not exist', async () => {
    const repo = new InMemoryZoneRepository();
    await expect(
      new UpdateZone(repo).execute({ id: 'ghost-id', name: 'X' }),
    ).rejects.toThrow(ZoneNotFoundError);
  });

  it('re-validates polygon on update — rejects fewer than 3 points', async () => {
    const repo = new InMemoryZoneRepository();
    const created = await new CreateZone(repo).execute({ name: 'Norte', color: '#22c55e', points: validPoints });
    await expect(
      new UpdateZone(repo).execute({
        id: created.id,
        points: [validPoints[0], validPoints[1]],
      }),
    ).rejects.toThrow(InvalidPolygonError);
  });

  it('re-validates polygon on update — rejects invalid color', async () => {
    const repo = new InMemoryZoneRepository();
    const created = await new CreateZone(repo).execute({ name: 'Norte', color: '#22c55e', points: validPoints });
    await expect(
      new UpdateZone(repo).execute({ id: created.id, color: 'blue' }),
    ).rejects.toThrow(InvalidPolygonError);
  });

  it('re-validates polygon on update — rejects empty name', async () => {
    const repo = new InMemoryZoneRepository();
    const created = await new CreateZone(repo).execute({ name: 'Norte', color: '#22c55e', points: validPoints });
    await expect(
      new UpdateZone(repo).execute({ id: created.id, name: '  ' }),
    ).rejects.toThrow(InvalidPolygonError);
  });

  // W1 — NaN coordinates must be rejected on update too
  it('re-validates polygon on update — rejects point with lat: NaN', async () => {
    const repo = new InMemoryZoneRepository();
    const created = await new CreateZone(repo).execute({ name: 'Norte', color: '#22c55e', points: validPoints });
    await expect(
      new UpdateZone(repo).execute({
        id: created.id,
        points: [{ lat: NaN, lng: 0 }, { lat: 0, lng: 0 }, { lat: 10, lng: 10 }],
      }),
    ).rejects.toThrow(InvalidPolygonError);
  });

  it('re-validates polygon on update — rejects point with lng: NaN', async () => {
    const repo = new InMemoryZoneRepository();
    const created = await new CreateZone(repo).execute({ name: 'Norte', color: '#22c55e', points: validPoints });
    await expect(
      new UpdateZone(repo).execute({
        id: created.id,
        points: [{ lat: 0, lng: NaN }, { lat: 0, lng: 0 }, { lat: 10, lng: 10 }],
      }),
    ).rejects.toThrow(InvalidPolygonError);
  });
});

import { CreateZone } from '@application/use-cases/CreateZone';
import { InMemoryZoneRepository } from '@infrastructure/adapters/in-memory/InMemoryZoneRepository';
import { InvalidPolygonError } from '@domain/errors/zone';

const validPoints = [
  { lat: -34.6037, lng: -58.3816 },
  { lat: -34.6, lng: -58.4 },
  { lat: -34.62, lng: -58.38 },
];

describe('CreateZone', () => {
  it('creates a zone and returns a ZoneDto with id and points', async () => {
    const repo = new InMemoryZoneRepository();
    const uc = new CreateZone(repo);
    const dto = await uc.execute({ name: 'Norte', color: '#22c55e', points: validPoints });
    expect(dto.id).toBeDefined();
    expect(dto.name).toBe('Norte');
    expect(dto.color).toBe('#22c55e');
    expect(dto.points).toHaveLength(3);
    expect(dto.createdAt).toBeDefined();
    expect(dto.updatedAt).toBeDefined();
    expect(dto.description).toBeNull();
  });

  it('rejects polygon with fewer than 3 points', async () => {
    const repo = new InMemoryZoneRepository();
    const uc = new CreateZone(repo);
    await expect(
      uc.execute({ name: 'Sur', color: '#2563eb', points: [validPoints[0], validPoints[1]] }),
    ).rejects.toThrow(InvalidPolygonError);
  });

  it('rejects out-of-range lat (lat = 120)', async () => {
    const repo = new InMemoryZoneRepository();
    const uc = new CreateZone(repo);
    await expect(
      uc.execute({
        name: 'Sur',
        color: '#2563eb',
        points: [{ lat: 120, lng: 0 }, { lat: 0, lng: 0 }, { lat: 10, lng: 10 }],
      }),
    ).rejects.toThrow(InvalidPolygonError);
  });

  it('rejects out-of-range lng (lng = -200)', async () => {
    const repo = new InMemoryZoneRepository();
    const uc = new CreateZone(repo);
    await expect(
      uc.execute({
        name: 'Sur',
        color: '#2563eb',
        points: [{ lat: 0, lng: -200 }, { lat: 0, lng: 0 }, { lat: 10, lng: 10 }],
      }),
    ).rejects.toThrow(InvalidPolygonError);
  });

  it('rejects empty name', async () => {
    const repo = new InMemoryZoneRepository();
    const uc = new CreateZone(repo);
    await expect(
      uc.execute({ name: '  ', color: '#2563eb', points: validPoints }),
    ).rejects.toThrow(InvalidPolygonError);
  });

  it('rejects invalid color (#GGGGGG)', async () => {
    const repo = new InMemoryZoneRepository();
    const uc = new CreateZone(repo);
    await expect(
      uc.execute({ name: 'Norte', color: 'red', points: validPoints }),
    ).rejects.toThrow(InvalidPolygonError);
  });

  it('accepts #RGB short hex color', async () => {
    const repo = new InMemoryZoneRepository();
    const uc = new CreateZone(repo);
    const dto = await uc.execute({ name: 'Norte', color: '#abc', points: validPoints });
    expect(dto.color).toBe('#abc');
  });

  it('stores description when provided', async () => {
    const repo = new InMemoryZoneRepository();
    const uc = new CreateZone(repo);
    const dto = await uc.execute({ name: 'Norte', color: '#22c55e', points: validPoints, description: 'Zona norte' });
    expect(dto.description).toBe('Zona norte');
  });

  // W1 — NaN coordinates must be rejected
  it('rejects point with lat: NaN', async () => {
    const repo = new InMemoryZoneRepository();
    const uc = new CreateZone(repo);
    await expect(
      uc.execute({
        name: 'Norte',
        color: '#22c55e',
        points: [{ lat: NaN, lng: 0 }, { lat: 0, lng: 0 }, { lat: 10, lng: 10 }],
      }),
    ).rejects.toThrow(InvalidPolygonError);
  });

  it('rejects point with lng: NaN', async () => {
    const repo = new InMemoryZoneRepository();
    const uc = new CreateZone(repo);
    await expect(
      uc.execute({
        name: 'Norte',
        color: '#22c55e',
        points: [{ lat: 0, lng: NaN }, { lat: 0, lng: 0 }, { lat: 10, lng: 10 }],
      }),
    ).rejects.toThrow(InvalidPolygonError);
  });

  // W2 — inclusive boundary tests
  it('accepts lat: 90 (inclusive boundary)', async () => {
    const repo = new InMemoryZoneRepository();
    const uc = new CreateZone(repo);
    const dto = await uc.execute({
      name: 'Norte',
      color: '#22c55e',
      points: [{ lat: 90, lng: 0 }, { lat: 0, lng: 0 }, { lat: 10, lng: 10 }],
    });
    expect(dto.id).toBeDefined();
  });

  it('accepts lat: -90 (inclusive boundary)', async () => {
    const repo = new InMemoryZoneRepository();
    const uc = new CreateZone(repo);
    const dto = await uc.execute({
      name: 'Norte',
      color: '#22c55e',
      points: [{ lat: -90, lng: 0 }, { lat: 0, lng: 0 }, { lat: 10, lng: 10 }],
    });
    expect(dto.id).toBeDefined();
  });

  it('accepts lng: 180 (inclusive boundary)', async () => {
    const repo = new InMemoryZoneRepository();
    const uc = new CreateZone(repo);
    const dto = await uc.execute({
      name: 'Norte',
      color: '#22c55e',
      points: [{ lat: 0, lng: 180 }, { lat: 0, lng: 0 }, { lat: 10, lng: 10 }],
    });
    expect(dto.id).toBeDefined();
  });

  it('accepts lng: -180 (inclusive boundary)', async () => {
    const repo = new InMemoryZoneRepository();
    const uc = new CreateZone(repo);
    const dto = await uc.execute({
      name: 'Norte',
      color: '#22c55e',
      points: [{ lat: 0, lng: -180 }, { lat: 0, lng: 0 }, { lat: 10, lng: 10 }],
    });
    expect(dto.id).toBeDefined();
  });

  it('rejects lat: 90.0001 (just outside boundary)', async () => {
    const repo = new InMemoryZoneRepository();
    const uc = new CreateZone(repo);
    await expect(
      uc.execute({
        name: 'Norte',
        color: '#22c55e',
        points: [{ lat: 90.0001, lng: 0 }, { lat: 0, lng: 0 }, { lat: 10, lng: 10 }],
      }),
    ).rejects.toThrow(InvalidPolygonError);
  });

  it('rejects lng: 180.1 (just outside boundary)', async () => {
    const repo = new InMemoryZoneRepository();
    const uc = new CreateZone(repo);
    await expect(
      uc.execute({
        name: 'Norte',
        color: '#22c55e',
        points: [{ lat: 0, lng: 180.1 }, { lat: 0, lng: 0 }, { lat: 10, lng: 10 }],
      }),
    ).rejects.toThrow(InvalidPolygonError);
  });

  // W2 — color boundary tests
  it('accepts #FFF (uppercase 3-hex)', async () => {
    const repo = new InMemoryZoneRepository();
    const uc = new CreateZone(repo);
    const dto = await uc.execute({ name: 'Norte', color: '#FFF', points: validPoints });
    expect(dto.color).toBe('#FFF');
  });

  it('accepts #abcdef (lowercase 6-hex)', async () => {
    const repo = new InMemoryZoneRepository();
    const uc = new CreateZone(repo);
    const dto = await uc.execute({ name: 'Norte', color: '#abcdef', points: validPoints });
    expect(dto.color).toBe('#abcdef');
  });

  it('rejects #abcd (4-hex — invalid length)', async () => {
    const repo = new InMemoryZoneRepository();
    const uc = new CreateZone(repo);
    await expect(
      uc.execute({ name: 'Norte', color: '#abcd', points: validPoints }),
    ).rejects.toThrow(InvalidPolygonError);
  });

  it('rejects #ab (2-hex — invalid length)', async () => {
    const repo = new InMemoryZoneRepository();
    const uc = new CreateZone(repo);
    await expect(
      uc.execute({ name: 'Norte', color: '#ab', points: validPoints }),
    ).rejects.toThrow(InvalidPolygonError);
  });

  it('rejects abc (no # prefix)', async () => {
    const repo = new InMemoryZoneRepository();
    const uc = new CreateZone(repo);
    await expect(
      uc.execute({ name: 'Norte', color: 'abc', points: validPoints }),
    ).rejects.toThrow(InvalidPolygonError);
  });
});

import { ZoneRepository, CreateZoneInput } from '@domain/ports/ZoneRepository';
import { ZonePoint } from '@domain/entities/zone';
import { ZoneDto, toZoneDto } from '@application/dto/zone.dto';
import { InvalidPolygonError } from '@domain/errors/zone';

export type { CreateZoneInput };

const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function validatePolygon(name: string, color: string, points: ZonePoint[]): void {
  if (!name.trim()) throw new InvalidPolygonError('Zone name must not be empty');
  if (!HEX_COLOR_RE.test(color)) throw new InvalidPolygonError(`Invalid hex color: ${color}`);
  if (points.length < 3) throw new InvalidPolygonError('A polygon requires at least 3 points');
  for (const pt of points) {
    if (!Number.isFinite(pt.lat) || !Number.isFinite(pt.lng))
      throw new InvalidPolygonError(`Coordinates must be finite numbers, got lat=${pt.lat} lng=${pt.lng}`);
    if (pt.lat < -90 || pt.lat > 90)
      throw new InvalidPolygonError(`Latitude ${pt.lat} is out of range [-90, 90]`);
    if (pt.lng < -180 || pt.lng > 180)
      throw new InvalidPolygonError(`Longitude ${pt.lng} is out of range [-180, 180]`);
  }
}

export class CreateZone {
  constructor(private readonly repo: ZoneRepository) {}

  async execute(input: CreateZoneInput): Promise<ZoneDto> {
    validatePolygon(input.name, input.color, input.points);
    const zone = await this.repo.create({
      name: input.name.trim(),
      color: input.color,
      points: input.points,
      description: input.description ?? null,
    });
    return toZoneDto(zone);
  }
}

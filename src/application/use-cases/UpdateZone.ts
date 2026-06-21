import { ZoneRepository } from '@domain/ports/ZoneRepository';
import { ZonePoint } from '@domain/entities/zone';
import { ZoneDto, toZoneDto } from '@application/dto/zone.dto';
import { ZoneNotFoundError } from '@domain/errors/zone';
import { validatePolygon } from './CreateZone';

/** Use-case-level command: includes id (the locator) + optional patch fields. */
export interface UpdateZoneInput {
  id: string;
  name?: string;
  color?: string;
  points?: ZonePoint[];
  description?: string | null;
}

export class UpdateZone {
  constructor(private readonly repo: ZoneRepository) {}

  async execute(input: UpdateZoneInput): Promise<ZoneDto> {
    const existing = await this.repo.findById(input.id);
    if (!existing) throw new ZoneNotFoundError(input.id);

    // Resolve the effective values to validate (merge with existing)
    const name   = input.name   !== undefined ? input.name   : existing.name;
    const color  = input.color  !== undefined ? input.color  : existing.color;
    const points = input.points !== undefined ? input.points : existing.points;

    validatePolygon(name, color, points);

    const updated = await this.repo.update(input.id, {
      name: input.name !== undefined ? input.name.trim() : undefined,
      color: input.color,
      points: input.points,
      description: input.description,
    });

    if (!updated) throw new ZoneNotFoundError(input.id);
    return toZoneDto(updated);
  }
}

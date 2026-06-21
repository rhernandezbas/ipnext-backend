import { ZoneRepository } from '@domain/ports/ZoneRepository';
import { ZoneDto, toZoneDto } from '@application/dto/zone.dto';
import { ZoneNotFoundError } from '@domain/errors/zone';

export class GetZone {
  constructor(private readonly repo: ZoneRepository) {}

  async execute(id: string): Promise<ZoneDto> {
    const zone = await this.repo.findById(id);
    if (!zone) throw new ZoneNotFoundError(id);
    return toZoneDto(zone);
  }
}

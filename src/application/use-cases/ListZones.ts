import { ZoneRepository } from '@domain/ports/ZoneRepository';
import { ZoneDto, toZoneDto } from '@application/dto/zone.dto';

export class ListZones {
  constructor(private readonly repo: ZoneRepository) {}

  async execute(): Promise<ZoneDto[]> {
    const zones = await this.repo.list();
    return zones.map(toZoneDto);
  }
}

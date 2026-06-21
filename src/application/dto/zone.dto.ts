import { Zone } from '@domain/entities/zone';

/**
 * ZoneDto — the exact wire shape returned from every zone endpoint.
 * No Prisma types leak through this DTO.
 * Contract shared with ipnext-frontend: DO NOT change field names without coordinating FE.
 */
export interface ZoneDto {
  id: string;
  name: string;
  color: string;
  points: { lat: number; lng: number }[];
  description: string | null;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

/** Maps a domain Zone entity to the ZoneDto wire shape. */
export function toZoneDto(zone: Zone): ZoneDto {
  return {
    id: zone.id,
    name: zone.name,
    color: zone.color,
    points: zone.points.map(p => ({ lat: p.lat, lng: p.lng })),
    description: zone.description,
    createdAt: zone.createdAt,
    updatedAt: zone.updatedAt,
  };
}

/**
 * Zone domain entity — visual polygon for the customer map.
 * Zero external dependencies (pure domain).
 */

export interface ZonePoint {
  lat: number;
  lng: number;
}

export interface Zone {
  id: string;
  name: string;
  color: string;
  points: ZonePoint[];
  description: string | null;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

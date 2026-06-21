import { Zone, ZonePoint } from '../entities/zone';

export interface CreateZoneInput {
  name: string;
  color: string;
  points: ZonePoint[];
  description?: string | null;
}

export interface UpdateZoneInput {
  name?: string;
  color?: string;
  points?: ZonePoint[];
  description?: string | null;
}

export interface ZoneRepository {
  create(input: CreateZoneInput): Promise<Zone>;
  findById(id: string): Promise<Zone | null>;
  list(): Promise<Zone[]>;
  update(id: string, input: UpdateZoneInput): Promise<Zone | null>;
  delete(id: string): Promise<void>;
}

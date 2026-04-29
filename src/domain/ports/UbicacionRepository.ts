import { Ubicacion } from '@domain/entities/ubicacion';

export interface UbicacionRepository {
  findAll(): Promise<Ubicacion[]>;
  findById(id: string): Promise<Ubicacion | null>;
  create(data: Omit<Ubicacion, 'id'>): Promise<Ubicacion>;
  update(id: string, data: Partial<Ubicacion>): Promise<Ubicacion | null>;
  delete(id: string): Promise<boolean>;
}

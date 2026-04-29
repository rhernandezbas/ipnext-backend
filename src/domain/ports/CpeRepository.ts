import { CpeDevice } from '../entities/cpe';

export interface CpeRepository {
  findAll(): Promise<CpeDevice[]>;
  findById(id: string): Promise<CpeDevice | null>;
  create(data: Omit<CpeDevice, 'id'>): Promise<CpeDevice>;
  update(id: string, data: Partial<CpeDevice>): Promise<CpeDevice | null>;
  delete(id: string): Promise<boolean>;
  assignToClient(id: string, clientId: string, clientName: string): Promise<CpeDevice | null>;
}

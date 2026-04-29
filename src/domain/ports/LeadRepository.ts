import { Lead } from '@domain/entities/lead';

export interface LeadRepository {
  findAll(): Promise<Lead[]>;
  findById(id: string): Promise<Lead | null>;
  create(data: Omit<Lead, 'id' | 'createdAt' | 'convertedAt' | 'convertedClientId'>): Promise<Lead>;
  update(id: string, data: Partial<Lead>): Promise<Lead | null>;
  delete(id: string): Promise<boolean>;
  convertToClient(id: string, clientId: string): Promise<Lead | null>;
}

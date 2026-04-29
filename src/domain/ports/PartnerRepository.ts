import { Partner } from '../entities/partner';

export interface PartnerRepository {
  findAll(): Promise<Partner[]>;
  findById(id: string): Promise<Partner | null>;
  create(data: Omit<Partner, 'id' | 'createdAt' | 'clientCount' | 'adminCount'>): Promise<Partner>;
  update(id: string, data: Partial<Partner>): Promise<Partner | null>;
  delete(id: string): Promise<boolean>;
}

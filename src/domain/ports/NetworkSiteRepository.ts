import { NetworkSite } from '../entities/networkSite';

export interface NetworkSiteRepository {
  findAll(): Promise<NetworkSite[]>;
  findById(id: string): Promise<NetworkSite | null>;
  create(data: Omit<NetworkSite, 'id'>): Promise<NetworkSite>;
  update(id: string, data: Partial<NetworkSite>): Promise<NetworkSite | null>;
  delete(id: string): Promise<boolean>;
}

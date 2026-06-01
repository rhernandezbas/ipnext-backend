import { ServiceTechnology } from '../entities/serviceTechnology';

export interface ServiceTechnologyRepository {
  list(): Promise<ServiceTechnology[]>;
  getById(id: string): Promise<ServiceTechnology | null>;
  getByName(name: string): Promise<ServiceTechnology | null>;
  create(data: { name: string; description: string | null }): Promise<ServiceTechnology>;
  update(id: string, data: Partial<{ name: string; description: string | null }>): Promise<ServiceTechnology | null>;
  delete(id: string): Promise<boolean>;
  countServicesUsingTechnology(name: string): Promise<number>;
}

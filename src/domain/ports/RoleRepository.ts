import { AdminRole_Definition } from '../entities/role';

export interface RoleRepository {
  findAll(): Promise<AdminRole_Definition[]>;
  findById(id: string): Promise<AdminRole_Definition | null>;
  create(data: Omit<AdminRole_Definition, 'id'>): Promise<AdminRole_Definition>;
  update(id: string, data: Partial<AdminRole_Definition>): Promise<AdminRole_Definition | null>;
  delete(id: string): Promise<boolean>;
}

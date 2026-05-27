import * as bcrypt from 'bcryptjs';
import { AdminRepository } from '@domain/ports/AdminRepository';
import { Admin } from '@domain/entities/admin';

export interface CreateAdminPayload {
  name: string;
  email: string;
  role: string;
  status: 'active' | 'inactive';
  /** Plain-text password. Required when creating a new admin. */
  password: string;
}

export class CreateAdmin {
  constructor(private readonly repo: AdminRepository) {}

  async execute(data: CreateAdminPayload): Promise<Admin> {
    const passwordHash = await bcrypt.hash(data.password, 10);
    return this.repo.create({
      name: data.name,
      email: data.email,
      role: data.role,
      status: data.status,
      passwordHash,
    });
  }
}

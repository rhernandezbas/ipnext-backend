import { AdminRepository } from '@domain/ports/AdminRepository';
import { Admin2FA } from '@domain/entities/admin';

export class Get2FAStatus {
  constructor(private readonly repo: AdminRepository) {}

  execute(adminId: string): Promise<Admin2FA> {
    return this.repo.get2FAStatus(adminId);
  }
}

import { AdminRepository } from '@domain/ports/AdminRepository';

export class Disable2FA {
  constructor(private readonly repo: AdminRepository) {}

  execute(adminId: string): Promise<boolean> {
    return this.repo.disable2FA(adminId);
  }
}

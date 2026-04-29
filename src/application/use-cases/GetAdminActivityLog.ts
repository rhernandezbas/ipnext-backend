import { AdminRepository } from '@domain/ports/AdminRepository';
import { AdminActivityLog, ActivityCategory } from '@domain/entities/admin';

export class GetAdminActivityLog {
  constructor(private readonly repo: AdminRepository) {}

  execute(category?: ActivityCategory): Promise<AdminActivityLog[]> {
    return this.repo.getActivityLog(category);
  }
}

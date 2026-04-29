import { DashboardRepository } from '@domain/ports/DashboardRepository';
import { DashboardStats } from '@domain/entities/dashboard';

export class GetDashboardStats {
  constructor(private readonly repo: DashboardRepository) {}

  execute(): Promise<DashboardStats> {
    return this.repo.getStats();
  }
}

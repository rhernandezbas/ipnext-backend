import { DashboardRepository } from '@domain/ports/DashboardRepository';
import { RecentActivity } from '@domain/entities/dashboard';

export class GetRecentActivity {
  constructor(private readonly repo: DashboardRepository) {}

  execute(): Promise<RecentActivity[]> {
    return this.repo.getRecentActivity();
  }
}

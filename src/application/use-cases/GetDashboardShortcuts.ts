import { DashboardRepository } from '@domain/ports/DashboardRepository';
import { DashboardShortcut } from '@domain/entities/dashboard';

export class GetDashboardShortcuts {
  constructor(private readonly repo: DashboardRepository) {}

  execute(): Promise<DashboardShortcut[]> {
    return this.repo.getShortcuts();
  }
}

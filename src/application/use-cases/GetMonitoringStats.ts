import { MonitoringRepository } from '@domain/ports/MonitoringRepository';
import { MonitoringStats } from '@domain/entities/monitoring';

export class GetMonitoringStats {
  constructor(private readonly repo: MonitoringRepository) {}

  execute(): Promise<MonitoringStats> {
    return this.repo.getStats();
  }
}

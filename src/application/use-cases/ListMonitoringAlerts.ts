import { MonitoringRepository } from '@domain/ports/MonitoringRepository';
import { MonitoringAlert } from '@domain/entities/monitoring';

export class ListMonitoringAlerts {
  constructor(private readonly repo: MonitoringRepository) {}

  execute(): Promise<MonitoringAlert[]> {
    return this.repo.findAllAlerts();
  }
}

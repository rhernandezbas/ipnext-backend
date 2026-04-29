import { MonitoringRepository } from '@domain/ports/MonitoringRepository';
import { MonitoringDevice } from '@domain/entities/monitoring';

export class ListMonitoringDevices {
  constructor(private readonly repo: MonitoringRepository) {}

  execute(): Promise<MonitoringDevice[]> {
    return this.repo.findAllDevices();
  }
}

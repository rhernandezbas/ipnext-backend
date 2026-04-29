import { MonitoringRepository } from '@domain/ports/MonitoringRepository';
import { MonitoringAlert } from '@domain/entities/monitoring';

export class AcknowledgeAlert {
  constructor(private readonly repo: MonitoringRepository) {}

  execute(id: string): Promise<MonitoringAlert | null> {
    return this.repo.acknowledgeAlert(id);
  }
}

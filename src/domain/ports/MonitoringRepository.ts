import { MonitoringDevice, MonitoringAlert, MonitoringStats } from '@domain/entities/monitoring';

export interface MonitoringRepository {
  getStats(): Promise<MonitoringStats>;
  findAllDevices(): Promise<MonitoringDevice[]>;
  findAllAlerts(): Promise<MonitoringAlert[]>;
  acknowledgeAlert(id: string): Promise<MonitoringAlert | null>;
}

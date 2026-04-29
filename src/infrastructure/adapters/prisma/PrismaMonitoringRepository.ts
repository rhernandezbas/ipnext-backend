import { MonitoringDevice, MonitoringAlert, MonitoringStats } from '@domain/entities/monitoring';
import { MonitoringRepository } from '@domain/ports/MonitoringRepository';
import { prisma } from '../../database/prisma';

// Coordinates are not stored in DB — use a fixed default for Buenos Aires area
const DEFAULT_COORDS = { lat: -34.603, lng: -58.381 };

function toMonitoringDevice(row: {
  id: string;
  name: string;
  ipAddress: string | null;
  type: string;
  status: string;
  lastSeen: Date | null;
  uptimePercent: number | null;
  location: string | null;
  createdAt: Date;
}): MonitoringDevice {
  return {
    id: row.id,
    name: row.name,
    type: row.type as MonitoringDevice['type'],
    ipAddress: row.ipAddress ?? '',
    status: row.status as MonitoringDevice['status'],
    coordinates: DEFAULT_COORDS,
    nasId: null,
    clientId: null,
    clientName: null,
    lastSeen: row.lastSeen ? row.lastSeen.toISOString() : null,
    uptimePercent: row.uptimePercent ?? 0,
    latency: null,
    downloadMbps: null,
    uploadMbps: null,
    alertCount: 0,
  };
}

function toMonitoringAlert(row: {
  id: string;
  deviceId: string | null;
  type: string;
  severity: string;
  message: string;
  acknowledged: boolean;
  acknowledgedAt: Date | null;
  acknowledgedBy: string | null;
  createdAt: Date;
}): MonitoringAlert {
  return {
    id: row.id,
    deviceId: row.deviceId ?? '',
    deviceName: '',
    type: row.type as MonitoringAlert['type'],
    severity: row.severity as MonitoringAlert['severity'],
    message: row.message,
    occurredAt: row.createdAt.toISOString(),
    resolvedAt: null,
    acknowledged: row.acknowledged,
  };
}

export class PrismaMonitoringRepository implements MonitoringRepository {
  async getStats(): Promise<MonitoringStats> {
    const devices = await prisma.monitoringDevice.findMany();
    const alerts = await prisma.monitoringAlert.findMany();

    const online = devices.filter(d => d.status === 'online').length;
    const offline = devices.filter(d => d.status === 'offline').length;
    const warning = devices.filter(d => d.status === 'warning').length;
    const activeAlerts = alerts.filter(a => !a.acknowledged).length;
    const criticalAlerts = alerts.filter(a => a.severity === 'critical' && !a.acknowledged).length;

    const avgUptimePercent =
      devices.length > 0
        ? devices.reduce((sum, d) => sum + (d.uptimePercent ?? 0), 0) / devices.length
        : 0;

    return {
      totalDevices: devices.length,
      onlineDevices: online,
      offlineDevices: offline,
      warningDevices: warning,
      activeAlerts,
      criticalAlerts,
      avgLatency: 0,
      avgUptimePercent: Math.round(avgUptimePercent * 10) / 10,
    };
  }

  async findAllDevices(): Promise<MonitoringDevice[]> {
    const rows = await prisma.monitoringDevice.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map(toMonitoringDevice);
  }

  async findAllAlerts(): Promise<MonitoringAlert[]> {
    const rows = await prisma.monitoringAlert.findMany({ orderBy: { createdAt: 'desc' } });
    return rows.map(toMonitoringAlert);
  }

  async acknowledgeAlert(id: string): Promise<MonitoringAlert | null> {
    try {
      const row = await prisma.monitoringAlert.update({
        where: { id },
        data: {
          acknowledged: true,
          acknowledgedAt: new Date(),
        },
      });
      return toMonitoringAlert(row);
    } catch {
      return null;
    }
  }
}

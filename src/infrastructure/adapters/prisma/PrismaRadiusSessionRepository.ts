import { RadiusSession } from '@domain/entities/radiusSessions';
import { RadiusSessionRepository } from '@domain/ports/RadiusSessionRepository';
import { prisma } from '../../database/prisma';

function toSession(row: any): RadiusSession {
  return {
    id: row.id,
    sessionId: row.sessionId,
    clientId: row.clientId,
    clientName: row.clientName,
    nasId: row.nasId ?? null,
    nasName: row.nasName ?? null,
    ipAddress: row.ipAddress ?? null,
    macAddress: row.macAddress ?? null,
    startedAt: row.startedAt instanceof Date ? row.startedAt.toISOString() : row.startedAt,
    duration: row.duration,
    // BigInt → number conversion
    downloadBytes: typeof row.downloadBytes === 'bigint'
      ? Number(row.downloadBytes)
      : row.downloadBytes,
    uploadBytes: typeof row.uploadBytes === 'bigint'
      ? Number(row.uploadBytes)
      : row.uploadBytes,
    downloadMbps: row.downloadMbps,
    uploadMbps: row.uploadMbps,
    status: row.status,
    username: row.username ?? null,
  };
}

export class InMemoryRadiusSessionRepository implements RadiusSessionRepository {
  async listSessions(): Promise<RadiusSession[]> {
    const rows = await prisma.radiusSession.findMany({ orderBy: { startedAt: 'desc' } });
    return rows.map(toSession);
  }

  async disconnectSession(id: string): Promise<{ success: boolean }> {
    try {
      await prisma.radiusSession.delete({ where: { id } });
      return { success: true };
    } catch {
      return { success: false };
    }
  }
}

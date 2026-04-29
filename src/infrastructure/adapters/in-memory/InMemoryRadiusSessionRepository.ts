import { RadiusSession } from '@domain/entities/radiusSessions';
import { RadiusSessionRepository } from '@domain/ports/RadiusSessionRepository';

function makeSessions(): RadiusSession[] {
  const nas = [
    { id: 'nas-1', name: 'NAS Central' },
    { id: 'nas-2', name: 'NAS Norte' },
    { id: 'nas-3', name: 'NAS Sur' },
  ];

  const sessions: RadiusSession[] = [];
  const now = new Date('2026-04-28T07:00:00Z');

  for (let i = 1; i <= 15; i++) {
    const nasEntry = nas[(i - 1) % nas.length];
    const startOffset = Math.floor(Math.random() * 3600 * 8);
    const startedAt = new Date(now.getTime() - startOffset * 1000).toISOString();
    const isIdle = i > 12;

    sessions.push({
      id: `session-${i}`,
      sessionId: `ACCT${String(i).padStart(10, '0')}`,
      clientId: `client-${i}`,
      clientName: `Cliente ${i}`,
      nasId: nasEntry.id,
      nasName: nasEntry.name,
      ipAddress: `10.${Math.floor(i / 256)}.${i % 256}.${100 + i}`,
      macAddress: `AA:BB:CC:DD:${String(i).padStart(2, '0').toUpperCase()}:FF`,
      startedAt,
      duration: startOffset,
      downloadBytes: Math.floor(Math.random() * 1073741824),
      uploadBytes: Math.floor(Math.random() * 107374182),
      downloadMbps: isIdle ? 0 : Math.random() * 50,
      uploadMbps: isIdle ? 0 : Math.random() * 10,
      status: isIdle ? 'idle' : 'active',
      username: `user${i}@ipnext.com.ar`,
    });
  }

  return sessions;
}

export class InMemoryRadiusSessionRepository implements RadiusSessionRepository {
  private sessions: RadiusSession[] = makeSessions();

  async listSessions(): Promise<RadiusSession[]> {
    return [...this.sessions];
  }

  async disconnectSession(id: string): Promise<{ success: boolean }> {
    const index = this.sessions.findIndex(s => s.id === id);
    if (index === -1) return { success: false };
    this.sessions.splice(index, 1);
    return { success: true };
  }
}

import { RadiusSession } from '../entities/radiusSessions';

export interface RadiusSessionRepository {
  listSessions(): Promise<RadiusSession[]>;
  disconnectSession(id: string): Promise<{ success: boolean }>;
}

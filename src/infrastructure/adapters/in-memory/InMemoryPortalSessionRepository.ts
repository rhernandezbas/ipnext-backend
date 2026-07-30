import { randomUUID } from 'crypto';
import type { PortalSession } from '@domain/entities/portalSession';
import type {
  PortalSessionRepository,
  CreatePortalSessionInput,
} from '@domain/ports/PortalSessionRepository';

/** InMemoryPortalSessionRepository — test seam (Fase 1, task 1.3). */
export class InMemoryPortalSessionRepository implements PortalSessionRepository {
  private readonly store: PortalSession[] = [];

  async create(input: CreatePortalSessionInput): Promise<PortalSession> {
    const now = new Date().toISOString();
    const session: PortalSession = {
      id: randomUUID(),
      accountId: input.accountId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt.toISOString(),
      revokedAt: null,
      rotatedAt: null,
      createdAt: now,
    };
    this.store.push(session);
    return { ...session };
  }

  async findByTokenHash(tokenHash: string): Promise<PortalSession | null> {
    const row = this.store.find((s) => s.tokenHash === tokenHash);
    return row ? { ...row } : null;
  }

  async markRotated(id: string): Promise<void> {
    const row = this.store.find((s) => s.id === id);
    if (row && row.rotatedAt === null) row.rotatedAt = new Date().toISOString();
  }

  async revoke(id: string): Promise<void> {
    const row = this.store.find((s) => s.id === id);
    if (row && row.revokedAt === null) row.revokedAt = new Date().toISOString();
  }

  async revokeAllForAccount(accountId: string): Promise<number> {
    let count = 0;
    const now = new Date().toISOString();
    for (const row of this.store) {
      if (row.accountId === accountId && row.revokedAt === null) {
        row.revokedAt = now;
        count++;
      }
    }
    return count;
  }
}

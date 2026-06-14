import { randomUUID } from 'crypto';
import { IClassTeam } from '@domain/entities/iclass-team';
import { IClassTeamRepository, UpsertTeamInput } from '@domain/ports/IClassTeamRepository';

/**
 * In-memory implementation of IClassTeamRepository.
 * Backing store: Map<id, IClassTeam> + secondary index Map<login, id>.
 * Mirrors InMemoryIClassNodeRepository, keyed by `login` instead of `nodeId`.
 */
export class InMemoryIClassTeamRepository implements IClassTeamRepository {
  private readonly byId: Map<string, IClassTeam> = new Map();
  /** Secondary index: login → id */
  private readonly loginIndex: Map<string, string> = new Map();

  async list(filter?: { active?: boolean; selectable?: boolean }): Promise<IClassTeam[]> {
    let all = Array.from(this.byId.values());
    if (filter?.active !== undefined) all = all.filter(e => e.active === filter.active);
    if (filter?.selectable !== undefined) all = all.filter(e => e.selectable === filter.selectable);
    return all.map(e => ({ ...e }));
  }

  async getByLogin(login: string): Promise<IClassTeam | null> {
    const id = this.loginIndex.get(login);
    if (!id) return null;
    const entry = this.byId.get(id);
    return entry ? { ...entry } : null;
  }

  async upsertByLogin(team: UpsertTeamInput): Promise<{ status: 'created' | 'updated' | 'reactivated' }> {
    const now = new Date();
    const existingId = this.loginIndex.get(team.login);

    if (existingId) {
      const existing = this.byId.get(existingId)!;
      const wasInactive = !existing.active;
      const updated: IClassTeam = {
        ...existing,
        name: team.name,
        thirdPartyCode: team.thirdPartyCode,
        active: team.active,
        selectable: team.selectable,
        lastSyncedAt: now,
        updatedAt: now,
      };
      this.byId.set(existingId, updated);
      return { status: wasInactive ? 'reactivated' : 'updated' };
    }

    const id = randomUUID();
    const newEntry: IClassTeam = {
      id,
      login: team.login,
      name: team.name,
      thirdPartyCode: team.thirdPartyCode,
      active: team.active,
      selectable: team.selectable,
      lastSyncedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    this.byId.set(id, newEntry);
    this.loginIndex.set(team.login, id);
    return { status: 'created' };
  }

  async markInactiveExcept(presentLogins: string[]): Promise<number> {
    const presentSet = new Set(presentLogins);
    let count = 0;
    for (const entry of this.byId.values()) {
      if (entry.active && !presentSet.has(entry.login)) {
        this.byId.set(entry.id, { ...entry, active: false, updatedAt: new Date() });
        count++;
      }
    }
    return count;
  }
}

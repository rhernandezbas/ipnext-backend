import { SyncStateRepository, SyncState } from '@domain/ports/SyncStateRepository';

export class InMemorySyncStateRepository implements SyncStateRepository {
  states = new Map<string, SyncState>();

  async get(entity: string): Promise<SyncState | null> {
    return this.states.get(entity) ?? null;
  }

  async save(state: SyncState): Promise<void> {
    this.states.set(state.entity, { ...state });
  }
}
